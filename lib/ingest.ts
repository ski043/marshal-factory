import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema";
import { agents, events, runs } from "../db/schema";
import type { FactoryEvent, Usage } from "./events";

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type AgentRow = typeof agents.$inferSelect;
type RunStatus = (typeof runs.$inferSelect)["status"];

// A background agent can finish after its turn ended, so agent_stop leaves the status alone.
const RUN_STATUS: Record<FactoryEvent["kind"], RunStatus | null> = {
  session_start: "active",
  agent_start: "active",
  agent_launched: "active",
  agent_stop: null,
  turn_stop: "idle",
  session_end: "ended",
};

export function issueKeyFromBranch(branch: string | undefined) {
  return branch?.match(/^factory\/([^/\s]+)/)?.[1];
}

const when = (ms: number) => new Date(ms);

function usageColumns(usage: Usage) {
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_tokens: usage.cacheRead,
    cache_write_tokens: usage.cacheWrite,
  };
}

const keepGreater = (column: { name: string }) =>
  sql.raw(`greatest(runs."${column.name}", excluded."${column.name}")`);

// Session totals only grow, so greatest() makes replays and reordering harmless.
async function upsertRun(tx: Tx, event: FactoryEvent) {
  const at = when(event.at);
  const meta =
    event.kind === "session_start"
      ? {
          cwd: event.cwd,
          repo: event.repo,
          branch: event.branch,
          issue_key: issueKeyFromBranch(event.branch),
          t3_thread_id: event.t3ThreadId,
          title: event.title,
          model: event.model,
        }
      : event.kind === "turn_stop"
        ? { model: event.usage.model, ...usageColumns(event.usage) }
        : {};
  const keep = (name: string) =>
    sql.raw(`coalesce(excluded."${name}", runs."${name}")`);

  await tx
    .insert(runs)
    .values({
      session_id: event.sessionId,
      status: RUN_STATUS[event.kind] ?? "active",
      started_at: at,
      last_event_at: at,
      ...meta,
    })
    .onConflictDoUpdate({
      target: runs.session_id,
      set: {
        started_at: sql.raw(`least(runs."started_at", excluded."started_at")`),
        last_event_at: sql.raw(
          `greatest(runs."last_event_at", excluded."last_event_at")`,
        ),
        // A late event must not drag the status back past a newer one.
        ...(RUN_STATUS[event.kind]
          ? {
              status: sql.raw(
                `case when excluded."last_event_at" >= runs."last_event_at" then excluded."status" else runs."status" end`,
              ),
            }
          : {}),
        ...Object.fromEntries(
          ["cwd", "repo", "branch", "issue_key", "t3_thread_id", "title", "model"]
            .filter((name) => name in meta)
            .map((name) => [name, keep(name)]),
        ),
        ...("input_tokens" in meta
          ? {
              input_tokens: keepGreater(runs.input_tokens),
              output_tokens: keepGreater(runs.output_tokens),
              cache_read_tokens: keepGreater(runs.cache_read_tokens),
              cache_write_tokens: keepGreater(runs.cache_write_tokens),
            }
          : {}),
      },
    });
}

const byToolUseId = async (tx: Tx, id: string) =>
  (await tx.select().from(agents).where(eq(agents.tool_use_id, id)))[0];
const byAgentId = async (tx: Tx, id: string) =>
  (await tx.select().from(agents).where(eq(agents.agent_id, id)))[0];

const settle = (a: AgentRow["status"], b: AgentRow["status"]) =>
  a === "running" ? b : a;

/** Rows created from an agent_stop that beat its agent_launched carry this prefix. */
const pendingKey = (agentId: string) => `agent:${agentId}`;

async function applyAgentStart(
  tx: Tx,
  e: Extract<FactoryEvent, { kind: "agent_start" }>,
) {
  await tx
    .insert(agents)
    .values({
      tool_use_id: e.toolUseId,
      session_id: e.sessionId,
      parent_agent_id: e.parentAgentId,
      subagent_type: e.subagentType,
      description: e.description,
      model: e.model,
      status: "running",
      started_at: when(e.at),
    })
    .onConflictDoUpdate({
      target: agents.tool_use_id,
      // Status is untouched: a stop that already landed stays final.
      set: {
        started_at: sql.raw(`least(agents."started_at", excluded."started_at")`),
        parent_agent_id: sql.raw(
          `coalesce(excluded."parent_agent_id", agents."parent_agent_id")`,
        ),
        subagent_type: sql.raw(
          `coalesce(excluded."subagent_type", agents."subagent_type")`,
        ),
        description: sql.raw(
          `coalesce(excluded."description", agents."description")`,
        ),
        // An existing row came from a stop or launch, whose model is the resolved id, not the alias.
        model: sql.raw(`coalesce(agents."model", excluded."model")`),
      },
    });
}

