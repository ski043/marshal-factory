import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { FactoryEvent, Usage } from "../lib/events";

const run = promisify(execFile);

// T3 exports its CLI path to the sessions it starts.
const T3 = process.env.T3CODE_CLI_PATH ?? "t3";
const FETCH_TIMEOUT_MS = 4000;
const SUBPROCESS_TIMEOUT_MS = 3000;
const LAST_MESSAGE_MAX = 500;

type HookInput = Record<string, unknown> & {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  agent_transcript_path?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  agent_id?: string;
  agent_type?: string;
};

const str = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;

function readConfig() {
  const file = join(homedir(), ".config", "marshal-factory", "config.json");
  if (!existsSync(file)) return undefined;
  const config = JSON.parse(readFileSync(file, "utf8")) as {
    ingestUrl?: string;
    secret?: string;
  };
  return config.ingestUrl && config.secret
    ? { ingestUrl: config.ingestUrl, secret: config.secret }
    : undefined;
}

type Line = {
  requestId?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
};

const SETTLE_POLL_MS = 250;
const SETTLE_TRIES = 12;

/**
 * Stop hooks fire before Claude Code has flushed the final assistant lines, so wait
 * until the transcript holds usage and has stopped growing.
 */
async function readSettled(path: string | undefined) {
  if (!path) return "";
  let previous = -1;
  let text = "";
  for (let attempt = 0; attempt < SETTLE_TRIES; attempt++) {
    text = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (text.includes('"usage"') && text.length === previous) break;
    previous = text.length;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
  return text;
}

/** One API message spans several JSONL lines that repeat its usage, so count each message id once. */
async function sumTranscriptUsage(path: string | undefined): Promise<Usage> {
  const total: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: "unknown" };
  const transcript = await readSettled(path);

  const messages = new Map<string, NonNullable<Line["message"]>>();
  for (const raw of transcript.split("\n")) {
    if (!raw.includes('"usage"')) continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    const message = line.message;
    if (!message?.usage) continue;
    // Later lines of the same message carry the final output count.
    messages.set(message.id ?? line.requestId ?? raw, message);
  }

  for (const { usage, model } of messages.values()) {
    total.input += usage?.input_tokens ?? 0;
    total.output += usage?.output_tokens ?? 0;
    total.cacheRead += usage?.cache_read_input_tokens ?? 0;
    total.cacheWrite += usage?.cache_creation_input_tokens ?? 0;
    if (model && model !== "<synthetic>") total.model = model;
  }
  return total;
}

async function sh(command: string, args: string[]) {
  const { stdout } = await run(command, args, { timeout: SUBPROCESS_TIMEOUT_MS });
  return stdout.trim();
}

async function gitContext(cwd: string) {
  const [branch, toplevel] = await Promise.all([
    sh("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]).catch(() => undefined),
    sh("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).catch(() => undefined),
  ]);
  return { branch, toplevel, repo: toplevel ? basename(toplevel) : undefined };
}

type T3Thread = { threadId: string; title?: string; status?: string };

/** The running thread whose worktree is this session's directory; omitted when T3 can't say. */
async function findT3Thread(cwd: string, toplevel: string | undefined) {
  try {
    const list = JSON.parse(
      await sh(T3, ["thread", "list", "--project", cwd, "--json"]),
    ) as T3Thread[];
    const running = list.filter((thread) => thread.status === "running");
    const shown = await Promise.all(
      running.map(async (thread) => {
        try {
          const detail = JSON.parse(
            await sh(T3, ["thread", "show", thread.threadId, "--json"]),
          ) as { thread?: { worktreePath?: string | null } };
          return { thread, worktreePath: detail.thread?.worktreePath ?? undefined };
        } catch {
          return undefined;
        }
      }),
    );
    const withTree = shown.find(
      (entry) =>
        entry?.worktreePath !== undefined &&
        (entry.worktreePath === cwd || entry.worktreePath === toplevel),
    );
    // Threads that run in the project folder have no worktree; only an unambiguous one counts.
    const local = shown.filter((entry) => entry && entry.worktreePath === undefined);
    const match = withTree ?? (local.length === 1 ? local[0] : undefined);
    return match && { id: match.thread.threadId, title: match.thread.title };
  } catch {
    return undefined;
  }
}

const SOURCES = new Set(["startup", "resume", "compact"]);

async function toEvent(
  input: HookInput,
  base: { eventId: string; sessionId: string; at: number },
): Promise<FactoryEvent | undefined> {
  switch (input.hook_event_name) {
    case "SessionStart": {
      const cwd = str(input.cwd) ?? process.cwd();
      const git = await gitContext(cwd);
      const t3 = await findT3Thread(cwd, git.toplevel);
      const source = str(input.source);
      return {
        ...base,
        kind: "session_start",
        cwd,
        branch: git.branch,
        repo: git.repo,
        source: source && SOURCES.has(source) ? (source as "startup") : undefined,
        t3ThreadId: t3?.id,
        title: t3?.title ?? str(input.session_title),
        model: str(input.model),
      };
    }
    case "PreToolUse": {
      if (input.tool_name !== "Agent" || !input.tool_use_id) return undefined;
      const tool = input.tool_input ?? {};
      return {
        ...base,
        kind: "agent_start",
        toolUseId: input.tool_use_id,
        subagentType: str(tool.subagent_type) ?? "general-purpose",
        description: str(tool.description) ?? "",
        model: str(tool.model),
        parentAgentId: str(input.agent_id),
      };
    }
    case "PostToolUse": {
      const agentId = str(input.tool_response?.agentId);
      if (input.tool_name !== "Agent" || !input.tool_use_id || !agentId) return undefined;
      return { ...base, kind: "agent_launched", toolUseId: input.tool_use_id, agentId };
    }
    case "SubagentStop": {
      const agentId = str(input.agent_id);
      if (!agentId) return undefined;
      const usage = await sumTranscriptUsage(input.agent_transcript_path);
      return {
        ...base,
        kind: "agent_stop",
        agentId,
        status: "completed",
        usage,
        model: usage.model === "unknown" ? undefined : usage.model,
      };
    }
    case "Stop":
      return {
        ...base,
        kind: "turn_stop",
        usage: await sumTranscriptUsage(input.transcript_path),
        lastMessage: str(input.last_assistant_message)?.slice(0, LAST_MESSAGE_MAX),
      };
    case "SessionEnd":
      return { ...base, kind: "session_end", reason: str(input.reason) };
    default:
      return undefined;
  }
}

async function main() {
  const raw = readFileSync(0, "utf8");
  const input = JSON.parse(raw) as HookInput;
  const config = readConfig();
  const sessionId = str(input.session_id);
  if (!config || !sessionId) return;

  const eventId = createHash("sha256")
    .update(`${input.hook_event_name}\n${raw}`)
    .digest("hex");
  const event = await toEvent(input, { eventId, sessionId, at: Date.now() });
  if (!event) return;

  await fetch(config.ingestUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

// A reporting failure must never disturb the session.
await main().catch((error) => {
  if (process.env.REPORT_DEBUG) console.error(error);
});
process.exit(0);
