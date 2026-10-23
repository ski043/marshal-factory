import { parseSessionId, sealOnly, sessionAgentsQuery } from "@/lib/live-queries";

export async function POST(
  _request: Request,
  { params }: RouteContext<"/api/live/runs/[sessionId]/agents">,
) {
  const sessionId = parseSessionId((await params).sessionId);
  if (!sessionId) {
    return Response.json({ error: "invalid session id" }, { status: 400 });
  }
  return Response.json(await sealOnly(sessionAgentsQuery(sessionId)), {
    headers: { "Cache-Control": "no-store" },
  });
}
