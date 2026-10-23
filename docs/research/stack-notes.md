# Stack notes (verified 2026-10-23 against official docs unless marked UNVERIFIED)

## 1. Next.js 16.x
Sources: https://nextjs.org/docs/app/api-reference/cli/create-next-app (lastUpdated 2026-09-29), https://nextjs.org/docs/app/guides/upgrading/version-16

Scaffold (non-interactive; flags all documented):
  bunx create-next-app@latest <name> --ts --tailwind --eslint --app --no-src-dir --import-alias "@/*" --use-bun --yes
Notes:
- `--yes` uses previous prefs or defaults; explicit flags win. Defaults now include Cache Components ON for App Router (`--cache-components`, default), AGENTS.md (`--agents-md`), agent feedback (`--agent-feedback`). To opt out: `--no-cache-components --no-agents-md --no-agent-feedback` (negation via `--no-*` is documented; per-flag negations for these three UNVERIFIED by running). React Compiler off by default (`--react-compiler` to enable). Add `--disable-git` / `--skip-install` if wanted.
- `--no-src-dir` not listed explicitly but "--no-*" negates defaults; default is no src/.
Changes since 15:
- Turbopack default for dev AND build; scripts are plain `next dev` / `next build`. Custom `webpack` config makes `next build` fail (use `--webpack` to opt out). `turbopack` config is top-level (not experimental). FS cache on by default.
- `next lint` REMOVED; `next build` no longer lints. Run `eslint` CLI directly (`"lint": "eslint"`). `eslint` key in next.config removed. `@next/eslint-plugin-next` defaults to flat config (`eslint.config.mjs`); eslint-config-next@16 needs ESLint 9+, 16.4.0+ supports ESLint 10.
- `middleware.ts` -> `proxy.ts`, export `function proxy(request)`; nodejs runtime only (edge not supported in proxy; keep `middleware` for edge). Config flags renamed (skipProxyUrlNormalize).
- Async request APIs fully enforced: `await cookies()`, `await headers()`, `await draftMode()`, `await props.params`, `await props.searchParams`. Run `npx next typegen` to get global `PageProps<'/route'>`, `LayoutProps`, `RouteContext` helpers:
    export default async function Page(props: PageProps<'/blog/[slug]'>) { const { slug } = await props.params }
- React 19.2 (View Transitions, useEffectEvent, Activity). Min Node 20.9, TS 5.1, browsers Chrome/Edge/FF 111+, Safari 16.4+.
- Cache Components: `cacheComponents: true` in next.config (replaces experimental.ppr/dynamicIO/useCache). Can surface build errors for uncached data outside <Suspense>; since scaffold default is ON, uncached/runtime data must be inside Suspense or use "use cache". Skills available locally: next-cache-components-adoption.
- Caching APIs: `revalidateTag(tag, 'max')` needs 2nd arg; `updateTag()` (Server Actions, read-your-writes); `refresh()`; `cacheLife`/`cacheTag` stable (no unstable_ prefix).
- next/image defaults: minimumCacheTTL 4h, qualities [75] only, no 16 in imageSizes, local IP blocked, maxRedirects 3, `images.domains` deprecated -> remotePatterns.
- Parallel route slots require `default.tsx`. `next dev` outputs to `.next/dev` (concurrent dev+build ok). Removed: AMP, serverRuntimeConfig/publicRuntimeConfig (use env), `size`/First Load JS in build output. Smooth scroll: add `data-scroll-behavior="smooth"` on <html> to restore override.

## 2. shadcn 4.x
Sources: https://ui.shadcn.com/docs/cli(.md), https://ui.shadcn.com/docs/installation/next(.md), https://ui.shadcn.com/docs/forms/react-hook-form, https://ui.shadcn.com/docs/components-json(.md)

Init in an existing Next app (bun):
  bunx --bun shadcn@latest init --yes --defaults        # = --template=next --preset=nova
  or explicit: bunx --bun shadcn@latest init -y -t next -b radix -p nova
  (`bunx --bun` form UNVERIFIED; docs show pnpm/npx variants; plain `bunx shadcn@latest ...` equals npx form.)
