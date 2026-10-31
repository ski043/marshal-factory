import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";
import type { MergeAssessment } from "../lib/assessment";

const { db } = await import("../db/client");
const { auditLog, events, jobEvidence, jobs, repoSettings, runs } = await import("../db/schema");
const { linearJob, usageRun } = await import("./fixtures");
const { jobId } = await import("../lib/sources/shapes");
const { SOURCES } = await import("../lib/sources");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { eventSchema } = await import("../lib/events");
const { ingest } = await import("../lib/ingest");
const { hosts } = await import("../lib/host");
const { github, mergeMethodOf, failedChecksOf, pullsClient } = await import("../lib/github/pulls");
const { DECISION_MARKER, prCommentBody, sourceCommentBody } = await import("../lib/merge-comments");
const { writeRepoAutonomy } = await import("../lib/settings");
const { decideMerges, RECHECK_MS } = await import("../runner/merge-decision");
const { revertDeps, watchMerges } = await import("../runner/post-merge");
const { runnerEventId } = await import("../lib/stages");
const { config, ingestClient, postMerged } = await import("../runner/ops");
const { serve } = await import("./serve");

const TOKEN = "ghs_regressionSecretToken0123456789";
const logged: string[] = [];
const log = console.log;
console.log = (...args: unknown[]) => (logged.push(args.map(String).join(" ")), log(...args));

const assessment: MergeAssessment = {
  recommendation: "merge",
  interpretation: "Sort the list by name.",
  assumptions: ["Case-insensitive, like the search box."],
  confidence: { confident: true },
  notes: "The sort order",
};

// --- pure helpers
assert.equal(mergeMethodOf({}), "squash", "a repo that hides its flags squashes");
assert.equal(mergeMethodOf({ allow_squash_merge: false, allow_merge_commit: true }), "merge", "else the first allowed method");
assert.equal(mergeMethodOf({ allow_squash_merge: false, allow_merge_commit: false, allow_rebase_merge: true }), "rebase");
const checkRun = (name: string, conclusion: string) => ({ name, status: "completed", conclusion });
assert.deepEqual(
  failedChecksOf([checkRun("build", "failure"), checkRun("Cursor Bugbot", "failure"), checkRun("lint", "success")], {
    state: "failure",
    total_count: 2,
    statuses: [
      { context: "ci/e2e", state: "error" },
      { context: "ci/ok", state: "success" },
    ],
  }),
  ["build", "ci/e2e"],
  "failed runs and statuses by name, Bugbot aside",
);
const base = { reasons: [], evaluatedAt: "2027-01-01T00:00:00.000Z", headSha: "h", headSeenAt: null, stageEventId: null };
assert.equal(prCommentBody({ ...base, outcome: "pending", autonomy: "auto" }, assessment), null, "pending says nothing");
assert.equal(prCommentBody({ ...base, outcome: "merge", autonomy: "auto" }, assessment), null, "an auto merge speaks once it merged");
assert.equal(sourceCommentBody({ ...base, outcome: "handover", autonomy: "off" }, "u"), null, "off says nothing");
assert.match(prCommentBody({ ...base, outcome: "handover", autonomy: "trial", reasons: ["A check failed."] }, null)!, /Would hand over \(trial\) because:\n\n- A check failed\./);

// --- fake GitHub
type Pull = {
  repo: string;
  number: number;
  heads: string[];
  base: string;
  title: string;
  state: "open" | "closed";
  merged: string | null;
  merge: (pull: Pull) => { status: number; body: unknown };
  branch?: string;
  mergedBy?: { login: string; type: string };
  files?: { filename: string; additions: number; deletions: number; patch?: string }[];
};
const pulls = new Map<string, Pull>();
const pullKey = (repo: string, n: number) => `${repo}#${n}`;
const repoFlags = new Map<string, Record<string, unknown>>();
const checksOf = new Map<string, { runs: { name: string; status: string; conclusion: string | null }[]; statuses: { context: string; state: string }[] }>();
const comments = new Map<string, { id: number; body: string }[]>();
const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
let nextComment = 1;
let nextPull = 900;
const head = (p: Pull) => p.heads[0]!;
const read = (p: Pull) => {
  const sha = head(p);
  if (p.heads.length > 1) p.heads.shift();
  return sha;
};
const pullJson = (p: Pull, sha: string) => ({
  state: p.state,
  merged_at: p.merged ? "2027-01-01T00:00:00Z" : null,
  closed_at: p.merged ? "2027-01-01T00:00:00Z" : null,
  head: { sha },
  base: { ref: p.base },
  mergeable: true,
  title: p.title,
  commits: 1,
  merged_by: p.merged ? (p.mergedBy ?? { login: "marshal-factory[bot]", type: "Bot" }) : null,
  html_url: `https://github.com/${p.repo}/pull/${p.number}`,
});
const merged = (sha: string) => (p: Pull) => (Object.assign(p, { state: "closed", merged: sha }), { status: 200, body: { sha } });

