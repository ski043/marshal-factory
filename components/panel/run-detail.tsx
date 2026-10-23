"use client";

import { useLiveQuery } from "@neon/realtime-react";
import { ExternalLinkIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { AgentRow, EventRow, RunRow } from "@/db/schema";
import { AgentTree } from "./agent-tree";
import { EventFeed } from "./event-feed";
import { formatUsd, runCost, runTitle, shortId } from "./format";
import { ModelChip } from "./model-chip";
import { fetchSealed, type Feed } from "./sealed";

export function RunDetail({
  run,
  agents,
  events,
}: {
  run: RunRow;
  agents: Feed<AgentRow>;
  events: Feed<EventRow>;
}) {
  const base = `/api/live/runs/${encodeURIComponent(run.session_id)}`;
  // Server re-renders hand over a fresh sealed object for the same query; keep the first.
  const [agentsQuery] = useState(agents.sealedQuery);
  const [eventsQuery] = useState(events.sealedQuery);
  const refreshAgents = useCallback(() => fetchSealed<AgentRow>(`${base}/agents`), [base]);
  const refreshEvents = useCallback(() => fetchSealed<EventRow>(`${base}/events`), [base]);

  const liveAgents = useLiveQuery(agentsQuery, {
    refreshQuery: refreshAgents,
    initialData: agents.initialData,
  });
  const liveEvents = useLiveQuery(eventsQuery, {
    refreshQuery: refreshEvents,
    initialData: events.initialData,
  });
  const agentRows = liveAgents.data ?? agents.initialData;
  const eventRows = liveEvents.data ?? events.initialData;

  return (
    <aside className="flex min-h-0 flex-col border-l bg-card">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 px-4.5 py-4">
          <div className="flex items-center justify-between font-mono text-xs text-faint">
            <span>
              {run.issue_key ?? shortId(run.session_id)}
              {run.branch ? ` · ${run.branch}` : ""}
            </span>
            <Button asChild variant="ghost" size="icon-sm" aria-label="Close run">
              <Link href="/" scroll={false}>
                <XIcon />
              </Link>
            </Button>
          </div>
          <h2 className="text-base font-semibold">{runTitle(run)}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="rounded-md font-normal">
              {run.status}
            </Badge>
            <ModelChip model={run.model} />
            {run.repo && <span className="text-muted-foreground">{run.repo}</span>}
            <span className="font-mono text-muted-foreground">
              {formatUsd(runCost(run, agentRows))}
            </span>
            {run.t3_thread_id && (
              <Button asChild variant="outline" size="sm" className="ml-auto">
                <a href={`t3-thread://v1/${run.t3_thread_id}`}>
                  Open in T3
                  <ExternalLinkIcon data-icon="inline-end" />
                </a>
              </Button>
            )}
          </div>
        </div>
        <Separator />
        <section className="flex flex-col gap-2.5 px-4.5 py-3.5">
          <h3 className="text-xs font-semibold tracking-wider text-faint uppercase">
            Agents · {agentRows.length}
          </h3>
          <AgentTree run={run} agents={agentRows} />
        </section>
        <Separator />
        <section className="flex flex-col gap-2.5 px-4.5 py-3.5">
          <h3 className="text-xs font-semibold tracking-wider text-faint uppercase">
            Live events
          </h3>
          <EventFeed events={eventRows} />
        </section>
      </ScrollArea>
    </aside>
  );
}
