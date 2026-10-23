import { runsQuery, sealOnly } from "@/lib/live-queries";

export async function POST() {
  return Response.json(await sealOnly(runsQuery()), {
    headers: { "Cache-Control": "no-store" },
  });
}
