import "./test-guard";
import assert from "node:assert/strict";
import { eq, like, sql } from "drizzle-orm";

const { db } = await import("../db/client");
const { intentReceipts, intents, jobs, machines } = await import("../db/schema");
const { announceClaims, checkPullRequests, claim, claimLaunch, deliverStops, threads, writeBack } = await import("../runner/ops");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { config } = await import("../runner/config");
const { sourceFor } = await import("../lib/sources");
const { SourceGoneError } = await import("../lib/sources/types");
const { github } = await import("../lib/github/pulls");
const { closeBroadcast, deliveryFor, leaseIntent, receiptIntent } = await import("../runner/intents");
const { linearJob } = await import("./fixtures");
const { NO_OVERRIDES } = await import("../lib/ticket-overrides");
type Adapter = NonNullable<NonNullable<Parameters<typeof claim>[0]>["sources"]>[number];

const prefix = `claim-regress-${Date.now()}`;
// Only this script's jobs: the test branch copies a real database.
const ours = async () => (await db.select({ key: jobs.key }).from(jobs).where(like(jobs.key, `${prefix}-%`))).map((j) => j.key);
const REPO = "ski043/factory-demo";
const slot = (id: string, over: Partial<{ repos: string[]; maxInFlight: number }> = {}) => ({ id, repos: [REPO], maxInFlight: 1, ...over });
const ownerOf = async (key: string) => (await db.select().from(jobs).where(eq(jobs.key, key)))[0]!.machine_id;

const sent: string[] = [];
threads.state = async () => "running";
threads.send = async (threadId) => void sent.push(threadId);

