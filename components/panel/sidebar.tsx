import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function Sidebar({
  runCount,
  unstagedCount,
  liveSessions,
  connected,
}: {
  runCount: number;
  unstagedCount: number;
  liveSessions: number;
  connected: boolean;
}) {
  return (
    <nav className="flex flex-col gap-1 border-r bg-sidebar px-3 py-4">
      <div className="flex items-center gap-2.5 px-2 pt-1 pb-4 font-semibold">
        <div className="size-5.5 rounded-md bg-[conic-gradient(from_210deg,var(--primary),var(--violet),var(--info),var(--primary))]" />
        Marshal Factory
      </div>
      <Link
        href="/"
        className="flex items-center justify-between rounded-md bg-accent px-2.5 py-1.5"
      >
        Board <Badge variant="secondary">{runCount}</Badge>
      </Link>
      <a
        href="#other-activity"
        className="flex items-center justify-between rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        Other activity <Badge variant="secondary">{unstagedCount}</Badge>
      </a>
      <div className="mt-auto flex items-center gap-2 px-2.5 py-2 text-muted-foreground">
        <span
          className={cn(
            "size-1.5 rounded-full",
            connected ? "animate-pulse bg-success" : "bg-warning",
          )}
        />
        {connected ? "Live" : "Connecting"} · {liveSessions} active
      </div>
    </nav>
  );
}