const server = await serve(0, async (request) => {
  const url = new URL(request.url);
  const path = url.pathname;
  const body = request.method === "GET" ? {} : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
  if (request.method !== "GET") writes.push({ method: request.method, path, body });
  let m: RegExpExecArray | null;
  if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(path))) return Response.json(repoFlags.get(m[1]!) ?? {});
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(path))) {
    if (request.method === "POST") {
      const p: Pull = { repo: m[1]!, number: nextPull++, heads: ["revert-head"], base: String(body.base), title: String(body.title), state: "open", merged: null, merge: merged("revert-merge"), branch: String(body.head) };
      pulls.set(pullKey(p.repo, p.number), p);
      return Response.json(pullJson(p, head(p)), { status: 201 });
    }
    const branch = url.searchParams.get("head")!.split(":")[1];
    return Response.json([...pulls.values()].filter((p) => p.repo === m![1] && p.branch === branch).map((p) => pullJson(p, head(p))));
  }
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)(\/files|\/merge)?$/.exec(path))) {
    const p = pulls.get(pullKey(m[1]!, Number(m[2])));
    if (!p) return Response.json({ message: "Not Found" }, { status: 404 });
    if (m[3] === "/files") return Response.json(p.files ?? [{ filename: "src/list.tsx", additions: 5, deletions: 1 }]);
    if (m[3] === "/merge") {
      const answer = p.merge(p);
      return Response.json(answer.body, { status: answer.status });
    }
    return Response.json(pullJson(p, read(p)));
  }
  if (/\/compare\//.test(path)) return Response.json({ behind_by: 7 });
  // The same scripts at every ref, so a PR's package.json edit is a dependency bump, not a check change.
  if (/^\/repos\/[^/]+\/[^/]+\/contents\/package\.json$/.test(path)) return Response.json({ content: Buffer.from(JSON.stringify({ scripts: { lint: "eslint" } })).toString("base64") });
  if ((m = /\/commits\/([^/]+)\/(check-runs|status)$/.exec(path))) {
    const checks = checksOf.get(m[1]!) ?? { runs: [checkRun("ci", "success"), checkRun("Cursor Bugbot", "neutral")], statuses: [] };
    if (m[2] === "check-runs") return Response.json({ total_count: checks.runs.length, check_runs: checks.runs });
    const state = checks.statuses.some((s) => s.state !== "success") ? "failure" : "success";
    return Response.json({ state, total_count: checks.statuses.length, statuses: checks.statuses });
  }
  if (path === "/graphql") return Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/events$/.exec(path))) {
    const p = pulls.get(pullKey(m[1]!, Number(m[2])));
    return Response.json(p?.merged ? [{ event: "labeled", commit_id: null }, { event: "merged", commit_id: p.merged }] : []);
  }
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(path))) {
    const list = comments.get(pullKey(m[1]!, Number(m[2]))) ?? [];
    if (request.method === "GET") return Response.json(list);
    list.push({ id: nextComment++, body: String(body.body) });
    comments.set(pullKey(m[1]!, Number(m[2])), list);
    return Response.json({}, { status: 201 });
  }
  if ((m = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(path))) {
    const comment = [...comments.values()].flat().find((c) => c.id === Number(m![1]));
    if (comment) comment.body = String(body.body);
    return Response.json({});
  }
  return Response.json({ message: `no fake for ${request.method} ${path}` }, { status: 500 });
});
Object.assign(github, pullsClient({ api: `http://localhost:${server.port}`, tokens: { get: async () => "ghs_api_stub", evict: () => {} } }));

