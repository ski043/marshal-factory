import { costUsd } from "@/lib/pricing";
import type { AgentRow, RunRow } from "@/db/schema";

export const shortId = (id: string) => id.slice(0, 8);

export function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

export const formatUsd = (n: number) => `$${n.toFixed(n < 10 ? 2 : 1)}`;

type Tokens = Pick<
  RunRow,
  "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens"
>;

export const totalTokens = (t: Tokens) =>
  t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens;

export function runCost(run: RunRow, runAgents: readonly AgentRow[]) {
  return (
    costUsd(run, run.model) +
    runAgents.reduce((sum, agent) => sum + costUsd(agent, agent.model), 0)
  );
}

export function groupBy<T>(rows: readonly T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

export const runTitle = (run: RunRow) =>
  run.title ?? run.issue_key ?? (run.repo ? `${run.repo} session` : "Session");
