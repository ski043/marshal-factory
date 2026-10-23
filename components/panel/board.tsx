import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import type { AgentRow, RunRow } from "@/db/schema";
import { RunCard } from "./run-card";

const STAGES = [
  { key: "queued", label: "Queued", dot: "bg-faint" },
  { key: "triage", label: "Triage", dot: "bg-info" },
  { key: "investigating", label: "Investigating", dot: "bg-violet" },
  { key: "implementing", label: "Implementing", dot: "bg-primary" },
  { key: "verifying", label: "Verifying", dot: "bg-warning" },
  { key: "pr", label: "PR · CI", dot: "bg-primary" },
  { key: "waiting", label: "Waiting on you", dot: "bg-warning" },
  { key: "merged", label: "Merged", dot: "bg-success" },
  { key: "failed", label: "Failed", dot: "bg-destructive" },
] as const;

export function Board({
  runs,
  agentsBySession,
  selected,
}: {
  runs: readonly RunRow[];
  agentsBySession: Map<string, AgentRow[]>;
  selected: string | undefined;
}) {
  const unstaged = runs.filter((r) => r.stage === null);
  const card = (run: RunRow) => (
    <RunCard
      key={run.session_id}
      run={run}
      agents={agentsBySession.get(run.session_id) ?? []}
      selected={run.session_id === selected}
    />
  );
  const columns = STAGES.filter(
    (s) => s.key !== "failed" || runs.some((r) => r.stage === "failed"),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
      <section id="other-activity" className="flex flex-col gap-2.5">
        <h2 className="text-xs font-semibold tracking-wider text-faint uppercase">
          Other activity · {unstaged.length}
        </h2>
        {unstaged.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No sessions yet</EmptyTitle>
              <EmptyDescription>
                Claude Code sessions in this repo appear here as soon as the
                reporter hook sends its first event.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-2.5">
            {unstaged.map(card)}
          </div>
        )}
      </section>

      <section className="flex items-start gap-3 overflow-x-auto pb-2">
        {columns.map((stage) => {
          const items = runs.filter((r) => r.stage === stage.key);
          return (
            <div
              key={stage.key}
              className="flex w-59 flex-none flex-col rounded-xl border bg-card"
            >
              <div className="flex items-center gap-2 border-b px-3 py-2.5 font-medium text-muted-foreground">
                <span className={`size-2 rounded-full ${stage.dot}`} />
                {stage.label}
                <span className="ml-auto text-faint">{items.length}</span>
              </div>
              <div className="flex flex-col gap-2 p-2">{items.map(card)}</div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
