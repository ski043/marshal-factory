import { z } from "zod";
import type { ReviewComment } from "../inbox";
import { DEFAULT_NO_CI_GRACE_MS, type BugbotFinding, type BugbotReview, type ChangedFile, type CheckState, type MergeMethod } from "../merge-decision";
import { GITHUB_API, GitHubError, githubRequest, installationTokens, type RepoName, type TokenSource } from "./app";

export type PullState = "open" | "closed" | "merged";
export type Mergeable = "mergeable" | "conflicting" | "unknown";
export type PullRequest = { state: PullState; mergeable: Mergeable; headSha: string; title: string };
export type HeadPull = { state: PullState; headSha: string; mergedAt: Date | null; closedAt: Date | null };
export type BranchPull = { url: string; state: "open" | "merged" };
export type MergeResult =
  | { kind: "merged"; sha: string }
  | { kind: "not_mergeable"; message: string }
  | { kind: "head_moved"; message: string }
  | { kind: "forbidden"; message: string };
export type MergeOptions = { method?: MergeMethod; title?: string; message?: string };
/** What the factory's merge needs to know about the PR right before it merges. */
export type MergeCandidate = {
  state: PullState;
  headSha: string;
  baseRef: string;
  title: string;
  number: number;
  commits: number;
  mergeCommitSha: string | null;
  /** A GitHub App merged it; the factory's own merges are its App's. */
  mergedByBot: boolean;
};
export type RepoMerging = { method: MergeMethod; canPush: boolean };
export type CommentWrite = "created" | "updated" | "unchanged";

const PULL_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export function parsePullUrl(url: string): { repo: RepoName; number: number } {
  const match = PULL_URL.exec(url);
  if (!match) throw new Error(`${url} is not a GitHub pull request URL`);
  return { repo: match[1] as RepoName, number: Number(match[2]) };
}

const pullSchema = z.object({
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  head: z.object({ sha: z.string() }),
});

const stateOf = (pull: z.infer<typeof pullSchema>): PullState => (pull.merged_at ? "merged" : pull.state);

/** GitHub answers `mergeable: null` while it computes mergeability in the background. */
const mergeableOf = (mergeable: boolean | null): Mergeable =>
  mergeable === null ? "unknown" : mergeable ? "mergeable" : "conflicting";

const messageOf = (json: unknown) => z.object({ message: z.string() }).safeParse(json).data?.message ?? "";

export type PullDetail = { state: PullState; mergeable: Mergeable; headSha: string; baseRef: string };

const fileSchema = z.object({
  filename: z.string(),
  additions: z.number(),
  deletions: z.number(),
});

const checkRunSchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  app: z.object({ slug: z.string() }).nullable().optional(),
});
type CheckRun = z.infer<typeof checkRunSchema>;
const checkRunsSchema = z.object({ total_count: z.number(), check_runs: z.array(checkRunSchema) });
const combinedStatusSchema = z.object({ state: z.string(), total_count: z.number() });

const PASSING = new Set(["success", "neutral", "skipped"]);
/** Bugbot concludes neutral when it reviewed and posted findings, success when it found none. */
const BUGBOT_REVIEWED = new Set(["success", "neutral"]);
const isBugbot = (run: CheckRun) => /bugbot/i.test(run.name);

function bugbotReviewOf(runs: readonly CheckRun[]): BugbotReview {
  const bugbot = runs.filter(isBugbot);
  if (bugbot.length === 0 || bugbot.some((run) => run.status !== "completed")) return { state: "pending" };
  const failed = bugbot.find((run) => !BUGBOT_REVIEWED.has(run.conclusion ?? ""));
  return failed ? { state: "failed", conclusion: failed.conclusion ?? "no conclusion" } : { state: "reviewed" };
}

/**
 * What tells a commit nothing reported on from one whose CI has not started yet: when it was pushed,
 * the checks its base branch requires, and how long CI may take to show up.
 */
export type NoCiFacts = { pushedAt: number; now: number; graceMs: number; required: readonly string[] };

