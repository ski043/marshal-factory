import { timingSafeEqual } from "node:crypto";
import { attachDatabasePool } from "@neon/functions";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../db/schema";
import { ingestBodySchema } from "../../lib/events";
import { ingest } from "../../lib/ingest";
import { isJobSource, sourceFor } from "../../lib/sources";
import type { JobSource } from "../../lib/sources/types";
import { githubIntent, githubPushIntent, verifyGithub, type IntentDraft } from "../../lib/webhooks";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
attachDatabasePool(pool);
const db = drizzle(pool, { schema });

function authorized(request: Request) {
  // Without a secret, refuse everything rather than accept a literal "Bearer undefined".
  const secret = process.env.FACTORY_INGEST_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Stores the delivery and the intents it implies in one transaction. A delivery id seen before
 * stores nothing, so a redelivery or replay has no effect.
 */
async function record(source: string, deliveryId: string, event: string, payload: unknown, drafts: IntentDraft | null | readonly (IntentDraft | null)[]) {
  const all = (Array.isArray(drafts) ? drafts : [drafts]).filter((d): d is IntentDraft => d !== null);
  return db.transaction(async (tx) => {
    const now = new Date();
    const fresh = await tx
      .insert(schema.webhookDeliveries)
      .values({ delivery_id: `${source}:${deliveryId}`, source, event, received_at: now, payload })
      .onConflictDoNothing()
      .returning({ id: schema.webhookDeliveries.delivery_id });
    if (fresh.length === 0) return { duplicate: true, intent: null };
    for (const intent of all) {
      const [byPr] = intent.prUrl && !intent.jobId
        ? await tx.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.pr_url, intent.prUrl))
        : [];
      await tx.insert(schema.intents).values({
        id: `${source}:${intent.key ?? deliveryId}`,
        kind: intent.kind,
        job_id: intent.jobId ?? byPr?.id,
        pr_url: intent.prUrl,
        detail: intent.detail,
        created_at: now,
      }).onConflictDoNothing();
    }
    return { duplicate: false, intent: all.map((i) => i.kind).join(",") || null };
  });
}

async function sourceWebhook(source: JobSource, request: Request) {
  const { webhook } = sourceFor(source);
  if (!webhook) return Response.json({ error: "not found" }, { status: 404 });
  const raw = await request.text();
  const verdict = webhook.verify(raw, request.headers, process.env[webhook.secretEnv]);
  if (!verdict.ok) return Response.json({ error: verdict.reason }, { status: 401 });
  const deliveryId = request.headers.get(webhook.deliveryHeader);
  if (!deliveryId) return Response.json({ error: `missing ${webhook.deliveryHeader}` }, { status: 400 });
  const body = JSON.parse(raw) as unknown;
  const intent = webhook.intent(body, process.env);
  return Response.json(await record(source, deliveryId, request.headers.get(webhook.eventHeader) ?? "?", body, intent));
}

async function githubWebhook(request: Request) {
  const raw = await request.text();
  const verdict = verifyGithub(raw, request.headers.get("x-hub-signature-256"), process.env.GITHUB_APP_WEBHOOK_SECRET);
  if (!verdict.ok) return Response.json({ error: verdict.reason }, { status: 401 });
  const deliveryId = request.headers.get("x-github-delivery");
  const event = request.headers.get("x-github-event") ?? "?";
  if (!deliveryId) return Response.json({ error: "missing X-GitHub-Delivery" }, { status: 400 });
  const body = JSON.parse(raw) as unknown;
  return Response.json(await record("github", deliveryId, event, body, [githubIntent(event, body), githubPushIntent(event, body)]));
}

async function ingestEvents(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const json = await request.json().catch(() => undefined);
  const parsed = ingestBodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  return Response.json(await ingest(db, parsed.data));
}

const ROUTES: Record<string, (request: Request) => Promise<Response>> = {
  "/ingest": ingestEvents,
  "/webhooks/github": githubWebhook,
};

const handler = {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const source = /^\/webhooks\/([^/]+)$/.exec(path)?.[1];
    const route = ROUTES[path] ?? (source && isJobSource(source) ? (req: Request) => sourceWebhook(source, req) : undefined);
    if (!route || request.method !== "POST") return Response.json({ error: "not found" }, { status: 404 });
    try {
      return await route(request);
    } catch (error) {
      console.error(error);
      return Response.json({ error: "could not handle the request" }, { status: 500 });
    }
  },
};

export default handler;