// --- fake git host for reverts
type GitCall = { args: string[]; cwd?: string; env?: Record<string, string> };
const gitCalls: GitCall[] = [];
let parentsOf = (sha: string) => `${sha} p1`;
let failOn: string | null = null;
revertDeps.host = {
  t3: "t3",
  async run(command, args, options) {
    assert.equal(command, "git");
    gitCalls.push({ args, cwd: options?.cwd, env: options?.env });
    const verb = args.find((a) => !a.startsWith("-") && !a.includes("="));
    if (verb === failOn) throw Object.assign(new Error(`Command failed: git ${args.join(" ")}\nCONFLICT (content): Merge conflict in src/list.tsx`), { stderr: "CONFLICT" });
    if (args[0] === "rev-list") return { stdout: parentsOf(args.at(-1)!), stderr: "" };
    if (args[0] === "rev-parse") return { stdout: "revert-head\n", stderr: "" };
    return { stdout: "", stderr: "" };
  },
  readFile: async () => null,
  writeFile: async () => {},
  exists: async () => false,
  list: async () => [],
  mtimeMs: async () => 0,
  remove: async () => {},
};
revertDeps.token = async () => TOKEN;
revertDeps.checkout = async () => "/fake/checkout";
revertDeps.dir = "/fake/tmp";

// --- database
const stamp = Date.now() % 1_000_000;
const AUTO = `regress/auto-${stamp}`;
const MERGE_ONLY = `regress/auto-mc-${stamp}`;
const TRIAL = `regress/auto-trial-${stamp}`;
const OFF = `regress/auto-off-${stamp}`;
const keys: string[] = [];
const row = async (k: string) => (await db.select().from(jobs).where(eq(jobs.key, k)))[0]!;
const decision = async (k: string) => (await row(k)).merge_decision!;
const auditsOf = async (k: string) => db.select().from(auditLog).where(eq(auditLog.job_id, (await row(k)).id)).orderBy(auditLog.at);
const prUrl = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;
const putsTo = (repo: string, n: number) => writes.filter((w) => w.method === "PUT" && w.path === `/repos/${repo}/pulls/${n}/merge`);

/** The agent's evidence that the checks passed at this head. */
const verifiedAt = (k: string, sha: string) =>
  db.insert(jobEvidence).values({
    job_key: k,
    sha,
    attempt: 1,
    repo: "o/r",
    clean: true,
    producer: "agent",
    source: "package",
    checks: [{ name: "test", command: "bun run test", exitCode: 0, startedAt: new Date().toISOString(), durationMs: 900, outputTail: "", passed: true }],
    event_id: `auto-merge-evidence-${k}-${sha}`,
    recorded_at: new Date(),
  });

async function job(name: string, repo: string, n: number, pull: Partial<Pull> = {}) {
  const k = `AM${name}-${stamp}`;
  keys.push(k);
  pulls.set(pullKey(repo, n), { repo, number: n, heads: [`h${n}`], base: "main", title: `Title ${n}`, state: "open", merged: null, merge: merged(`m${n}`), ...pull });
  await db.insert(jobs).values(
    linearJob(`auto-merge-regress-${k}`, k, {
      machine_id: TEST_MACHINE_ID,
      repo,
      provider: "claudeAgent",
      stage: "pr",
      pr_url: prUrl(repo, n),
      stage_summary: "Sorted the list.",
      stage_event_id: `auto-merge-regress-pr-${k}`,
      merge_assessment: assessment,
    }),
  );
  for (const sha of pulls.get(pullKey(repo, n))!.heads) await verifiedAt(k, sha);
  await db.insert(runs).values(usageRun(k));
  return k;
}

ingestClient.post = async (event) => ingest(db, [eventSchema.parse(event)]);
hosts.wake = async (j) => {
  throw new Error(`woke ${j.key}`);
};
SOURCES.linear.labels = async () => ["factory"];
const notes: { key: string; id: string; body: string }[] = [];
SOURCES.linear.note = async (j, id, body) => void notes.push({ key: j.key, id, body });
const notesOf = (k: string) => notes.filter((n) => n.key === k).map((n) => n.body);
const NOW = 1_800_000_000_000;
const at = (minutes: number) => NOW + minutes * 60_000;

