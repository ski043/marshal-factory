import "./test-guard";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { sourceFor } from "../lib/sources";
import { githubIntent, verifyGithub } from "../lib/webhooks";

const { webhook } = sourceFor("linear");
if (!webhook) throw new Error("the linear source has no webhook");
const headers = (signature: string | null) => new Headers(signature ? { "linear-signature": signature } : {});
const verifyLinear = (raw: string, signature: string | null, secret: string | undefined, at: number) => webhook.verify(raw, headers(signature), secret, at);

const secret = "s3cret";
const sign = (body: string) => createHmac("sha256", secret).update(body).digest("hex");
const now = 1_800_000_000_000;

const linearBody = JSON.stringify({ action: "update", type: "Issue", webhookTimestamp: now - 5_000, data: {} });
assert.deepEqual(verifyLinear(linearBody, sign(linearBody), secret, now), { ok: true });
assert.equal(verifyLinear(linearBody, sign(linearBody + " "), secret, now).ok, false, "a wrong signature is rejected");
assert.equal(verifyLinear(linearBody, null, secret, now).ok, false, "a missing signature is rejected");
assert.deepEqual(verifyLinear(linearBody, sign(linearBody), undefined, now), { ok: false, reason: "no webhook secret configured" }, "an unset secret rejects instead of throwing");
const old = JSON.stringify({ action: "update", type: "Issue", webhookTimestamp: now - 61_000, data: {} });
assert.deepEqual(verifyLinear(old, sign(old), secret, now), { ok: false, reason: "stale webhookTimestamp" }, "a replay older than a minute is rejected");
assert.equal(verifyGithub("{}", `sha256=${sign("{}")}`, secret).ok, true);
assert.equal(verifyGithub("{}", sign("{}"), secret).ok, false, "GitHub signatures need the sha256= prefix");
assert.equal(verifyGithub("{}", `sha256=${createHmac("sha256", "").update("{}").digest("hex")}`, "").ok, false, "an empty secret verifies nothing");

const opts = { FACTORY_TEAM_KEY: "FAC", FACTORY_LABEL: "factory" };
const linearIntent = (body: unknown, env: typeof opts) => webhook.intent(body, env);
const issue = (over: Record<string, unknown> = {}, updatedFrom?: Record<string, unknown>) => ({
  action: "update",
  type: "Issue",
  updatedFrom,
  data: {
    id: "i1",
    identifier: "FAC-11",
    team: { key: "FAC" },
    labels: [{ id: "l1", name: "factory" }],
    labelIds: ["l1"],
    state: { type: "unstarted", name: "Todo" },
    ...over,
  },
});
assert.deepEqual(linearIntent(issue({}, { labelIds: [] }), opts), { kind: "claim", jobId: "linear:i1" }, "labeled in Todo means claim");
assert.equal(linearIntent(issue({ state: { type: "started", name: "In Progress" } }), opts), null, "a started issue is not claimed again");
assert.equal(linearIntent(issue({ identifier: "ALE-3", team: { key: "ALE" } }), opts), null, "other teams are ignored");
assert.equal(linearIntent(issue({ labels: [], labelIds: [] }, { labelIds: ["l1"] }), opts)?.kind, "stop", "removing the label stops");
assert.equal(
  linearIntent(issue({ labels: [{ id: "l2", name: "bug" }], labelIds: ["l2"] }, { labelIds: ["l1"] }), opts)?.kind,
  "stop",
  "swapping factory for another label in one edit stops too",
);
assert.equal(
  linearIntent(issue({ state: { type: "canceled", name: "Canceled" } }, { stateId: "x" }), opts)?.kind,
  "stop",
  "canceling stops",
);
assert.deepEqual(
  linearIntent({ action: "create", type: "Comment", data: { id: "c1", issueId: "i1", body: "1: (b)" } }, opts),
  { kind: "answer", jobId: "linear:i1" },
);

const delivered = JSON.stringify({ ...issue({}, { labelIds: [] }), webhookTimestamp: now - 1_000 });
assert.deepEqual(verifyLinear(delivered, sign(delivered), secret, now), { ok: true }, "a signed delivery passes the source's webhook");
assert.deepEqual(
  webhook.intent(JSON.parse(delivered), opts),
  { kind: "claim", jobId: "linear:i1" },
  "and the source's webhook turns it into the claim intent",
);
assert.equal(webhook.deliveryHeader, "Linear-Delivery");
assert.equal(webhook.eventHeader, "Linear-Event");