/**
 * Every check run and commit status on a commit, Bugbot's run aside. A commit nothing reported on
 * yet is pending: CI may not have started. It has none once it is older than the grace period and
 * its base branch requires no check. One GitHub listed more checks for than it returned is pending.
 */
export function checkStateOf(
  runs: readonly CheckRun[],
  status: z.infer<typeof combinedStatusSchema>,
  complete = true,
  noCi?: NoCiFacts,
): { checks: CheckState; bugbot: BugbotReview } {
  const others = runs.filter((run) => !isBugbot(run));
  const states: CheckState[] = others.map((run) =>
    run.status !== "completed" ? "pending" : PASSING.has(run.conclusion ?? "") ? "success" : "failure",
  );
  if (status.total_count > 0) states.push(status.state === "success" ? "success" : status.state === "pending" ? "pending" : "failure");
  if (!complete) states.push("pending");
  const unreported = states.length === 0 && noCi !== undefined && noCi.required.length === 0 && noCi.now - noCi.pushedAt >= noCi.graceMs;
  const checks: CheckState = states.includes("failure") ? "failure" : unreported ? "none" : states.length === 0 || states.includes("pending") ? "pending" : "success";
  return { checks, bugbot: bugbotReviewOf(runs) };
}

/** Whether no check but Bugbot's reported on the commit; only then is it worth asking whether the repo has CI. */
const nothingReported = (report: { runs: readonly CheckRun[]; status: { total_count: number }; complete: boolean }) =>
  report.complete && report.runs.every(isBugbot) && report.status.total_count === 0;

const branchProtectionSchema = z.object({
  protection: z
    .object({ required_status_checks: z.object({ contexts: z.array(z.string()).default([]), checks: z.array(z.object({ context: z.string() })).default([]) }).nullable().optional() })
    .optional(),
});
const branchRulesSchema = z.array(
  z.object({ type: z.string(), parameters: z.object({ required_status_checks: z.array(z.object({ context: z.string() })).optional() }).optional() }),
);

/** The status checks a branch's protection and its rulesets require, from what the App may read. */
export function requiredChecksOf(protection: unknown, rules: unknown): string[] {
  const required = branchProtectionSchema.safeParse(protection).data?.protection?.required_status_checks;
  const fromRules = (branchRulesSchema.safeParse(rules).data ?? []).filter((r) => r.type === "required_status_checks").flatMap((r) => r.parameters?.required_status_checks ?? []);
  return [...new Set([...(required?.contexts ?? []), ...(required?.checks ?? []).map((c) => c.context), ...fromRules.map((c) => c.context)])];
}

/** How checkState tells a repo without CI from CI that has not started; `seenAt` is when the factory first saw the head. Without `baseRef` it never says none. */
export type CheckStateOptions = { baseRef?: string; seenAt?: number; graceMs?: number; now?: number };

const statusesSchema = combinedStatusSchema.extend({ statuses: z.array(z.object({ context: z.string(), state: z.string() })).default([]) });

/** The names of the failed check runs and commit statuses on a commit, Bugbot's run aside. */
export function failedChecksOf(runs: readonly CheckRun[], status: z.infer<typeof statusesSchema>): string[] {
  const failedRuns = runs.filter((run) => !isBugbot(run) && run.status === "completed" && !PASSING.has(run.conclusion ?? "")).map((run) => run.name);
  const statuses = status.statuses.filter((s) => s.state === "failure" || s.state === "error").map((s) => s.context);
  return [...new Set([...failedRuns, ...statuses])];
}

const MERGE_METHOD_FLAGS = { squash: "allow_squash_merge", merge: "allow_merge_commit", rebase: "allow_rebase_merge" } as const;

/** Squash when the repo allows it, else the first method it allows; a repo that hides its flags gets squash. */
export function mergeMethodOf(repo: Partial<Record<(typeof MERGE_METHOD_FLAGS)[MergeMethod], boolean>>): MergeMethod {
  const allowed = (Object.keys(MERGE_METHOD_FLAGS) as MergeMethod[]).filter((m) => repo[MERGE_METHOD_FLAGS[m]] !== false);
  return allowed[0] ?? "squash";
}

