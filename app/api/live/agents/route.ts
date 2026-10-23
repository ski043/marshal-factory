import { agentsOverviewQuery, sealOnly } from "@/lib/live-queries";

export async function POST() {
  return Response.json(await sealOnly(agentsOverviewQuery()), {
    headers: { "Cache-Control": "no-store" },
  });
}
