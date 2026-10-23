import type { AgentRow, RunRow } from "@/db/schema";
import { costUsd } from "@/lib/pricing";
import { cn } from "@/lib/utils";
import { formatTokens, formatUsd, groupBy, totalTokens } from "./format";
import { ModelChip } from "./model-chip";

const STATUS_DOT: Record<AgentRow["status"], string> = {
  running: "bg-primary",
  completed: "bg-success",
  failed: "bg-destructive",
};

function Node({
  label,
  status,
  model,
  tokens,
  cost,
  depth,
}: {
  label: string;
  status: string;
  model: string | null;
  tokens: number;
  cost: number;
  depth: number;
}) {
  return (
    <div
      className="grid grid-cols-[1fr_auto_auto] items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary"
      style={{ paddingLeft: 8 + depth * 18 }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("size-1.5 flex-none rounded-full", status)} />
        <span className="truncate">{label}</span>
      </div>
      <ModelChip model={model} />
      <span className="font-mono text-xs text-faint tabular-nums">
        {formatTokens(tokens)} · {formatUsd(cost)}
      </span>
    </div>
  );
}

export function AgentTree({
  run,
  agents,
}: {
  run: RunRow;
  agents: readonly AgentRow[];
}) {
  const ids = new Set(agents.flatMap((a) => (a.agent_id ? [a.agent_id] : [])));
  // An unknown parent id (its row never arrived) must not hide the child.
  const children = groupBy(agents, (a) =>
    a.parent_agent_id && ids.has(a.parent_agent_id) ? a.parent_agent_id : "",
  );

  const render = (parentKey: string, depth: number, seen: Set<string>) =>
    (children.get(parentKey) ?? []).map((agent) => {
      const nested =
        agent.agent_id && !seen.has(agent.agent_id)
          ? render(agent.agent_id, depth + 1, new Set(seen).add(agent.agent_id))
          : null;
      return (
        <div key={agent.tool_use_id}>
          <Node
            label={
              [agent.subagent_type, agent.description].filter(Boolean).join(" · ") ||
              "agent"
            }
            status={STATUS_DOT[agent.status]}
            model={agent.model}
            tokens={totalTokens(agent)}
            cost={costUsd(agent, agent.model)}
            depth={depth}
          />
          {nested}
        </div>
      );
    });

  return (
    <div className="flex flex-col gap-0.5">
      <Node
        label="main session"
        status={run.status === "active" ? STATUS_DOT.running : "bg-faint"}
        model={run.model}
        tokens={totalTokens(run)}
        cost={costUsd(run, run.model)}
        depth={0}
      />
      {render("", 1, new Set())}
    </div>
  );
}