const SEVERITY = /\*\*(High|Medium|Low) Severity\*\*/;
const BUGBOT_LOGIN = /^cursor(\[bot\])?$/;

const threadsSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          nodes: z.array(
            z.object({
              isResolved: z.boolean(),
              comments: z.object({ nodes: z.array(z.object({ author: z.object({ login: z.string() }).nullable(), body: z.string() })) }),
            }),
          ),
        }),
      }),
    }),
  }),
});

/** Bugbot's findings: its review threads, each with the severity its first comment states. */
export function bugbotFindingsOf(json: unknown): BugbotFinding[] {
  const { nodes } = threadsSchema.parse(json).data.repository.pullRequest.reviewThreads;
  return nodes.flatMap((thread) => {
    const first = thread.comments.nodes[0];
    const severity = first && BUGBOT_LOGIN.test(first.author?.login ?? "") ? SEVERITY.exec(first.body)?.[1] : undefined;
    return severity ? [{ severity: severity.toLowerCase() as BugbotFinding["severity"], resolved: thread.isResolved }] : [];
  });
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { author { login } body } } } }
    }
  }
}`;

const FILE_PAGES = 30;
const CHECK_PAGES = 10;

export function pullsClient({ api, tokens }: { api: string; tokens: TokenSource }) {
  // A cached token GitHub stops accepting (revoked, or the installation changed) is dropped and
  // minted again once; a second 401 is a real failure.
  async function request(repo: RepoName, method: string, path: string, options?: Parameters<typeof githubRequest>[4]) {
    const token = await tokens.get(repo);
    try {
      return await githubRequest(api, token, method, path, options);
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 401)) throw error;
      tokens.evict(repo, token);
      return githubRequest(api, await tokens.get(repo), method, path, options);
    }
  }

  /** Pages a commit list until it holds `total_count` items; `complete` is false when it never got there. */
  async function pages<T>(repo: RepoName, path: string, parse: (json: unknown) => { total: number; items: T[] }) {
    const items: T[] = [];
    let total = 0;
    for (let page = 1; page <= CHECK_PAGES; page++) {
      const batch = parse((await request(repo, "GET", `${path}?per_page=100&page=${page}`)).json);
      total = batch.total;
      items.push(...batch.items);
      if (items.length >= total || batch.items.length === 0) break;
    }
    return { items, complete: items.length >= total };
  }

  /** The commit a merged PR landed as, from its "merged" event; null when GitHub lists none. */
  async function mergedCommitOf(repo: RepoName, number: number): Promise<string | null> {
    const { json } = await request(repo, "GET", `/repos/${repo}/issues/${number}/events?per_page=100`);
    const events = z.array(z.object({ event: z.string(), commit_id: z.string().nullable().optional() })).parse(json);
    return events.findLast((e) => e.event === "merged")?.commit_id ?? null;
  }

  /** Every check run and commit status on a commit, all pages. */
  async function commitReport(repo: RepoName, sha: string) {
    let combined: z.infer<typeof statusesSchema> = { state: "pending", total_count: 0, statuses: [] };
    const [runs, statuses] = await Promise.all([
      pages(repo, `/repos/${repo}/commits/${sha}/check-runs`, (json) => {
        const { total_count, check_runs } = checkRunsSchema.parse(json);
        return { total: total_count, items: check_runs };
      }),
      pages(repo, `/repos/${repo}/commits/${sha}/status`, (json) => {
        combined = statusesSchema.parse(json);
        return { total: combined.total_count, items: combined.statuses };
      }),
    ]);
    return { runs: runs.items, status: { ...combined, statuses: statuses.items }, complete: runs.complete && statuses.complete };
  }

  /** The checks the base branch requires. Branch protection and rulesets the App can't read (403, 404) count as requiring none. */
  async function requiredStatusChecks(repo: RepoName, baseRef: string) {
    const branch = encodeURIComponent(baseRef);
    const [protection, rules] = await Promise.all([
      request(repo, "GET", `/repos/${repo}/branches/${branch}`, { allow: [403, 404] }),
      request(repo, "GET", `/repos/${repo}/rules/branches/${branch}`, { allow: [403, 404] }),
    ]);
    return requiredChecksOf(protection.status === 200 ? protection.json : null, rules.status === 200 ? rules.json : null);
  }

  /** When the commit was made, or when the factory first saw it if that is later, since a pushed commit can be older than its push. */
  async function pushedAt(repo: RepoName, sha: string, seenAt: number | undefined) {
    const { json } = await request(repo, "GET", `/repos/${repo}/git/commits/${sha}`);
    const committed = Date.parse(z.object({ committer: z.object({ date: z.string() }) }).parse(json).committer.date);
    return Math.max(committed, seenAt ?? 0);
  }

  return {
    async pullRequest(url: string): Promise<PullRequest> {
      const { repo, number } = parsePullUrl(url);
      const { json } = await request(repo, "GET", `/repos/${repo}/pulls/${number}`);
      const pull = pullSchema.extend({ mergeable: z.boolean().nullable(), title: z.string() }).parse(json);
      return { state: stateOf(pull), mergeable: mergeableOf(pull.mergeable), headSha: pull.head.sha, title: pull.title };
    },

    async pullsForHead(repo: RepoName, branch: string): Promise<HeadPull[]> {
      const query = new URLSearchParams({ head: `${repo.split("/")[0]}:${branch}`, state: "all", per_page: "100" });
      const { json } = await request(repo, "GET", `/repos/${repo}/pulls?${query}`);
      return z
        .array(pullSchema)
        .parse(json)
        .map((pull) => ({
          state: stateOf(pull),
          headSha: pull.head.sha,
          mergedAt: pull.merged_at ? new Date(pull.merged_at) : null,
          closedAt: pull.closed_at ? new Date(pull.closed_at) : null,
        }));
    },

    /** The branch's open PR, else its latest merged one; null when it has neither. */
    async pullRequestForBranch(repo: RepoName, branch: string): Promise<BranchPull | null> {
      const query = new URLSearchParams({ head: `${repo.split("/")[0]}:${branch}`, state: "all", per_page: "100" });
      const { json } = await request(repo, "GET", `/repos/${repo}/pulls?${query}`);
      const pulls = z
        .array(pullSchema.extend({ html_url: z.string() }))
        .parse(json)
        .map((pull) => ({ url: pull.html_url, state: stateOf(pull), mergedAt: pull.merged_at ?? "" }));
      const open = pulls.find((p) => p.state === "open");
      if (open) return { url: open.url, state: "open" };
      const merged = pulls.filter((p) => p.state === "merged").sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))[0];
      return merged ? { url: merged.url, state: "merged" } : null;
    },

    async pullDetail(url: string): Promise<PullDetail> {
      const { repo, number } = parsePullUrl(url);
      const { json } = await request(repo, "GET", `/repos/${repo}/pulls/${number}`);
      const pull = pullSchema.extend({ mergeable: z.boolean().nullable(), base: z.object({ ref: z.string() }) }).parse(json);
      return { state: stateOf(pull), mergeable: mergeableOf(pull.mergeable), headSha: pull.head.sha, baseRef: pull.base.ref };
    },

    /** A file's text at a branch or commit, or null when it has none there. */
    async fileAt(repo: RepoName, path: string, ref: string): Promise<string | null> {
      const { status, json } = await request(repo, "GET", `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, { allow: [404] });
      if (status === 404) return null;
      return Buffer.from(z.object({ content: z.string() }).parse(json).content, "base64").toString("utf8");
    },

    async pullFiles(url: string): Promise<ChangedFile[]> {
      const { repo, number } = parsePullUrl(url);
      const files: ChangedFile[] = [];
      for (let page = 1; page <= FILE_PAGES; page++) {
        const { json } = await request(repo, "GET", `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
        const batch = z.array(fileSchema).parse(json);
        files.push(
          ...batch.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions })),
        );
        if (batch.length < 100) break;
      }
      return files;
    },

    async checkState(repo: RepoName, sha: string, { baseRef, seenAt, graceMs = DEFAULT_NO_CI_GRACE_MS, now = Date.now() }: CheckStateOptions = {}) {
      const report = await commitReport(repo, sha);
      // Without the base branch its required checks are unknown, so an empty report stays pending.
      if (!nothingReported(report) || !baseRef) return checkStateOf(report.runs, report.status, report.complete);
      const [pushed, required] = await Promise.all([pushedAt(repo, sha, seenAt), requiredStatusChecks(repo, baseRef)]);
      return checkStateOf(report.runs, report.status, report.complete, { pushedAt: pushed, now, graceMs, required });
    },

    /** Whether Bugbot has a check run on the PR's head, in any state. */
    async bugbotRan(url: string): Promise<boolean> {
      const { repo, number } = parsePullUrl(url);
      const { json } = await request(repo, "GET", `/repos/${repo}/pulls/${number}`);
      const head = pullSchema.parse(json).head.sha;
      return (await commitReport(repo, head)).runs.some(isBugbot);
    },

    async bugbotFindings(url: string): Promise<BugbotFinding[]> {
      const { repo, number } = parsePullUrl(url);
      const [owner, name] = repo.split("/");
      const { json } = await request(repo, "POST", "/graphql", { body: { query: THREADS_QUERY, variables: { owner, name, number } } });
      const errors = z.object({ errors: z.array(z.object({ message: z.string() })) }).safeParse(json);
      if (errors.success) throw new Error(`GitHub GraphQL: ${errors.data.errors.map((e) => e.message).join("; ")}`);
      return bugbotFindingsOf(json);
    },

    /** `sha` pins the head, so a push since the decision makes GitHub refuse the merge. */
    async mergePull(url: string, headSha: string, { method = "squash", title, message }: MergeOptions = {}): Promise<MergeResult> {
      const { repo, number } = parsePullUrl(url);
      const { status, json } = await request(repo, "PUT", `/repos/${repo}/pulls/${number}/merge`, {
        body: { merge_method: method, sha: headSha, ...(title && { commit_title: title }), ...(message && { commit_message: message }) },
        allow: [403, 404, 405, 409],
      });
      if (status === 403 || status === 404) return { kind: "forbidden", message: messageOf(json) || `GitHub answered ${status}` };
      if (status === 405) return { kind: "not_mergeable", message: messageOf(json) };
      if (status === 409) return { kind: "head_moved", message: messageOf(json) };
      return { kind: "merged", sha: z.object({ sha: z.string() }).parse(json).sha };
    },

    async mergeCandidate(url: string): Promise<MergeCandidate> {
      const { repo, number } = parsePullUrl(url);
      const { json } = await request(repo, "GET", `/repos/${repo}/pulls/${number}`);
      const pull = pullSchema
        .extend({
          base: z.object({ ref: z.string() }),
          title: z.string(),
          commits: z.number().int(),
          // API version 2026-03-10 dropped it; a merged PR's "merged" event still carries the commit.
          merge_commit_sha: z.string().nullish(),
          merged_by: z.object({ login: z.string(), type: z.string() }).nullable().optional(),
        })
        .parse(json);
      const state = stateOf(pull);
      return {
        state,
        headSha: pull.head.sha,
        baseRef: pull.base.ref,
        title: pull.title,
        number,
        commits: Math.max(1, pull.commits),
        mergeCommitSha: state === "merged" ? (pull.merge_commit_sha ?? (await mergedCommitOf(repo, number))) : null,
        mergedByBot: pull.merged_by?.type === "Bot",
      };
    },

    /** The merge method to use, and whether the token may push at all, a cheap probe before a merge. */
    async repoMerging(repo: RepoName): Promise<RepoMerging> {
      const { json } = await request(repo, "GET", `/repos/${repo}`);
      const flags = z
        .object({
          allow_squash_merge: z.boolean().optional(),
          allow_merge_commit: z.boolean().optional(),
          allow_rebase_merge: z.boolean().optional(),
          permissions: z.object({ push: z.boolean().optional(), pull: z.boolean().optional() }).optional(),
        })
        .parse(json);
      // GitHub can answer an installation token's read with every permission false, pull included,
      // though the token just read the repo: such an object says nothing about the token, whose
      // contents grant is what a merge needs. A merge it cannot make is refused, and handed over, then.
      const describesToken = flags.permissions?.pull !== false;
      return { method: mergeMethodOf(flags), canPush: !describesToken || flags.permissions?.push !== false };
    },

    /** The commit's checks with the names of those that failed, Bugbot's run aside. */
    async commitChecks(repo: RepoName, sha: string): Promise<{ checks: CheckState; failed: string[] }> {
      const { runs, status, complete } = await commitReport(repo, sha);
      return { checks: checkStateOf(runs, status, complete).checks, failed: failedChecksOf(runs, status) };
    },

    /** Creates or edits the one comment on the PR that carries `marker`, so a decision is never posted twice. */
    async upsertComment(url: string, marker: string, body: string): Promise<CommentWrite> {
      const { repo, number } = parsePullUrl(url);
      const commentSchema = z.array(z.object({ id: z.number(), body: z.string().nullable().optional() }));
      for (let page = 1; page <= FILE_PAGES; page++) {
        const { json } = await request(repo, "GET", `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
        const batch = commentSchema.parse(json);
        const ours = batch.find((c) => c.body?.includes(marker));
        if (ours) {
          if (ours.body === body) return "unchanged";
          await request(repo, "PATCH", `/repos/${repo}/issues/comments/${ours.id}`, { body: { body } });
          return "updated";
        }
        if (batch.length < 100) break;
      }
      await request(repo, "POST", `/repos/${repo}/issues/${number}/comments`, { body: { body } });
      return "created";
    },

    /** Closes the PR unmerged; closing one already closed changes nothing. */
    async closePull(url: string): Promise<void> {
      const { repo, number } = parsePullUrl(url);
      await request(repo, "PATCH", `/repos/${repo}/pulls/${number}`, { body: { state: "closed" } });
    },

    /** The inline comments of one review, in the order GitHub lists them. */
    async reviewComments(url: string, reviewId: number): Promise<ReviewComment[]> {
      const { repo, number } = parsePullUrl(url);
      const { json } = await request(repo, "GET", `/repos/${repo}/pulls/${number}/reviews/${reviewId}/comments?per_page=100`);
      return z
        .array(z.object({ path: z.string(), line: z.number().nullable().optional(), original_line: z.number().nullable().optional(), body: z.string() }))
        .parse(json)
        .map((c) => ({ path: c.path, line: c.line ?? c.original_line ?? null, body: c.body }));
    },

    /** Opens a PR, or returns the open one GitHub already has for the branch. */
    async createPull(repo: RepoName, pull: { title: string; head: string; base: string; body: string }): Promise<{ url: string }> {
      const { status, json } = await request(repo, "POST", `/repos/${repo}/pulls`, { body: pull, allow: [422] });
      if (status !== 422) return { url: z.object({ html_url: z.string() }).parse(json).html_url };
      const query = new URLSearchParams({ head: `${repo.split("/")[0]}:${pull.head}`, state: "open" });
      const existing = z.array(z.object({ html_url: z.string() })).parse((await request(repo, "GET", `/repos/${repo}/pulls?${query}`)).json)[0];
      if (!existing) throw new GitHubError(`GitHub POST /repos/${repo}/pulls answered 422: ${messageOf(json)}`, 422);
      return { url: existing.html_url };
    },
  };
}

export type PullsClient = ReturnType<typeof pullsClient>;

export const github: PullsClient = pullsClient({ api: GITHUB_API, tokens: installationTokens });
