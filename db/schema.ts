import {
  doublePrecision,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// Keys equal column names: the Neon Realtime Drizzle adapter requires it.
// Token counters are float8 because int8 and numeric reach live subscribers as strings.

export const runStatus = pgEnum("run_status", ["active", "idle", "ended"]);
export const runStage = pgEnum("run_stage", [
  "queued",
  "triage",
  "investigating",
  "implementing",
  "verifying",
  "pr",
  "waiting",
  "merged",
  "failed",
]);
export const agentStatus = pgEnum("agent_status", [
  "running",
  "completed",
  "failed",
]);

const ts = (name: string) => timestamp(name, { withTimezone: true });

const tokens = () => ({
  input_tokens: doublePrecision("input_tokens").notNull().default(0),
  output_tokens: doublePrecision("output_tokens").notNull().default(0),
  cache_read_tokens: doublePrecision("cache_read_tokens").notNull().default(0),
  cache_write_tokens: doublePrecision("cache_write_tokens")
    .notNull()
    .default(0),
});

export const events = pgTable(
  "events",
  {
    event_id: text("event_id").primaryKey(),
    session_id: text("session_id").notNull(),
    kind: text("kind").notNull(),
    at: ts("at").notNull(),
    payload: jsonb("payload").notNull(),
  },
  (t) => [index("events_session_at_idx").on(t.session_id, t.at)],
);

export const runs = pgTable(
  "runs",
  {
    session_id: text("session_id").primaryKey(),
    cwd: text("cwd"),
    repo: text("repo"),
    branch: text("branch"),
    issue_key: text("issue_key"),
    t3_thread_id: text("t3_thread_id"),
    title: text("title"),
    status: runStatus("status").notNull().default("active"),
    stage: runStage("stage"),
    started_at: ts("started_at").notNull(),
    last_event_at: ts("last_event_at").notNull(),
    model: text("model"),
    ...tokens(),
  },
  (t) => [index("runs_last_event_at_idx").on(t.last_event_at)],
);

export const agents = pgTable(
  "agents",
  {
    tool_use_id: text("tool_use_id").primaryKey(),
    session_id: text("session_id").notNull(),
    agent_id: text("agent_id").unique(),
    parent_agent_id: text("parent_agent_id"),
    subagent_type: text("subagent_type"),
    description: text("description"),
    model: text("model"),
    status: agentStatus("status").notNull().default("running"),
    started_at: ts("started_at").notNull(),
    ended_at: ts("ended_at"),
    ...tokens(),
  },
  (t) => [index("agents_session_idx").on(t.session_id)],
);

export type EventRow = typeof events.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