init options (verified): -t/--template (next|vite|start|react-router|laravel|astro), -b/--base (base|radix|aria), -p/--preset [name|code], -y/--yes, -d/--defaults, -f/--force, -c/--cwd, -n/--name (creates new project), -s/--silent, --css-variables/--no-css-variables, --monorepo/--no-monorepo, --rtl/--no-rtl, --pointer/--no-pointer, --reinstall/--no-reinstall. `create` is an alias of `init`.
- Base choice: `--base base|radix|aria` (Base UI = "base"). Default base when --defaults: not stated in docs (UNVERIFIED; check components.json after init). Presets are codes built at https://ui.shadcn.com/create (style, colors, fonts, icons); `npx shadcn@latest apply <code> [--only theme|font]` applies to existing project; `preset decode|resolve|url|open`.
- `--defaults` preset is `nova`. Other style names (vega, maia, etc.) not confirmed in docs - UNVERIFIED. components.json `style` "new-york" ("default" deprecated; cannot change after init); `tailwind.baseColor` options: neutral | stone | zinc | mauve | olive | mist | taupe. No base-color flag on init; set via preset or `migrate base-color`.
- Add components: `bunx shadcn@latest add button card input -y` (flags -y, -o overwrite, -a all, -p path, --dry-run, --diff, --view). Also `view`, `search`/`list`, `build`. Components land in components/ui (per components.json aliases).
Forms: the docs now recommend `Field` components (Field, FieldGroup, FieldLabel, FieldDescription, FieldError from components/ui/field) with react-hook-form `Controller` + zodResolver; docs form index lists React Hook Form, TanStack Form, Formisch (useActionState "coming soon"). The old `form` component page (components/form) no longer served as markdown; docs don't call it deprecated explicitly but it isn't in the recommended path. Use `bunx shadcn@latest add field input textarea button`.
Example (verbatim pattern from docs): useForm<z.infer<typeof formSchema>>({ resolver: zodResolver(formSchema), defaultValues }); <form onSubmit={form.handleSubmit(onSubmit)}><FieldGroup><Controller name control render={({field, fieldState}) => <Field data-invalid={fieldState.invalid}><FieldLabel htmlFor=..>..</FieldLabel><Input {...field} id=.. aria-invalid={fieldState.invalid}/>{fieldState.invalid && <FieldError errors={[fieldState.error]}/>}</Field>}/></FieldGroup></form>
Compat: @hookform/resolvers 6.0.0 peerDeps: zod "^3.25.0 || ^4.0.0", react-hook-form "^7.55.0", @standard-schema/spec ^1. Import `{ zodResolver } from "@hookform/resolvers/zod"`, `import { z } from "zod"` (or "zod/v4"). Type inference automatic; to force: useForm<z.input<typeof s>, any, z.output<typeof s>>. shadcn doc example still says zod v3 syntax but the schema shown works in v4. react-hook-form 7.90.0 satisfies peer range. (Sources: npm view + https://github.com/react-hook-form/resolvers README.)

## 3. Convex 1.48 + Next.js App Router
Sources: https://docs.convex.dev/quickstart/nextjs, /functions/http-actions, /production/environment-variables, /database/schemas, /database/reading-data/indexes/; local plugin /Users/jan/.claude/plugins/cache/claude-plugins-official/convex/1.14.0/skills/{quickstart,design,env}/SKILL.md

Install: `bun add convex` then `bunx convex dev` (docs show npm/npx only; bunx is UNVERIFIED but the CLI is a node bin, should work). First run prompts GitHub login, creates project, writes `.env.local` with `CONVEX_DEPLOYMENT` and `NEXT_PUBLIC_CONVEX_URL`, creates convex/, and stays running to sync functions. Plugin note: non-TTY or logged-out => anonymous local deployment automatically; in agent shells with a pty while logged in it errors "Cannot prompt for input" -> set `CONVEX_TEAM=<slug>` (or CONVEX_DEPLOY_KEY); `CONVEX_AGENT_MODE=anonymous` only if `npx convex whoami` fails (it rebinds .env.local). One-shot push: `npx convex dev --once`.
Provider (app/ConvexClientProvider.tsx):
  "use client";
  import { ConvexProvider, ConvexReactClient } from "convex/react";
  import { ReactNode } from "react";
  const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  export function ConvexClientProvider({ children }: { children: ReactNode }) { return <ConvexProvider client={convex}>{children}</ConvexProvider>; }
Wrap `{children}` in app/layout.tsx body. Client usage: `useQuery(api.tasks.get)` with `import { api } from "../convex/_generated/api"` (or `@/convex/_generated/api`).
HTTP actions (convex/http.ts):
  import { httpRouter } from "convex/server"; import { httpAction } from "./_generated/server";
  const http = httpRouter();
  http.route({ path: "/hook", method: "POST", handler: httpAction(async (ctx, request) => { const body = await request.json(); await ctx.runMutation(internal.x.y, {...}); return new Response(null, { status: 200 }); }) });
  export default http;
  Also `pathPrefix` routes. ctx has auth, storage, scheduler, runQuery/runMutation/runAction. No arg validation (parse yourself). Served at `https://<deployment>.convex.site` (note .site, not .cloud which is the client URL). Env inside functions: `CONVEX_CLOUD_URL`, `CONVEX_SITE_URL` are built in.
Env vars: `npx convex env set NAME 'value'`, `npx convex env set --from-file .env.convex`, `env list`, `env get`, `env remove`; per deployment (add `--prod` for prod - UNVERIFIED flag in this fetch). Plugin says: read through generated `env` export (since convex 1.39): `import { env } from "./_generated/server"; env.KEY`, optionally declare in convex/convex.config.ts: `defineApp({ env: { KEY: v.string(), OPT: v.optional(v.string()) } })`; secrets only readable in actions per plugin env skill (docs variant); never commit.
Schema/indexes:
  import { defineSchema, defineTable } from "convex/server"; import { v } from "convex/values";
  export default defineSchema({ users: defineTable({ name: v.string(), tokenIdentifier: v.string() }).index("by_token", ["tokenIdentifier"]) });
  Query: ctx.db.query("users").withIndex("by_token", q => q.eq("tokenIdentifier", t)).unique(). _id/_creationTime automatic; never list _creationTime in an index; index name convention by_<fields>.
Plugin conventions (non-negotiable per plugin):
- Object-form functions: `query({ args: {...}, returns: v.xxx, handler: async (ctx, args) => {...} })`; BOTH args and returns validators on all public functions.
- Imports: query/mutation/action/internal* from "./_generated/server"; api/internal from "./_generated/api"; never from "convex/server" for those.
- No `.filter()` (full scan) - use `.withIndex`; no unbounded `.collect()` on growing tables - `.take(n)` or `.paginate(paginationOptsValidator)`.
- `v.literal` for fixed enums; "use node" files are action-only; external calls only in actions, schedule via ctx.scheduler.runAfter(0, internal.x.y, args).
- All backend code under convex/. Auth via Convex Auth / WorkOS, ctx.auth.getUserIdentity(); enforce auth at function boundary. Use components (@convex-dev/agent, aggregate) over hand-rolled.
- Verify: `npx tsc --noEmit` plus `npx convex dev --once`; `npx convex run` banned for verification by the quickstart skill; use one internalMutation seed.
- Delegate convex/ code to `convex:convex-expert` subagent; review with `convex:convex-reviewer`.
- Errors to know: ReturnsValidationError, ArgumentValidationError.

## 4. Claude Code hooks
Source: https://code.claude.com/docs/en/hooks (markdown via Accept: text/markdown), plus local transcript inspection in ~/.claude/projects.

Common stdin fields (all events): session_id, transcript_path (main session JSONL; written async, may lag), cwd, hook_event_name; also permission_mode ("default"|"plan"|"acceptEdits"|"auto"|"dontAsk"|"bypassPermissions", not on every event), prompt_id (UUID, absent before first prompt), scratchpad_dir (v2.1.257+), effort {level} (tool-context events), agent_id + agent_type (when fired inside a subagent / --agent).
SessionStart: + source ("startup"|"resume"|"clear"|"compact"|"fork"), optional model, agent_type, session_title; on resume/fork also seconds_since_last_response, context_tokens, prompt_cache_likely_expired, estimated_cache_write_usd. Matcher = source. stdout/additionalContext injection supported.
PreToolUse: + tool_name, tool_use_id, tool_input (tool-specific). Output: hookSpecificOutput.permissionDecision allow|deny|ask|defer (+ reason).
PostToolUse: + tool_name, tool_input, tool_response, tool_use_id, duration_ms (optional). Also PostToolUseFailure, PostToolBatch exist.
Subagent tool name: `Agent` (verified in docs AND in local transcript tool_use blocks; `Task` is the old name, not used in docs now - matcher "Agent"). Agent tool_input documented fields: prompt, description, subagent_type, model (optional alias). `run_in_background` not in the docs table (UNVERIFIED; may appear when set). Local transcript sample Agent input keys: description, model, subagent_type, prompt.
Agent PostToolUse tool_response (foreground): status "completed", agentId, content[] (text blocks), resolvedModel, modelsUsed (only if swapped), totalTokens (FINAL request only, not run total), totalDurationMs, totalToolUseCount, usage{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens} (final request only). Background: status "async_launched", agentId, description, prompt, outputFile, resolvedModel (no usage). Docs say use OTel token counters (query_source "subagent") for rollups. On v2.1.271+ in auto mode, subagent reports may go via a `SubagentHandback` tool (tool_input.message).
SubagentStart: + agent_id, agent_type (matcher; built-ins general-purpose/Explore/Plan, custom = frontmatter name, plugin = "plugin:name" -> use ^...$ regex). Cannot block; can return hookSpecificOutput.additionalContext. Example: {"session_id","transcript_path","cwd","hook_event_name":"SubagentStart","agent_id":"agent-abc123","agent_type":"Explore"}.
SubagentStop: + stop_hook_active, agent_id, agent_type, agent_transcript_path (subagent's own JSONL), last_assistant_message, background_tasks[], session_crons[]; transcript_path is the MAIN session transcript. Fires also for internal agents (prompt suggestions, /btw) with agent_type = session agent or "". Block via decision:"block"+reason.
Stop: + stop_hook_active, last_assistant_message, background_tasks[], session_crons[]. 8-consecutive-continuation cap. Doesn't fire on user interrupt (StopFailure on API error). No token usage in the payload -> parse transcript.
Settings structure (.claude/settings.json, committed; .claude/settings.local.json gitignored; ~/.claude/settings.json user):
  { "hooks": { "PreToolUse": [ { "matcher": "Agent", "hooks": [ { "type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/pre-agent.sh", "timeout": 30 } ] } ],
               "SubagentStop": [ { "hooks": [ { "type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/sub-stop.sh", "async": true } ] } ] } }
- Matcher: "*"/""/omitted = all; letters/digits/_/-/space/,/| = exact list (`Edit|Write`); anything else = unanchored JS regex. Event matcher target: tool name for tool events, source for SessionStart, agent type for SubagentStart/Stop. Stop has no matcher.
- Handler fields: type (command|http|mcp_tool|prompt|agent), if (permission-rule syntax, tool events only), timeout (SECONDS; default 600 command/http/mcp_tool, 30 prompt, 60 agent; 30 on UserPromptSubmit; SessionEnd 1.5s budget), statusMessage, once (skill frontmatter only), command, args (exec form, no shell), async, asyncRewake, shell, onFailure ("continue"|"block", v2.1.295+).
- `${CLAUDE_PROJECT_DIR}` placeholder works in command/args; also exported as env var CLAUDE_PROJECT_DIR to the process (project root where session started; stays put in worktrees). Quote "$CLAUDE_PROJECT_DIR" in shell form.
- Exit codes: 0 ok (stdout JSON parsed only if sole content); 2 = blocking (stderr to Claude) per-event; other = non-blocking error. Timed-out PreToolUse hook does NOT block unless onFailure:"block".
- async: true (command hooks only) runs in background; cannot block/decision; timeout not enforced; output additionalContext/systemMessage delivered next turn; killed at teardown in `claude -p`. asyncRewake: background, wakes Claude on exit 2 (stderr as system reminder), timeout enforced. Detached work that must outlive -p session needs a fully detached process; background children must redirect stdout/stderr or the hook errors ("refusing to honor the suspect capture").
Transcript JSONL (verified locally, Claude Code current): ~/.claude/projects/<cwd-with-slashes-as-dashes>/<session_id>.jsonl. Line `type` values seen: user, assistant, system, attachment, queue-operation, ai-title, last-prompt, api-request*, etc. Assistant line keys: parentUuid, isSidechain, message, requestId, requestedModel, effort, perTurnEffort, uuid, timestamp, sessionId, cwd, version, gitBranch, ... message = {model, id (msg_...), role, content[], stop_reason, usage, ...}. Usage at `message.usage`: input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cache_creation{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}, output_tokens_details{thinking_tokens}, server_tool_use{web_search_requests, web_fetch_requests}, service_tier, iterations[]. IMPORTANT: one API message is split across multiple JSONL lines (one per content block; saw up to 6 lines per message.id) each repeating usage -> DEDUPE by message.id (or requestId) before summing, else tokens are overcounted. Model id at message.model (e.g. claude-opus-5-5).
Subagent transcripts: <projects>/<cwd>/<session_id>/subagents/agent-<agentId>.jsonl plus agent-<agentId>.meta.json ({agentType, description, toolUseId, spawnDepth, requestShape, requestNonInteractive, model, finished}); toolUseId links to the parent's Agent tool_use block. Same assistant/usage format. Retained cleanupPeriodDays (30 default). Doc: https://code.claude.com/docs/en/sub-agents.md. Per docs, agent_transcript_path is delivered in SubagentStop so no path guessing needed.
