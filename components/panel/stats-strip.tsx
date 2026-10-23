import type { AgentRow, RunRow } from "@/db/schema";
import { cn } from "@/lib/utils";
import { formatTokens, formatUsd, runCost, totalTokens } from "./format";

function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone?: string;
}) {
  return (
    <div className="bg-background px-5 py-3.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn("mt-0.5 text-xl font-semibold tabular-nums", tone)}
      >
        {value}
      </div>
      <div className="text-xs text-faint">{note}</div>
    </div>
  );
}

export function StatsStrip({
  runs,
  agentsBySession,
  startOfToday,
}: {
  runs: readonly RunRow[];
  agentsBySession: Map<string, AgentRow[]>;
  startOfToday: number;
}) {
  const today = runs.filter((r) => r.last_event_at.getTime() >= startOfToday);
  const active = runs.filter((r) => r.status === "active").length;
  const idle = runs.filter((r) => r.status === "idle").length;
  const agentTokens = (r: RunRow) =>
    (agentsBySession.get(r.session_id) ?? []).reduce(
      (sum, a) => sum + totalTokens(a),
      0,
    );
  const tokens = today.reduce((sum, r) => sum + totalTokens(r) + agentTokens(r), 0);
  const spend = today.reduce(
    (sum, r) => sum + runCost(r, agentsBySession.get(r.session_id) ?? []),
    0,
  );
  const runningAgents = [...agentsBySession.values()]
    .flat()
    .filter((a) => a.status === "running").length;

  return (
    <section className="grid grid-cols-5 gap-px border-b bg-border">
      <Stat label="Active runs" value={String(active)} note="working now" tone={active ? "text-primary" : undefined} />
      <Stat label="Idle runs" value={String(idle)} note="waiting for a prompt" />
      <Stat label="Running agents" value={String(runningAgents)} note="subagents in flight" />
      <Stat label="Tokens today" value={formatTokens(tokens)} note={`${today.length} runs active today`} />
      <Stat label="Spend today" value={formatUsd(spend)} note="runs touched today, whole-run cost" />
    </section>
  );
}