try {
  const rounds = 50;
  const claimMs: number[] = [];
  // A runner's pool is warm; opening a second TLS connection to Neon costs most of a second once.
  const coldStart = performance.now();
  await Promise.all([db.execute(sql`select pg_sleep(0.05)`), db.execute(sql`select pg_sleep(0.05)`)]);
  console.log(`opening two pool connections: ${Math.round(performance.now() - coldStart)} ms`);
  for (let round = 0; round < rounds; round++) {
    const key = `${prefix}-race-${round}`;
    await db.insert(jobs).values(linearJob(key, key));
    const timed = async (machine: string) => {
      const started = performance.now();
      const won = await claimLaunch(key, `pending:${machine}`, slot(`${prefix}-${machine}-${round}`));
      claimMs.push(performance.now() - started);
      return won;
    };
    const wins = (await Promise.all([timed("a"), timed("b")])).filter(Boolean).length;
    assert.equal(wins, 1, `round ${round}: exactly one machine wins the launch claim`);
    assert.match((await ownerOf(key)) ?? "", new RegExp(`^${prefix}-[ab]-${round}$`), `round ${round}: the winner owns the job`);
  }
  const pingMs: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const ping = async () => {
      const started = performance.now();
      await db.execute(sql`select 1`);
      pingMs.push(performance.now() - started);
    };
    await Promise.all([ping(), ping()]);
  }
  const quantiles = (ms: number[]) => {
    const sorted = [...ms].sort((x, y) => x - y);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    return { median: at(0.5), p75: at(0.75), p95: at(0.95), max: at(1) };
  };
  const show = ({ median, p95, max }: ReturnType<typeof quantiles>) => `median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${max.toFixed(1)} ms`;
  const claims = quantiles(claimMs);
  const floor = quantiles(pingMs);
  console.log(`racing claims: ${claimMs.length} calls, ${show(claims)}`);
  console.log(`racing select 1, the network floor: ${pingMs.length} calls, ${show(floor)}`);
  // Against the floor, not a fixed budget: far from the database, a lost packet adds a ~200 ms TCP
  // retransmit to a tenth of the calls. A claim that waits on the other's lock slows half of them.
  assert.ok(claims.p75 <= floor.p75 + 25, "three in four racing claims cost one round trip, as select 1 does; the numbers are printed above");

  const full = `${prefix}-full`;
  await db.insert(jobs).values([
    linearJob(`${full}-busy`, `${full}-busy`, { stage: "implementing", machine_id: full, t3_thread_id: "thread-busy" }),
    linearJob(`${full}-next`, `${full}-next`),
  ]);
  assert.equal(await claimLaunch(`${full}-next`, "pending:1", slot(full)), false, "a machine at maxInFlight claims nothing");
  assert.equal(await ownerOf(`${full}-next`), null, "and the job stays free");
  assert.equal(await claimLaunch(`${full}-next`, "pending:1", slot(full, { maxInFlight: 2 })), true, "the same machine with room claims it");
  await db.update(jobs).set({ stage: "pr" }).where(eq(jobs.key, `${full}-busy`));
  await db.insert(jobs).values(linearJob(`${full}-after`, `${full}-after`));
  assert.equal(await claimLaunch(`${full}-after`, "pending:2", slot(full, { maxInFlight: 2 })), true, "a job in pr frees its slot");

  const elsewhere = `${prefix}-elsewhere`;
  await db.insert(jobs).values(linearJob(elsewhere, elsewhere, { repo: "ski043/other-repo" }));
  assert.equal(await claimLaunch(elsewhere, "pending:1", slot(`${prefix}-a`)), false, "a machine without the job's repo skips it");
  assert.equal(await claimLaunch(elsewhere, "pending:1", slot(`${prefix}-b`, { repos: [REPO, "ski043/other-repo"] })), true, "a machine with the repo claims it");
  assert.equal(await claimLaunch(elsewhere, "pending:2", slot(`${prefix}-c`, { repos: [] })), false, "a machine with no repos claims nothing");

  const theirs = `${prefix}-theirs`;
  await db.insert(jobs).values(
    linearJob(theirs, theirs, { stage: "failed", stage_event_id: `stop:${theirs}:1:x`, stage_summary: "Stopped.", t3_thread_id: "their-thread", machine_id: `${prefix}-other` }),
  );
  assert.deepEqual(await deliverStops(), [], "a stop owed to another machine's thread is left to that machine");
  assert.deepEqual(sent, [], "and nothing is sent from here");

  const pr = (n: number) => `https://github.com/ski043/factory-demo/pull/${900_000 + n}`;
  await db.insert(jobs).values([
    linearJob(`${prefix}-resume`, `${prefix}-resume`, { stage: "queued", pr_url: pr(1) }),
    linearJob(`${prefix}-their-pr`, `${prefix}-their-pr`, { stage: "pr", pr_url: pr(2), machine_id: `${prefix}-other`, t3_thread_id: "their-pr-thread" }),
    linearJob(`${prefix}-free-pr`, `${prefix}-free-pr`, { stage: "pr", pr_url: pr(3) }),
  ]);
  github.pullRequest = async (url) =>
    url === pr(3) ? { state: "open", mergeable: "conflicting", headSha: "h", title: "t" } : { state: "merged", mergeable: "unknown", headSha: "h", title: "t" };
  const checked = await checkPullRequests({ only: await ours() });
  const erroredKeys = checked.errors.map((e) => e.key);
  assert.ok(erroredKeys.includes(`${prefix}-resume`), "a merged PR of a job no machine holds is posted as merged (refused in test mode)");
  assert.ok(!erroredKeys.includes(`${prefix}-their-pr`), "another machine's PR is left to that machine");
  assert.deepEqual(checked.conflicts, [], "a conflicting PR of a job no machine holds is not sent back");
  assert.deepEqual(sent, [], "so no thread is messaged");

  const written: string[] = [];
  const linear = sourceFor("linear");
  linear.writeBack = async (job, transition) => (written.push(`${job.key}:${transition.stage}`), true);
  await db.update(jobs).set({ stage: "merged", stage_event_id: "e-merged" }).where(eq(jobs.key, `${prefix}-resume`));
  await db.update(jobs).set({ stage_event_id: "e-theirs" }).where(eq(jobs.key, `${prefix}-their-pr`));
  await writeBack({ only: await ours() });
  assert.ok(written.includes(`${prefix}-resume:merged`), "the merge of a job no machine holds reaches its source");
  assert.ok(!written.some((w) => w.startsWith(`${prefix}-their-pr:`)), "another machine's job is written back by that machine");

  await db.insert(jobs).values([
    linearJob(`${prefix}-wb-bad`, `${prefix}-wb-bad`, { stage: "failed", stage_event_id: "e-bad", machine_id: TEST_MACHINE_ID }),
    linearJob(`${prefix}-wb-good`, `${prefix}-wb-good`, { stage: "failed", stage_event_id: "e-good", machine_id: TEST_MACHINE_ID }),
  ]);
  linear.writeBack = async (job) => {
    if (job.key === `${prefix}-wb-bad`) throw new Error("Linear says the issue is gone");
    return true;
  };
  const failedPass = await writeBack({ only: await ours() });
  assert.deepEqual(failedPass.errors, [`${prefix}-wb-bad: Linear says the issue is gone`], "a failing write-back is reported, not thrown");
  const synced = async (key: string) => (await db.select().from(jobs).where(eq(jobs.key, key)))[0]!.synced_event_id;
  assert.equal(await synced(`${prefix}-wb-good`), "e-good", "and the job after it is still written back");
  assert.equal(await synced(`${prefix}-wb-bad`), null, "while the failed one stays unsynced for the next pass");
  const attempts: string[] = [];
  linear.writeBack = async (job) => {
    attempts.push(job.key);
    if (job.key === `${prefix}-wb-bad`) throw new SourceGoneError("Could not find referenced Issue.");
    return true;
  };
  const gonePass = await writeBack({ only: await ours() });
  assert.deepEqual(gonePass.gaveUp, [{ key: `${prefix}-wb-bad`, reason: "Could not find referenced Issue." }], "a transient error retried next pass, and a gone issue is given up on");
  assert.deepEqual(gonePass.errors, []);
  attempts.length = 0;
  const afterPass = await writeBack({ only: await ours() });
  assert.deepEqual([attempts, afterPass.gaveUp, afterPass.errors], [[], [], []], "a given-up job is not attempted again");
  assert.equal(await synced(`${prefix}-wb-bad`), "e-bad", "its event is recorded as synced");

  await db.insert(jobs).values([
    linearJob(`${prefix}-an-bad`, `${prefix}-an-bad`, { stage: "queued", machine_id: TEST_MACHINE_ID }),
    linearJob(`${prefix}-an-good`, `${prefix}-an-good`, { stage: "queued", machine_id: TEST_MACHINE_ID }),
  ]);
  const announced: string[] = [];
  linear.announceClaim = async (job) => {
    if (job.key === `${prefix}-an-bad`) throw new Error("no access");
    announced.push(job.key);
  };
  await assert.rejects(announceClaims(), /could not announce .*an-bad: no access/, "a failing announcement is reported");
  assert.ok(announced.includes(`${prefix}-an-good`), "and the job after it is still announced");

  await db.delete(jobs).where(eq(jobs.repo, REPO));
  await db.insert(jobs).values([
    linearJob(`${prefix}-queued`, `${prefix}-queued`),
    linearJob(`${prefix}-other-busy`, `${prefix}-other-busy`, { stage: "implementing", machine_id: `${prefix}-other` }),
  ]);
  const drafts = ["1", "2", "3"].map((d) => ({
    externalId: `${prefix}-${d}`,
    key: `${prefix}-${d}`,
    title: d,
    url: "u",
    description: null,
    writeback: { kind: "linear" as const, issueId: `${prefix}-${d}` },
    sourceState: { state: "Todo", labels: [] },
  }));
  const source = { source: "linear", ready: async () => drafts, overrides: () => NO_OVERRIDES } as unknown as Adapter;
  const maxInFlight = config.factory.maxInFlight;
  config.factory.maxInFlight = 2;
  const claimed = await claim({ sources: [source], repos: async () => [REPO], registry: async () => [] }).finally(() => (config.factory.maxInFlight = maxInFlight));
  assert.deepEqual(
    claimed.claimed,
    [`${prefix}-1`],
    "with maxInFlight 2 and one free queued job in its repo, a machine claims one more; another machine's work does not count",
  );

  const lease = `${prefix}-lease`;
  await db.insert(intents).values({ id: lease, kind: "stop", created_at: new Date() });
  const leases = await Promise.all([leaseIntent(lease, `${prefix}-a`), leaseIntent(lease, `${prefix}-b`)]);
  assert.equal(leases.filter(Boolean).length, 1, "two machines leasing at once: one gets it");
  const holder = leases[0] ? `${prefix}-a` : `${prefix}-b`;
  const other = leases[0] ? `${prefix}-b` : `${prefix}-a`;
  assert.equal(await leaseIntent(lease, other), false, "a live lease is not taken by another machine");
  assert.equal(await leaseIntent(lease, holder), false, "nor by its holder, whose earlier step may still be running");
  await db.update(intents).set({ lease_until: sql`now() - interval '1 second'` }).where(eq(intents.id, lease));
  assert.equal(await leaseIntent(lease, other), true, "an expired lease is retaken");
  assert.equal((await db.select().from(intents).where(eq(intents.id, lease)))[0]!.leased_by, other);
  await db.update(intents).set({ handled_at: new Date(), lease_until: null }).where(eq(intents.id, lease));
  assert.equal(await leaseIntent(lease, holder), false, "a handled intent is never leased");

  assert.equal(deliveryFor("claim", null, "a"), "lease");
  assert.equal(deliveryFor("claim", "b", "a"), "lease", "a claim goes to any machine");
  for (const kind of ["stop", "answer", "merged"] as const) {
    assert.equal(deliveryFor(kind, "a", "a"), "lease", `${kind} goes to the job's machine`);
    assert.equal(deliveryFor(kind, "b", "a"), "skip", `${kind} skips every other machine`);
    assert.equal(deliveryFor(kind, null, "a"), "lease", `${kind} for a job no machine holds goes to any machine`);
  }
  assert.equal(deliveryFor("recheck_conflicts", "b", "a"), "receipt", "a recheck is a broadcast");

  await db.delete(machines);
  const now = new Date();
  const machineRow = (id: string, lastSeen: Date) => ({ id, name: id, last_seen_at: lastSeen, heartbeat: {} });
  await db.insert(machines).values([machineRow(`${prefix}-a`, now), machineRow(`${prefix}-b`, now), machineRow(`${prefix}-gone`, new Date(Date.now() - 3_600_000))]);
  const broadcast = `${prefix}-broadcast`;
  await db.insert(intents).values({ id: broadcast, kind: "recheck_conflicts", created_at: now });
  const isOpen = async () => (await db.select().from(intents).where(eq(intents.id, broadcast)))[0]!.handled_at === null;
  assert.equal(await receiptIntent(broadcast, `${prefix}-a`), true, "machine a takes the broadcast");
  assert.equal(await receiptIntent(broadcast, `${prefix}-a`), false, "and a replay on machine a does not");
  await closeBroadcast(broadcast);
  assert.equal(await isOpen(), true, "the broadcast stays open while an online machine has no receipt");
  assert.equal(await receiptIntent(broadcast, `${prefix}-b`), true, "machine b takes it too");
  await closeBroadcast(broadcast);
  assert.equal(await isOpen(), false, "it closes once every online machine has a receipt; an offline one is not waited for");
  assert.deepEqual(
    (await db.select().from(intentReceipts).where(eq(intentReceipts.intent_id, broadcast))).map((r) => r.machine_id).sort(),
    [`${prefix}-a`, `${prefix}-b`],
    "one receipt per machine",
  );
  const handover = `${prefix}-handover`;
  await db.insert(intents).values({ id: handover, kind: "recheck_conflicts", created_at: new Date() });
  assert.equal(await receiptIntent(handover, `${prefix}-gone`), true, "a machine that is offline now took the broadcast earlier");
  assert.equal(await receiptIntent(handover, `${prefix}-a`), true);
  await closeBroadcast(handover);
  assert.equal(
    (await db.select().from(intents).where(eq(intents.id, handover)))[0]!.handled_at,
    null,
    "two receipts for two online machines, but one is the offline machine's: b has none, so it stays open",
  );
  await receiptIntent(handover, `${prefix}-b`);
  await closeBroadcast(handover);
  assert.notEqual((await db.select().from(intents).where(eq(intents.id, handover)))[0]!.handled_at, null, "it closes once every online machine has a receipt");

  const stale = `${prefix}-stale`;
  await db.insert(intents).values({ id: stale, kind: "recheck_conflicts", created_at: new Date(Date.now() - 11 * 60_000) });
  await closeBroadcast(stale);
  assert.notEqual((await db.select().from(intents).where(eq(intents.id, stale)))[0]!.handled_at, null, "an old broadcast expires without receipts");

  console.log("claim regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(intents).where(like(intents.id, `${prefix}%`));
  await db.delete(jobs).where(like(jobs.key, `${prefix}%`));
  await db.delete(machines).where(like(machines.id, `${prefix}%`));
  process.exit(process.exitCode ?? 0);
}