assert.deepEqual(
  githubIntent("pull_request", { action: "closed", pull_request: { html_url: "https://g/p/1", merged: true } }),
  { kind: "merged", prUrl: "https://g/p/1" },
);
assert.equal(githubIntent("pull_request", { action: "closed", pull_request: { html_url: "u", merged: false } }), null, "a closed, unmerged PR is not a merge");
assert.equal(githubIntent("push", { ref: "refs/heads/main", repository: { default_branch: "main" } })?.kind, "recheck_conflicts");
assert.equal(githubIntent("push", { ref: "refs/heads/factory/FAC-1", repository: { default_branch: "main" } }), null);
assert.equal(githubIntent("ping", {}), null);
for (const event of ["installation", "installation_repositories", "issues", "check_suite", "check_run"]) {
  assert.equal(githubIntent(event, { action: "created" }), null, `a ${event} delivery carries no intent`);
}

process.env.LINEAR_WEBHOOK_SECRET = secret;
process.env.GITHUB_APP_WEBHOOK_SECRET = secret;
const { default: ingestFunction } = await import("../functions/ingest/index");
const { db } = await import("../db/client");
const { intents, webhookDeliveries } = await import("../db/schema");
const { eq } = await import("drizzle-orm");
const deliveryId = `webhook-regress-${Date.now()}`;
const post = (raw: string, signature: string, delivery: string | null = deliveryId) =>
  ingestFunction.fetch(
    new Request("http://function/webhooks/linear", {
      method: "POST",
      headers: { "linear-signature": signature, "linear-event": "Issue", ...(delivery ? { "linear-delivery": delivery } : {}) },
      body: raw,
    }),
  );
const fresh = JSON.stringify({ ...issue({}, { labelIds: [] }), webhookTimestamp: Date.now() });
const appDeliveries = ["installation", "issues"].map((event) => ({ event, id: `${deliveryId}-${event}` }));
const postGithub = (event: string, delivery: string, raw: string, signature: string) =>
  ingestFunction.fetch(
    new Request("http://function/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": `sha256=${signature}` },
      body: raw,
    }),
  );
try {
  const appBody = JSON.stringify({ action: "created", installation: { id: 7 } });
  for (const { event, id } of appDeliveries) {
    assert.deepEqual(await (await postGithub(event, id, appBody, sign(appBody))).json(), { duplicate: false, intent: null }, `an app ${event} delivery is recorded with no intent`);
    assert.equal((await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.delivery_id, `github:${id}`))).length, 1);
    assert.equal((await db.select().from(intents).where(eq(intents.id, `github:${id}`))).length, 0);
  }
  const oldSecret = createHmac("sha256", "old-per-repo-secret").update(appBody).digest("hex");
  assert.equal((await postGithub("issues", `${deliveryId}-old`, appBody, oldSecret)).status, 401, "a delivery signed with another secret is refused");

  assert.equal((await post(fresh, "0".repeat(64))).status, 401, "a bad signature is rejected by the routed source");
  assert.equal((await post(fresh, sign(fresh), null)).status, 400, "a delivery without an id is rejected");
  assert.deepEqual(await (await post(fresh, sign(fresh))).json(), { duplicate: false, intent: "claim" }, "a signed delivery records the claim intent");
  assert.deepEqual(await (await post(fresh, sign(fresh))).json(), { duplicate: true, intent: null }, "a redelivery records nothing");
  assert.equal((await ingestFunction.fetch(new Request("http://function/webhooks/nope", { method: "POST", body: "{}" }))).status, 404);
  assert.equal((await db.select().from(intents).where(eq(intents.id, `linear:${deliveryId}`))).length, 1, "exactly one intent row");
} finally {
  await db.delete(intents).where(eq(intents.id, `linear:${deliveryId}`));
  await db.delete(webhookDeliveries).where(eq(webhookDeliveries.delivery_id, `linear:${deliveryId}`));
  for (const { id } of appDeliveries) await db.delete(webhookDeliveries).where(eq(webhookDeliveries.delivery_id, `github:${id}`));
}
console.log("webhook regressions passed");
process.exit(0);