try {
  for (const [repo, autonomy] of [
    [AUTO, "auto"],
    [MERGE_ONLY, "auto"],
    [TRIAL, "trial"],
    [OFF, "off"],
  ] as const) {
    await writeRepoAutonomy(db, { repo, autonomy }, "owner@example.com", new Date());
  }
  repoFlags.set(MERGE_ONLY, { allow_squash_merge: false, allow_merge_commit: true, permissions: { push: true } });

  const GOOD = await job("GOOD", AUTO, 1);
  // The first read is the decision's, the second the one right before the merge.
  const STALE = await job("STALE", AUTO, 2, { heads: ["h2", "h2b"] });
  const ALREADY = await job("ALREADY", AUTO, 3, {
    merge: (p) => (Object.assign(p, { state: "closed", merged: "m3" }), { status: 405, body: { message: "Pull Request is not mergeable" } }),
  });
  const FORBIDDEN = await job("FORBIDDEN", AUTO, 4, { merge: () => ({ status: 403, body: { message: "Resource not accessible by integration" } }) });
  const MC = await job("MC", MERGE_ONLY, 5);
  const TRIALED = await job("TRIALED", TRIAL, 6);
  const OFFED = await job("OFFED", OFF, 7);
  const all = [GOOD, STALE, ALREADY, FORBIDDEN, MC, TRIALED, OFFED];

  const first = await decideMerges({ only: all, now: at(0) });
  assert.ok(Array.isArray(first), JSON.stringify(first));
  assert.deepEqual(
    [...first].sort(),
    [
      `${GOOD}:merge`,
      `${GOOD}:merged`,
      `${STALE}:merge`,
      `${ALREADY}:merge`,
      `${ALREADY}:merged`,
      `${FORBIDDEN}:merge`,
      `${FORBIDDEN}:handover`,
      `${MC}:merge`,
      `${MC}:merged`,
      `${TRIALED}:merge`,
      `${OFFED}:handover`,
    ].sort(),
  );

  // Auto + merge: one PUT pinned to the evaluated head, squash, the factory's title and body.
  assert.deepEqual(putsTo(AUTO, 1).map((w) => w.body), [
    { merge_method: "squash", sha: "h1", commit_title: "Title 1 (#1)", commit_message: "Sorted the list.\n\nMerged by the factory" },
  ]);
  assert.equal(putsTo(MERGE_ONLY, 5)[0]!.body.merge_method, "merge", "the first method the repo allows");
  assert.equal((await row(GOOD)).stage, "merged", "the merged flow runs");
  const good = await decision(GOOD);
  assert.deepEqual(good.merged, { sha: "m1", method: "squash", at: new Date(at(0)).toISOString(), base: "main", title: "Title 1", commits: 1, via: "auto" });
  assert.equal(good.watch!.state, "watching");
  assert.equal(good.watch!.until, new Date(at(config.factory.postMergeWatchMinutes)).toISOString());
  const goodAudits = (await auditsOf(GOOD)).sort((a, b) => a.action.localeCompare(b.action));
  assert.deepEqual(goodAudits.map((a) => [a.action, a.actor, a.result]), [["merge_decided", "factory", null], ["merge_succeeded", "factory", "ok"]]);
  assert.match(goodAudits[1]!.detail!, /^Merged by the factory as m1 \(squash\) via auto · Interpretation: Sort the list by name\. · Assumptions: Case-insensitive/);
  const goodComments = comments.get(pullKey(AUTO, 1))!;
  assert.equal(goodComments.length, 1);
  assert.ok(goodComments[0]!.body.startsWith(`${DECISION_MARKER}\n\n✅ Merged by the factory`), goodComments[0]!.body);
  assert.match(goodComments[0]!.body, /\*\*Assumptions I made\*\*\n\n- Case-insensitive/);
  assert.match(goodComments[0]!.body, /\*\*Confidence\*\*\n\nConfident it built what the issue asked for/);
  assert.deepEqual(notesOf(GOOD), [`Merged by the factory: ${prUrl(AUTO, 1)}`]);

  // A push between the decision and the merge aborts it; the next pass merges the new head.
  assert.equal(putsTo(AUTO, 2).length, 0, "stale head: no merge");
  assert.equal((await row(STALE)).stage, "pr");
  assert.equal(prCommentBody(await decision(STALE), assessment), null, "and no comment while it merges");

  // Already merged at that head counts as the factory's merge.
  assert.equal((await row(ALREADY)).stage, "merged");
  assert.equal((await decision(ALREADY)).merged!.sha, "m3");

  // No permission: one handover with a clear reason, one audit, no retry loop.
  const forbidden = await decision(FORBIDDEN);
  const reason = "The factory's GitHub App can't merge in this repo: Resource not accessible by integration";
  assert.deepEqual([forbidden.outcome, forbidden.reasons, forbidden.blocked], ["handover", [reason], "Resource not accessible by integration"]);
  assert.match(comments.get(pullKey(AUTO, 4))![0]!.body, /Ready for your review\n\n- The factory's GitHub App can't merge/);
  assert.match(comments.get(pullKey(AUTO, 4))![0]!.body, /Notes\*\*\n\nThe sort order/);

  // Trial and off never merge; trial comments.
  assert.equal(putsTo(TRIAL, 6).length + putsTo(OFF, 7).length, 0);
  assert.match(comments.get(pullKey(TRIAL, 6))![0]!.body, /Would merge \(trial\)/);
  assert.equal(comments.get(pullKey(OFF, 7)), undefined, "off posts nothing");
  assert.deepEqual(notesOf(OFFED), []);

  const second = await decideMerges({ only: all, now: at(2) });
  assert.deepEqual(second, [`${STALE}:merge`, `${STALE}:merged`], "only the moved head is merged again");
  assert.deepEqual(putsTo(AUTO, 2).map((w) => w.body.sha), ["h2b"]);
  await decideMerges({ only: all, now: at(2) + RECHECK_MS + 1 });
  assert.equal(putsTo(AUTO, 4).length, 1, "a refused head is never asked again");
  assert.deepEqual((await auditsOf(FORBIDDEN)).map((a) => a.detail).sort(), [`Hand over · ${reason}`, "Merging (auto)"]);
  assert.equal(putsTo(AUTO, 1).length, 1, "never double-merged");

  // Comments: created once, then the same comment edited when the decision changes.
  pulls.get(pullKey(TRIAL, 6))!.heads = ["h6b"];
  await verifiedAt(TRIALED, "h6b");
  checksOf.set("h6b", { runs: [checkRun("ci", "failure"), checkRun("Cursor Bugbot", "neutral")], statuses: [] });
  await decideMerges({ only: [TRIALED], now: at(30) });
  const trialComments = comments.get(pullKey(TRIAL, 6))!;
  assert.equal(trialComments.length, 1, "one comment per PR");
  assert.match(trialComments[0]!.body, /Would hand over \(trial\) because:\n\n- A check failed on the latest commit\./);
  assert.equal(writes.filter((w) => w.method === "PATCH").length, 1, "edited, not duplicated");
  assert.deepEqual(notesOf(TRIALED), [`Would merge (trial): ${prUrl(TRIAL, 6)}`, `Would hand over (trial): ${prUrl(TRIAL, 6)}\n\n- A check failed on the latest commit.`]);
  await decideMerges({ only: [TRIALED], now: at(31) + RECHECK_MS });
  assert.equal(notesOf(TRIALED).length, 2, "an unchanged decision posts nothing");
  assert.equal(writes.filter((w) => w.method === "PATCH" || (w.method === "POST" && w.path.endsWith("/comments"))).length, 7, "six PRs commented, one edit");

  // --- post-merge watch
  checksOf.set("m1", { runs: [checkRun("ci", "success")], statuses: [] });
  checksOf.set("m3", { runs: [{ name: "ci", status: "in_progress", conclusion: null }], statuses: [] });
  checksOf.set("m2", { runs: [checkRun("build", "failure")], statuses: [] });
  checksOf.set("m5", { runs: [checkRun("build", "failure"), checkRun("Cursor Bugbot", "failure")], statuses: [{ context: "ci/lint", state: "failure" }] });
  parentsOf = (sha) => (sha === "m5" ? `${sha} p1 p2` : `${sha} p1`);
  failOn = null;

  // Red on a merge commit: a revert PR, merged at once.
  const watched = await watchMerges({ only: [GOOD, ALREADY, MC], now: at(5) });
  assert.ok(Array.isArray(watched), JSON.stringify(watched));
  assert.deepEqual([...watched].sort(), [`${GOOD}:green`, `${MC}:reverted`].sort());
  assert.equal((await decision(GOOD)).watch!.state, "green");
  assert.equal((await decision(ALREADY)).watch!.state, "watching", "pending checks keep watching");
  const mc = (await decision(MC)).watch!;
  const revertPull = [...pulls.values()].find((p) => p.branch === "factory/revert-5")!;
  assert.deepEqual(mc, { state: "reverted", until: mc.until, failed: ["build", "ci/lint"], revertPr: prUrl(MERGE_ONLY, revertPull.number), reason: null });
  assert.equal(revertPull.title, 'Revert "Title 5" (#5)');
  const created = writes.find((w) => w.method === "POST" && w.path === `/repos/${MERGE_ONLY}/pulls`)!;
  assert.deepEqual([created.body.head, created.body.base], ["factory/revert-5", "main"]);
  assert.match(String(created.body.body), /- build\n- ci\/lint/);
  assert.deepEqual(putsTo(MERGE_ONLY, revertPull.number).map((w) => [w.body.sha, w.body.merge_method]), [["revert-head", "merge"]], "the revert merges at once");

  const dir = `/fake/tmp/marshal-factory-revert-${MERGE_ONLY.replace("/", "-")}-5`;
  const argv = gitCalls.map((c) => c.args.filter((a) => !a.startsWith("credential.helper=!")).join(" "));
  const expect = [
    `fetch origin main`,
    `worktree add -B factory/revert-5 ${dir} origin/main`,
    `rev-list --parents -n 1 m5`,
    `-c user.name=marshal-factory -c user.email=marshal-factory@users.noreply.github.com revert --no-edit -m 1 m5`,
    `rev-parse HEAD`,
    `-c credential.helper= -c push --force https://github.com/${MERGE_ONLY}.git HEAD:refs/heads/factory/revert-5`,
  ];
  let from = 0;
  for (const step of expect) {
    const found = argv.indexOf(step, from);
    assert.ok(found >= 0, `git ${step} in order: ${JSON.stringify(argv)}`);
    from = found + 1;
  }
  assert.ok(argv.slice(from).includes(`worktree remove --force ${dir}`), "the worktree is cleaned up");
  const push = gitCalls.find((c) => c.args.includes("push"))!;
  assert.deepEqual([push.cwd, push.env], [dir, { FACTORY_GIT_TOKEN: TOKEN, GIT_TERMINAL_PROMPT: "0" }], "the token goes in the push's env");
  assert.ok(gitCalls.filter((c) => c !== push).every((c) => !c.env), "and nowhere else");
  assert.ok(!gitCalls.some((c) => c.args.join(" ").includes(TOKEN)), "never in argv");
  assert.deepEqual(notesOf(MC).at(-1), `Reverted: main went red after merge — build, ci/lint. Revert: ${mc.revertPr}`);
  assert.match(comments.get(pullKey(MERGE_ONLY, 5))![0]!.body, new RegExp(`Reverted in ${mc.revertPr} after main went red: build, ci/lint\\.`));
  assert.match((await auditsOf(MC)).at(-1)!.detail!, /^Reverted after main went red · build, ci\/lint · https:/);

  // Pending past the window ends the watch without a verdict.
  assert.deepEqual(await watchMerges({ only: [ALREADY], now: at(config.factory.postMergeWatchMinutes + 1) }), [`${ALREADY}:expired`]);

  // A revert that fails stops there: surfaced once, never retried.
  failOn = "revert";
  gitCalls.length = 0;
  assert.deepEqual(await watchMerges({ only: [STALE], now: at(10) }), [`${STALE}:revert_failed`]);
  const failed = (await decision(STALE)).watch!;
  assert.equal(failed.state, "revert_failed");
  assert.match(failed.reason!, /^git revert failed: Command failed/);
  assert.ok(gitCalls.some((c) => c.args.join(" ") === "revert --abort"), "the revert is aborted");
  assert.ok(gitCalls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove"), "and the worktree removed");
  assert.ok(!gitCalls.some((c) => c.args.includes("push")), "nothing is pushed");
  assert.match(notesOf(STALE).at(-1)!, /^Main went red after the factory merged .* — build\. The revert failed, so revert it by hand: git revert failed/);
  gitCalls.length = 0;
  assert.deepEqual(await watchMerges({ only: [STALE, MC, GOOD], now: at(12) }), [], "an ended watch is not watched again");
  assert.equal(gitCalls.length, 0);

  // GitHub merges, then the factory loses the answer; checkPullRequests moves the job to merged
  // first. The intent stored before the call still records the merge and starts the watch.
  const lost = (sha: string, mergedBy?: Pull["mergedBy"]) => (p: Pull) => (Object.assign(p, { state: "closed", merged: sha, mergedBy }), { status: 500, body: { message: "Server Error" } });
  const CRASH = await job("CRASH", AUTO, 8, { merge: lost("m8") });
  const HUMAN = await job("HUMAN", AUTO, 9, { merge: lost("m9", { login: "someone", type: "User" }) });
  const crashed = await decideMerges({ only: [CRASH, HUMAN], now: at(40) });
  assert.ok(!Array.isArray(crashed) && crashed.errors.length === 2, JSON.stringify(crashed));
  assert.deepEqual((await decision(CRASH)).merging, { headSha: "h8", method: "squash", at: new Date(at(40)).toISOString(), via: "auto" }, "the intent is stored before the call");
  for (const r of [await row(CRASH), await row(HUMAN)]) await postMerged(r.key, r.pr_url!, r.session_id ?? runnerEventId("merged", r.external_id));
  assert.equal((await row(CRASH)).stage, "merged");
  assert.deepEqual(await decideMerges({ only: [CRASH, HUMAN], now: at(41) }), [`${CRASH}:merged`], "the lost merge is recorded");
  const recovered = await decision(CRASH);
  assert.deepEqual([recovered.merged?.sha, recovered.merged?.via, recovered.watch?.state, recovered.merging], ["m8", "auto", "watching", undefined], "recovered with the entry point its intent stored");
  const human = await decision(HUMAN);
  assert.deepEqual([human.merged, human.watch, human.merging], [undefined, undefined, undefined], "someone else's merge is not the factory's");
  assert.deepEqual(await decideMerges({ only: [CRASH, HUMAN], now: at(42) }), [], "recorded once");
  assert.equal((await auditsOf(CRASH)).filter((a) => a.action === "merge_succeeded").length, 1);
  assert.match(comments.get(pullKey(AUTO, 8))!.at(-1)!.body, /Merged by the factory/);
  checksOf.set("m8", { runs: [checkRun("ci", "success")], statuses: [] });
  assert.deepEqual(await watchMerges({ only: [CRASH], now: at(43) }), [`${CRASH}:green`], "and watched at stage merged");

  // A second attempt, 303 changed lines in a migration and a major bump, on a branch GitHub would call behind main: none hands over on its own.
  const LOOSE = await job("LOOSE", AUTO, 10, {
    files: [
      { filename: "drizzle/0042_big.sql", additions: 300, deletions: 2 },
      { filename: "package.json", additions: 1, deletions: 0, patch: '-    "next": "^15.0.0",\n+    "next": "^16.0.0",' },
    ],
  });
  await db.update(jobs).set({ attempt: 2 }).where(eq(jobs.key, LOOSE));
  await db.insert(runs).values(usageRun(LOOSE, undefined, undefined, 2));
  await db.update(jobEvidence).set({ attempt: 2 }).where(eq(jobEvidence.job_key, LOOSE));
  assert.deepEqual(await decideMerges({ only: [LOOSE], now: at(50) }), [`${LOOSE}:merge`, `${LOOSE}:merged`], JSON.stringify(await decision(LOOSE)));
  assert.deepEqual(putsTo(AUTO, 10).length, 1, "it merges");

  // The token never reached a log line or an error.
  assert.ok(!logged.some((l) => l.includes(TOKEN)), "no token in the logs");
  assert.ok(!JSON.stringify(await db.select().from(auditLog).where(inArray(auditLog.job_id, await Promise.all(keys.map(async (k) => (await row(k)).id))))).includes(TOKEN));

  console.log("auto-merge regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  const ids = (await db.select({ id: jobs.id }).from(jobs).where(like(jobs.id, `${jobId("linear", "auto-merge-regress-")}%`))).map((j) => j.id);
  if (ids.length > 0) await db.delete(auditLog).where(inArray(auditLog.job_id, ids));
  if (keys.length > 0) await db.delete(events).where(inArray(events.job_key, keys));
  if (keys.length > 0) await db.delete(jobEvidence).where(inArray(jobEvidence.job_key, keys));
  if (keys.length > 0) await db.delete(runs).where(inArray(runs.job_key, keys));
  await db.delete(jobs).where(like(jobs.id, `${jobId("linear", "auto-merge-regress-")}%`));
  await db.delete(repoSettings).where(inArray(repoSettings.repo, [AUTO, MERGE_ONLY, TRIAL, OFF]));
  await server.close();
  process.exit(process.exitCode ?? 0);
}
