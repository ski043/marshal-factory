import type { EventRow } from "@/db/schema";
import { eventSchema } from "@/lib/events";
import { shortId } from "./format";
import { Time } from "./time";

function summarize(payload: unknown, kind: string) {
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) return { who: kind, text: "" };
  const e = parsed.data;
  switch (e.kind) {
    case "session_start":
      return { who: "session", text: `started in ${e.cwd}${e.branch ? ` (${e.branch})` : ""}` };
    case "agent_start":
      return { who: e.subagentType, text: e.description };
    case "agent_launched":
      return { who: "agent", text: `launched ${shortId(e.agentId)}` };
    case "agent_stop":
      return { who: "agent", text: `${shortId(e.agentId)} ${e.status}` };
    case "turn_stop":
      return { who: "turn", text: e.lastMessage?.replace(/\s+/g, " ").slice(0, 120) ?? "ended" };
    case "session_end":
      return { who: "session", text: `ended${e.reason ? ` (${e.reason})` : ""}` };
  }
}

export function EventFeed({ events }: { events: readonly EventRow[] }) {
  if (events.length === 0) {
    return <p className="text-muted-foreground">No events yet.</p>;
  }
  return (
    <div className="flex flex-col gap-1.5 font-mono text-xs">
      {events.map((event) => {
        const { who, text } = summarize(event.payload, event.kind);
        return (
          <div key={event.event_id} className="grid grid-cols-[56px_1fr] gap-2 text-muted-foreground">
            <span className="text-faint">
              <Time date={event.at} />
            </span>
            <span className="min-w-0 break-words">
              <b className="font-medium text-foreground">{who}</b> {text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
