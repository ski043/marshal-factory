"use client";

import { useLiveQuery } from "@neon/realtime-react";
import { useCallback, useMemo, useState } from "react";
import type { AgentRow, EventRow, RunRow } from "@/db/schema";
import { Board } from "./board";
import { groupBy } from "./format";
import { RunDetail } from "./run-detail";
import { fetchSealed, type Feed } from "./sealed";
import { Sidebar } from "./sidebar";
import { StatsStrip } from "./stats-strip";
import { useAfterHydration } from "./time";

export type DetailProps = {
  sessionId: string;
  agents: Feed<AgentRow>;
  events: Feed<EventRow>;
};

export function LivePanel({
  runs,
  agents,
  detail,
}: {
  runs: Feed<RunRow>;
  agents: Feed<AgentRow>;
  detail: DetailProps | undefined;
}) {
  const [runsQuery] = useState(runs.sealedQuery);
  const [agentsQuery] = useState(agents.sealedQuery);
  const refreshRuns = useCallback(() => fetchSealed<RunRow>("/api/live/runs"), []);
  const refreshAgents = useCallback(() => fetchSealed<AgentRow>("/api/live/agents"), []);

  const liveRuns = useLiveQuery(runsQuery, { refreshQuery: refreshRuns, initialData: runs.initialData });
  const liveAgents = useLiveQuery(agentsQuery, { refreshQuery: refreshAgents, initialData: agents.initialData });
  const runRows = liveRuns.data ?? runs.initialData;
  const agentRows = liveAgents.data ?? agents.initialData;

  const agentsBySession = useMemo(
    () => groupBy(agentRows, (a) => a.session_id),
    [agentRows],
  );
  const startOfToday = useAfterHydration(() => new Date().setHours(0, 0, 0, 0), 0);
  const selectedRun = detail && runRows.find((r) => r.session_id === detail.sessionId);

  return (
    <div className="grid h-screen grid-cols-[220px_1fr]">
      <Sidebar
        runCount={runRows.length}
        unstagedCount={runRows.filter((r) => r.stage === null).length}
        liveSessions={runRows.filter((r) => r.status === "active").length}
        connected={liveRuns.status === "live"}
      />
      <main className="flex min-h-0 min-w-0 flex-col">
        <header className="flex items-center border-b px-5.5 py-3.5">
          <span className="text-muted-foreground">marshal /&nbsp;</span>
          <h1 className="text-sm font-semibold">Factory board</h1>
        </header>
        <StatsStrip runs={runRows} agentsBySession={agentsBySession} startOfToday={startOfToday} />
        <div className={`grid min-h-0 flex-1 ${selectedRun ? "grid-cols-[1fr_420px]" : "grid-cols-1"}`}>
          <Board runs={runRows} agentsBySession={agentsBySession} selected={detail?.sessionId} />
          {selectedRun && detail && (
            <RunDetail key={detail.sessionId} run={selectedRun} agents={detail.agents} events={detail.events} />
          )}
        </div>
      </main>
    </div>
  );
}