async function applyAgentLaunched(
  tx: Tx,
  e: Extract<FactoryEvent, { kind: "agent_launched" }>,
) {
  const real = await byToolUseId(tx, e.toolUseId);
  const linked = await byAgentId(tx, e.agentId);

  if (linked && linked.tool_use_id === e.toolUseId) return;

  if (linked && real) {
    await tx.delete(agents).where(eq(agents.tool_use_id, linked.tool_use_id));
    await tx
      .update(agents)
      .set({
        agent_id: e.agentId,
        status: settle(real.status, linked.status),
        ended_at: real.ended_at ?? linked.ended_at,
        // The stop's model is a resolved id; the start's is the requested alias.
        model: linked.model ?? real.model,
        started_at:
          real.started_at < linked.started_at ? real.started_at : linked.started_at,
        input_tokens: Math.max(real.input_tokens, linked.input_tokens),
        output_tokens: Math.max(real.output_tokens, linked.output_tokens),
        cache_read_tokens: Math.max(real.cache_read_tokens, linked.cache_read_tokens),
        cache_write_tokens: Math.max(
          real.cache_write_tokens,
          linked.cache_write_tokens,
        ),
      })
      .where(eq(agents.tool_use_id, e.toolUseId));
  } else if (linked) {
    await tx
      .update(agents)
      .set({ tool_use_id: e.toolUseId })
      .where(eq(agents.tool_use_id, linked.tool_use_id));
  } else if (real) {
    await tx
      .update(agents)
      .set({ agent_id: e.agentId })
      .where(eq(agents.tool_use_id, e.toolUseId));
  } else {
    await tx.insert(agents).values({
      tool_use_id: e.toolUseId,
      session_id: e.sessionId,
      agent_id: e.agentId,
      status: "running",
      started_at: when(e.at),
    });
  }
}

async function applyAgentStop(
  tx: Tx,
  e: Extract<FactoryEvent, { kind: "agent_stop" }>,
) {
  const existing = await byAgentId(tx, e.agentId);
  if (!existing) {
    await tx.insert(agents).values({
      tool_use_id: pendingKey(e.agentId),
      session_id: e.sessionId,
      agent_id: e.agentId,
      status: e.status,
      model: e.model ?? e.usage.model,
      started_at: when(e.at),
      ended_at: when(e.at),
      ...usageColumns(e.usage),
    });
    return;
  }
  await tx
    .update(agents)
    .set({
      status: settle(existing.status, e.status),
      ended_at: existing.ended_at ?? when(e.at),
      // The stop carries the resolved model id; the start only had the requested alias.
      model: e.model ?? existing.model,
      input_tokens: Math.max(existing.input_tokens, e.usage.input),
      output_tokens: Math.max(existing.output_tokens, e.usage.output),
      cache_read_tokens: Math.max(existing.cache_read_tokens, e.usage.cacheRead),
      cache_write_tokens: Math.max(existing.cache_write_tokens, e.usage.cacheWrite),
    })
    .where(eq(agents.tool_use_id, existing.tool_use_id));
}

async function project(tx: Tx, event: FactoryEvent) {
  await upsertRun(tx, event);
  switch (event.kind) {
    case "agent_start":
      return applyAgentStart(tx, event);
    case "agent_launched":
      return applyAgentLaunched(tx, event);
    case "agent_stop":
      return applyAgentStop(tx, event);
    default:
      return;
  }
}

export type IngestResult = { received: number; inserted: number };

/**
 * Appends events and applies projections in one transaction. Events that were
 * already stored are skipped, so a retried batch changes nothing.
 */
export async function ingest(
  db: Db,
  batch: FactoryEvent[],
): Promise<IngestResult> {
  return db.transaction(async (tx) => {
    // Projections read-then-write agent rows, so one session is handled by one batch at a time.
    const sessionIds = [...new Set(batch.map((e) => e.sessionId))].sort();
    for (const id of sessionIds) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
    }

    const stored = await tx
      .insert(events)
      .values(
        batch.map((e) => ({
          event_id: e.eventId,
          session_id: e.sessionId,
          kind: e.kind,
          at: when(e.at),
          payload: e,
        })),
      )
      .onConflictDoNothing({ target: events.event_id })
      .returning({ event_id: events.event_id });

    const fresh = new Set(stored.map((row) => row.event_id));
    for (const event of batch) {
      if (!fresh.delete(event.eventId)) continue;
      await project(tx, event);
    }
    return { received: batch.length, inserted: stored.length };
  });
}
