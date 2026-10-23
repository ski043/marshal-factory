import { createRealtime } from "@neon/realtime/server";
import { drizzleAdapter } from "@neon/realtime-drizzle";
import { desc, eq, getTableColumns } from "drizzle-orm";
import { db } from "@/db/client";
import { agents, events, runs } from "@/db/schema";

// v0 has no auth: the panel is local and single-user. Phase 7 puts a session check in front of
// every route that calls seal(); until then anyone who can reach these routes can read all rows.

export const realtime = createRealtime({
  secret: process.env.NEON_REALTIME_SECRET!,
  db: new URL(process.env.DATABASE_URL!).pathname.slice(1),
  adapter: drizzleAdapter(),
});

export const RUN_LIMIT = 200;
export const AGENT_OVERVIEW_LIMIT = 1000;
export const SESSION_AGENT_LIMIT = 200;
export const FEED_LIMIT = 50;

// Live queries must be deterministic, so none of these read the clock.

export const runsQuery = () =>
  db
    .select(getTableColumns(runs))
    .from(runs)
    .orderBy(desc(runs.last_event_at))
    .limit(RUN_LIMIT);

/** Feeds per-card agent counts and cost on the board. */
export const agentsOverviewQuery = () =>
  db
    .select(getTableColumns(agents))
    .from(agents)
    .orderBy(desc(agents.started_at))
    .limit(AGENT_OVERVIEW_LIMIT);

export const sessionAgentsQuery = (sessionId: string) =>
  db
    .select(getTableColumns(agents))
    .from(agents)
    .where(eq(agents.session_id, sessionId))
    .orderBy(agents.started_at)
    .limit(SESSION_AGENT_LIMIT);

export const sessionEventsQuery = (sessionId: string) =>
  db
    .select(getTableColumns(events))
    .from(events)
    .where(eq(events.session_id, sessionId))
    .orderBy(desc(events.at), desc(events.event_id))
    .limit(FEED_LIMIT);

/** Runs the query for server rendering and seals it for the browser subscription. */
export async function load<Q extends Parameters<typeof realtime.seal>[0]["query"]>(
  query: Q,
) {
  const [initialData, sealedQuery] = await Promise.all([
    query,
    realtime.seal({ query }),
  ]);
  return { initialData, sealedQuery };
}

export function sealOnly(query: Parameters<typeof realtime.seal>[0]["query"]) {
  return realtime.seal({ query });
}

const SESSION_ID = /^[\w.:-]{1,128}$/;
export const parseSessionId = (value: string) =>
  SESSION_ID.test(value) ? value : undefined;
