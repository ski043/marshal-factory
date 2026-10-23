import { timingSafeEqual } from "node:crypto";
import { attachDatabasePool } from "@neon/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../db/schema";
import { ingestBodySchema } from "../../lib/events";
import { ingest } from "../../lib/ingest";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
attachDatabasePool(pool);
const db = drizzle(pool, { schema });

function authorized(request: Request) {
  const expected = Buffer.from(`Bearer ${process.env.FACTORY_INGEST_SECRET}`);
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const handler = {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== "/ingest" || request.method !== "POST") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (!authorized(request)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const json = await request.json().catch(() => undefined);
    const parsed = ingestBodySchema.safeParse(json);
    if (!parsed.success) {
      return Response.json(
        { error: "invalid body", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    return Response.json(await ingest(db, parsed.data));
  },
};

export default handler;
