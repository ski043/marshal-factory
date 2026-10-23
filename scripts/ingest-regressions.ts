import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";

process.loadEnvFile(".env.local");
const { db } = await import("../db/client");
const { agents, events, runs } = await import("../db/schema");
const { ingest } = await import("../lib/ingest");
const { eventSchema } = await import("../lib/events");

const run = `regress-${Date.now()}`;
const t0 = Date.now() - 60_000;
const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, model: "claude-sonnet-5-5" };
const ev = (n: number, body: Record<string, unknown>) =>
  eventSchema.parse({ sessionId: run, eventId: `${run}-${n}`, ...body });

try {
  await ingest(db, [
    ev(1, { kind: "session_start", at: t0, cwd: "/tmp/x" }),
    ev(2, { kind: "turn_stop", at: t0 + 10_000, usage }),
    ev(3, { kind: "agent_stop", at: t0 + 11_000, agentId: `${run}-bg`, status: "completed", usage }),
  ]);
  const [r] = await db.select().from(runs).where(eq(runs.session_id, run));
  assert.equal(r.status, "idle", "a background agent finishing after the turn keeps the run idle");

  await ingest(db, [
    ev(4, { kind: "agent_stop", at: t0 + 20_000, agentId: `${run}-a`, status: "completed", usage, model: "claude-haiku-5-5" }),
    ev(5, { kind: "agent_launched", at: t0 + 20_100, toolUseId: `${run}-tu`, agentId: `${run}-a` }),
  ]);
  await ingest(db, [
    ev(6, { kind: "agent_start", at: t0 + 15_000, toolUseId: `${run}-tu`, subagentType: "Explore", description: "late", model: "haiku" }),
  ]);
  const [a] = await db.select().from(agents).where(eq(agents.tool_use_id, `${run}-tu`));
  assert.equal(a.model, "claude-haiku-5-5", "a late agent_start keeps the resolved model id");
  assert.equal(a.status, "completed", "a late agent_start keeps the agent completed");

  console.log("ingest regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(agents).where(eq(agents.session_id, run));
  await db.delete(runs).where(eq(runs.session_id, run));
  await db.delete(events).where(inArray(events.session_id, [run]));
  process.exit(process.exitCode ?? 0);
}
