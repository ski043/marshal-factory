# Hook payloads observed from real T3 threads

Captured 2026-10-23 from three `t3 thread start . --provider claudeAgent --model claude-sonnet-5-5` threads in this project, with the raw stdin of every hook logged. Claude Code 2.1.x. Subagents used: a background `general-purpose` agent (`model: sonnet`), and foreground `Explore` and `general-purpose` agents (`model: haiku`).

## Payloads

Every payload has `session_id`, `transcript_path`, `cwd`, `hook_event_name`. Tool and stop events also have `prompt_id`, `permission_mode` and `effort`.

| Hook | Extra fields seen | Not present |
| --- | --- | --- |
| SessionStart | `source` ("startup") | `model`, `session_title` |
| PreToolUse (Agent) | `tool_name`, `tool_use_id`, `tool_input` {description, prompt, subagent_type, model (alias such as "haiku"), run_in_background} | `agent_id` (only expected when the call comes from inside a subagent; never observed) |
| PostToolUse (Agent) | `tool_use_id`, `tool_response` {status, agentId, agentType, resolvedModel (full id, e.g. claude-haiku-5-5), usage, totalTokens, totalDurationMs, content, ...}, `duration_ms` | |
| SubagentStop | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `stop_hook_active`, `background_tasks`, `session_crons` | `model`, any success or failure flag |
| Stop | `last_assistant_message`, `stop_hook_active`, `background_tasks`, `session_crons` | usage |
| SessionEnd | `reason` ("other" when T3 closed the session) | |

## What this changed in the mapper

- **Order.** A foreground agent fires `PreToolUse`, then `SubagentStop`, then `PostToolUse`. So `agent_stop` reaches ingest before `agent_launched`, which is the only event that links `agentId` to `toolUseId`. Ingest keeps a pending row for the stop and folds it into the real row when the link arrives. A background agent fires `PostToolUse` first, then the main turn's `Stop`, then `SubagentStop` later.
- **Model.** `tool_input.model` is an alias ("haiku"). The resolved id only appears in the subagent transcript (`message.model`) and `tool_response.resolvedModel`. The reporter takes it from the transcript and ingest prefers it over the alias.
- **Session model and title.** SessionStart carries neither, so the run's model comes from the first `turn_stop` transcript and the title only from T3.
- **Transcript lag.** `SubagentStop` and `Stop` fire before the final assistant line is flushed. The first run read an empty subagent transcript and reported zero tokens. The reporter now polls until the file holds usage and stops growing (up to 3 s). This runs in an async hook, so it does not delay the session.
- **Failures.** No hook payload says a subagent failed, so `agent_stop.status` is always `completed`.
- **Subagent tokens are not in the main transcript.** A run's cost is main-transcript usage plus its agents' usage.
- **Nested agents.** `agent_id` on `PreToolUse` was never present because the subagents here did not spawn agents. `parentAgentId` is mapped from it but unverified against a real nested call.

## T3 thread lookup

`t3 thread list --project <cwd> --json` returns the project's threads. Threads started with `t3 thread start` run in the project folder, and `t3 thread show --json` reports `thread.worktreePath: null` for them. The reporter matches a worktree thread by `worktreePath` equal to the session cwd or git toplevel, and otherwise accepts a lone running thread without a worktree. Two concurrent folder-mode threads in one project cannot be told apart, so both stay unlinked.

## `t3-thread://` links

`open "t3-thread://v1/<threadId>"` fails on macOS with `kLSApplicationNotFoundErr`: no app claims the scheme. T3 Code (Nightly 0.1.3) registers only `t3code://` and `t3code-dev://` with the OS. The `t3-thread://v1/<threadId>` form is handled inside T3's own markdown renderer, which turns such links in chat messages into thread links showing the current title (found in the app bundle and in the T3 MCP tool instructions). So the panel's "Open in T3" link is correct for T3 chat but does nothing when clicked in a browser. The only OS-level route found is `t3code://app`, with no thread parameter. A working jump from the panel needs T3 to expose a thread deep link, or the panel to call `t3 app`.
