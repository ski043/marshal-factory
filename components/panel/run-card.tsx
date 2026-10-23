import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import type { AgentRow, RunRow } from "@/db/schema";
import { cn } from "@/lib/utils";
import { formatUsd, runCost, runTitle, shortId } from "./format";
import { ModelChip } from "./model-chip";

export function RunCard({
  run,
  agents,
  selected,
}: {
  run: RunRow;
  agents: readonly AgentRow[];
  selected: boolean;
}) {
  const running = agents.filter((a) => a.status === "running").length;
  return (
    <Link
      href={`/?run=${run.session_id}`}
      scroll={false}
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-secondary p-2.5 text-left transition-colors hover:border-input",
        selected && "border-primary ring-1 ring-primary",
        run.status === "ended" && "opacity-60",
      )}
    >
      <div className="flex items-center gap-1.5 font-mono text-xs text-faint">
        {run.status === "active" && <Spinner className="size-2.5" />}
        {run.issue_key ?? shortId(run.session_id)}
      </div>
      <div className="line-clamp-2 font-medium">{runTitle(run)}</div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Badge variant="outline" className="rounded-md font-normal">
          {run.status}
        </Badge>
        <ModelChip model={run.model} />
        {agents.length > 0 && (
          <span>
            {running > 0 ? `${running}/${agents.length}` : agents.length}{" "}
            agents
          </span>
        )}
        <span className="font-mono">{formatUsd(runCost(run, agents))}</span>
      </div>
      {run.repo && (
        <div className="truncate font-mono text-xs text-faint">
          {run.repo}
          {run.branch ? ` · ${run.branch}` : ""}
        </div>
      )}
    </Link>
  );
}
