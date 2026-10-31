import "./test-guard";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appCredentials, appJwt, installationTokens, readAppFile, tokenSource } from "../lib/github/app";
import { github, parsePullUrl, pullsClient } from "../lib/github/pulls";
import { serve } from "./serve";

const { privateKey: pem, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
assert.match(pem, /^-----BEGIN RSA PRIVATE KEY-----/, "the throwaway key is PKCS#1, like GitHub's");
const app = { id: 1, slug: "factory-stub", client_id: "Iv1.stub", pem, webhook_secret: "stub-webhook-secret" };

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
function verifiedClaims(jwt: string) {
  const [head, body, signature] = jwt.split(".");
  assert.ok(verify("sha256", Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature!, "base64url")), "the JWT verifies with the app's public key");
  return { header: decode(head!), claims: decode(body!) };
}

const nowMs = 1_800_000_000_000;
const { header, claims } = verifiedClaims(appJwt(app, nowMs));
assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
assert.deepEqual(appCredentials({ GITHUB_APP_ID: "5459681", GITHUB_APP_PRIVATE_KEY: "pem" }), { client_id: "5459681", pem: "pem" }, "Vercel signs with the env key");
assert.throws(() => appCredentials({ GITHUB_APP_PRIVATE_KEY: "pem" }), /GITHUB_APP_ID is not/, "a key without an app id is refused");
assert.deepEqual(claims, { iat: nowMs / 1000 - 60, exp: nowMs / 1000 + 540, iss: "Iv1.stub" }, "iat a minute back, exp inside ten minutes, iss the client id");

assert.deepEqual(parsePullUrl("https://github.com/ski043/factory-demo/pull/12"), { repo: "ski043/factory-demo", number: 12 });
assert.deepEqual(parsePullUrl("https://github.com/ski043/factory-demo/pull/12/files?w=1"), { repo: "ski043/factory-demo", number: 12 }, "a PR subpage still names the PR");
assert.throws(() => parsePullUrl("https://gitlab.com/a/b/pull/1"), /not a GitHub pull request URL/);

assert.throws(() => installationTokens.get("ski043/factory-demo"), /the GitHub App was called during a regression run/, "the real token source throws in test mode");
await assert.rejects(github.pullRequest("https://github.com/ski043/factory-demo/pull/1"), /regression run/, "so does the real client");

const corrupt = mkdtempSync(join(tmpdir(), "github-app-file-"));
try {
  const file = join(corrupt, "github-app.json");
  for (const text of ['{"pem": "-----BEGIN RSA PRIVATE KEY----- secret-key-body', JSON.stringify({ ...app, id: "secret-key-body" })]) {
    writeFileSync(file, text);
    assert.throws(
      () => readAppFile(file),
      (error: Error) => error.message === `${file} is not a valid GitHub App file; run bun scripts/setup-github-app.ts --force`,
      "a corrupt app file is named, never quoted",
    );
  }
} finally {
  rmSync(corrupt, { recursive: true, force: true });
}

let mints = 0;
let flakyInstallation = true;
const revoked = new Set<string>();
const seen: { method: string; path: string; auth: string | null; version: string | null; body: unknown }[] = [];
const pulls: Record<number, object> = {
  1: { state: "open", merged_at: null, closed_at: null, mergeable: null, head: { sha: "h1" }, title: "PR 1" },
  2: { state: "open", merged_at: null, closed_at: null, mergeable: false, head: { sha: "h2" }, title: "PR 2", html_url: "https://github.com/o/r/pull/2" },
  3: { state: "closed", merged_at: "2026-10-24T10:00:00Z", closed_at: "2026-10-24T10:00:00Z", mergeable: null, head: { sha: "h3" }, title: "PR 3", html_url: "https://github.com/o/r/pull/3" },
};
const stub = await serve(0, async (request) => {
    const url = new URL(request.url);
    const auth = request.headers.get("authorization");
    const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined);
    seen.push({ method: request.method, path: url.pathname + url.search, auth, version: request.headers.get("x-github-api-version"), body });
    const jwtOk = () => auth?.startsWith("Bearer ") && verifiedClaims(auth.slice(7)).claims.iss === app.client_id;
    if (url.pathname === "/app-manifests/good-code/conversions" && request.method === "POST") {
      return Response.json({ ...app, client_secret: "stub-client-secret", owner: { login: "ski043" } }, { status: 201 });
    }
    if (url.pathname === "/app/installations/7" && jwtOk()) return Response.json({ id: 7, app_id: app.id, account: { login: "ski043" } });
    if (url.pathname === "/repos/o/flaky/installation" && flakyInstallation) {
      flakyInstallation = false;
      return Response.json({ message: "Server Error" }, { status: 500 });
    }
    if (/^\/repos\/o\/(r|s|flaky)\/installation$/.test(url.pathname) && jwtOk()) return Response.json({ id: 7 });
    if (url.pathname === "/app/installations/7/access_tokens" && request.method === "POST" && jwtOk()) {
      mints++;
      return Response.json({ token: `ghs_stub${mints}`, expires_at: new Date(nowMs + 3_600_000).toISOString() }, { status: 201 });
    }
    if (url.pathname === "/repos/o/r/pulls" && url.searchParams.get("head") === "o:factory/FAC-1" && url.searchParams.get("state") === "all") {
      return Response.json([pulls[3], { ...pulls[2], state: "closed", closed_at: "2026-10-23T09:00:00Z" }]);
    }
    if (url.pathname === "/repos/o/r/pulls" && url.searchParams.get("head") === "o:factory/FAC-2" && url.searchParams.get("state") === "all") {
      return Response.json([pulls[3], pulls[2]]);
    }
    if (url.pathname === "/repos/o/r/pulls" && url.searchParams.get("head") === "o:factory/FAC-3") {
      return Response.json([{ ...pulls[2], state: "closed", closed_at: "2026-10-23T09:00:00Z" }]);
    }
    if (url.pathname === "/repos/o/r/pulls/6" || (url.pathname === "/repos/o/r/pulls/5" && revoked.has(auth!.slice(7)))) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    if (url.pathname === "/repos/o/r/pulls/5") return Response.json(pulls[1]);
    const merging = { allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false };
    if (url.pathname === "/repos/o/app-token") return Response.json({ ...merging, permissions: { admin: false, maintain: false, push: false, triage: false, pull: false } });
    if (url.pathname === "/repos/o/read-only") return Response.json({ ...merging, permissions: { admin: false, maintain: false, push: false, triage: true, pull: true } });
    if (url.pathname === "/repos/o/writer") return Response.json({ ...merging, permissions: { push: true, pull: true } });
    if (url.pathname === "/repos/o/no-permissions") return Response.json(merging);
    const pull = /^\/repos\/o\/r\/pulls\/(\d+)(\/merge)?$/.exec(url.pathname);
    if (pull && !pull[2]) return pulls[Number(pull[1])] ? Response.json(pulls[Number(pull[1])]) : Response.json({ message: "Not Found" }, { status: 404 });
    if (pull && request.method === "PUT") {
      const n = Number(pull[1]);
      if (n === 1) return Response.json({ sha: "merge-sha", merged: true, message: "Pull Request successfully merged" });
      if (n === 2) return Response.json({ message: "Pull Request is not mergeable" }, { status: 405 });
      if (n === 3) return Response.json({ message: "Head branch was modified. Review and try the merge again." }, { status: 409 });
      return Response.json({ message: "Validation Failed" }, { status: 422 });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
});
const api = `http://localhost:${stub.port}`;

try {
  let clock = nowMs;
  const minted: string[] = [];
  const tokens = tokenSource({ api, app: () => app, now: () => clock, onMint: (repo) => minted.push(repo) });
  const [a, b] = await Promise.all([tokens.get("o/r"), tokens.get("o/r")]);
  assert.deepEqual([a, b, mints], ["ghs_stub1", "ghs_stub1", 1], "concurrent callers share one mint");
  assert.equal(await tokens.get("o/r"), "ghs_stub1", "a fresh token comes from the cache");
  assert.deepEqual(seen.find((s) => s.path.endsWith("/access_tokens"))?.body, { repositories: ["r"] }, "the token is scoped to the one repo");
  assert.equal(await tokens.get("o/s"), "ghs_stub2", "another repo gets a token of its own");
  assert.deepEqual(seen.findLast((s) => s.path.endsWith("/access_tokens"))?.body, { repositories: ["s"] }, "scoped to that repo");
  assert.deepEqual([await tokens.get("o/r"), await tokens.get("o/s"), mints], ["ghs_stub1", "ghs_stub2", 2], "and each repo keeps its own cached token");
  clock = nowMs + 54 * 60_000;
  assert.equal(await tokens.get("o/r"), "ghs_stub1", "a token with six minutes left is still used");
  clock = nowMs + 56 * 60_000;
  assert.equal(await tokens.get("o/r"), "ghs_stub3", "a token with four minutes left is minted again");
  assert.deepEqual(minted, ["o/r", "o/s", "o/r"], "each mint is reported once");

  clock = nowMs;
  await assert.rejects(tokens.get("o/flaky"), /answered 500/, "a failed mint rejects");
  assert.equal(await tokens.get("o/flaky"), "ghs_stub4", "and is not cached: the next call mints again");
  let unreadable = true;
  const fromFile = tokenSource({
    api,
    app: () => {
      if (unreadable) throw new Error("no GitHub App at /nowhere");
      return app;
    },
    now: () => clock,
  });
  await assert.rejects(fromFile.get("o/r"), /no GitHub App/, "an unreadable app file rejects");
  unreadable = false;
  assert.equal(await fromFile.get("o/r"), "ghs_stub5", "and is not cached either");

  const live = pullsClient({ api, tokens });
  revoked.add("ghs_stub3");
  assert.equal((await live.pullRequest("https://github.com/o/r/pull/5")).headSha, "h1", "a 401 on a cached token is retried");
  assert.deepEqual([mints, await tokens.get("o/r")], [6, "ghs_stub6"], "with one fresh mint that replaces the refused token");
  await assert.rejects(live.pullRequest("https://github.com/o/r/pull/6"), /answered 401: Bad credentials/, "a second 401 throws");
  assert.equal(mints, 7, "after exactly one more mint");

  const client = pullsClient({ api, tokens: { get: async () => "ghs_stub", evict: () => {} } });
  const url = (n: number) => `https://github.com/o/r/pull/${n}`;
  assert.deepEqual(await client.pullRequest(url(1)), { state: "open", mergeable: "unknown", headSha: "h1", title: "PR 1" }, "null mergeable is unknown");
  assert.deepEqual(await client.pullRequest(url(2)), { state: "open", mergeable: "conflicting", headSha: "h2", title: "PR 2" }, "false mergeable is conflicting");
  assert.equal((await client.pullRequest(url(3))).state, "merged", "a closed PR with merged_at is merged");
  await assert.rejects(client.pullRequest(url(9)), /answered 404: Not Found/);
  assert.deepEqual(await client.repoMerging("o/app-token"), { method: "merge", canPush: true }, "every permission false, pull included, says nothing about an App token, which just read the repo");
  assert.deepEqual(await client.repoMerging("o/read-only"), { method: "merge", canPush: false }, "a token that reads but cannot push is refused before the merge");
  assert.deepEqual(await client.repoMerging("o/writer"), { method: "merge", canPush: true });
  assert.deepEqual(await client.repoMerging("o/no-permissions"), { method: "merge", canPush: true }, "no permissions object is no reason to refuse");
  const read = seen.find((s) => s.path === "/repos/o/r/pulls/1")!;
  assert.deepEqual([read.auth, read.version], ["Bearer ghs_stub", "2026-03-10"], "calls carry the installation token and the API version");

  assert.deepEqual(
    await client.pullsForHead("o/r", "factory/FAC-1"),
    [
      { state: "merged", headSha: "h3", mergedAt: new Date("2026-10-24T10:00:00Z"), closedAt: new Date("2026-10-24T10:00:00Z") },
      { state: "closed", headSha: "h2", mergedAt: null, closedAt: new Date("2026-10-23T09:00:00Z") },
    ],
  );

  assert.deepEqual(await client.pullRequestForBranch("o/r", "factory/FAC-2"), { url: url(2), state: "open" }, "an open PR wins over a merged one");
  assert.deepEqual(await client.pullRequestForBranch("o/r", "factory/FAC-1"), { url: url(3), state: "merged" }, "else the merged one; a closed one never counts");
  assert.equal(await client.pullRequestForBranch("o/r", "factory/FAC-3"), null, "a branch with only a closed PR has none");

  assert.deepEqual(await client.mergePull(url(1), "h1"), { kind: "merged", sha: "merge-sha" }, "200 is merged");
  assert.deepEqual(await client.mergePull(url(2), "h2"), { kind: "not_mergeable", message: "Pull Request is not mergeable" }, "405 is not mergeable");
  assert.equal((await client.mergePull(url(3), "stale")).kind, "head_moved", "409 is head moved");
  await assert.rejects(client.mergePull(url(4), "h4"), /answered 422/, "any other status throws");
  assert.deepEqual(seen.find((s) => s.method === "PUT")?.body, { merge_method: "squash", sha: "h1" }, "the merge pins the head and squashes");

  await setupScriptEndToEnd(api);
  console.log("github regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stub.close();
  process.exit(process.exitCode ?? 0);
}

async function setupScriptEndToEnd(api: string) {
  const dir = mkdtempSync(join(tmpdir(), "github-app-setup-"));
  const path = join(dir, "config/github-app.json");
  const port = 30_000 + Math.floor(Math.random() * 10_000);
  const child = spawn("bun", ["scripts/setup-github-app.ts", "--port", String(port), "--no-open"], {
    env: {
      ...process.env,
      GITHUB_URL: api,
      GITHUB_API_URL: api,
      MARSHAL_FACTORY_GITHUB_APP: path,
      NEON_FUNCTION_INGEST_BASE_URL: "https://ingest.invalid",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  try {
    const base = `http://localhost:${port}`;
    for (let i = 0; i < 50 && !output.includes("open "); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const page = await (await fetch(`${base}/`)).text();
    const action = /action="([^"]+)"/.exec(page)?.[1]?.replace(/&amp;/g, "&");
    const state = new URL(action!).searchParams.get("state");
    assert.equal(new URL(action!).pathname, "/settings/apps/new", "the form posts to GitHub's new-app page");
    const manifest = JSON.parse(
      /name="manifest" value="([^"]+)"/.exec(page)![1]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
    ) as Record<string, unknown>;
    assert.deepEqual(
      [manifest.name, manifest.public, manifest.hook_attributes, manifest.redirect_url, manifest.setup_url, manifest.default_events],
      ["marshal-factory-ski043", false, { url: "https://ingest.invalid/webhooks/github", active: true }, `${base}/callback`, `${base}/installed`, ["pull_request", "pull_request_review", "push", "issues"]],
    );
    assert.deepEqual(manifest.default_permissions, { metadata: "read", contents: "write", pull_requests: "write", checks: "write", issues: "write", statuses: "read" });

    assert.equal((await fetch(`${base}/callback?code=good-code&state=wrong`)).status, 400, "a wrong state is refused");
    assert.throws(() => statSync(path), "and stores nothing");
    const callback = await fetch(`${base}/callback?code=good-code&state=${state}`, { redirect: "manual" });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), `${api}/apps/factory-stub/installations/new`, "the callback sends the human on to install");
    assert.equal(statSync(path).mode & 0o777, 0o600, "the app file is created with mode 600");
    assert.equal((await fetch(`${base}/callback?code=good-code&state=${state}`)).status, 400, "the state works once");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), app, "it keeps the id, slug, client id, key and webhook secret, not the client secret");

    assert.equal((await fetch(`${base}/installed?installation_id=8`)).status, 500, "an installation the app cannot see is refused");
    // Loosened by hand: the update must write a fresh mode-600 file, not rewrite this one in place.
    chmodSync(path, 0o644);
    assert.equal((await fetch(`${base}/installed?installation_id=7`)).status, 200);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).installation_id, 7, "the installation id is recorded");
    assert.equal(statSync(path).mode & 0o777, 0o600, "the updated app file is mode 600 again");
    assert.deepEqual(readdirSync(join(dir, "config")), ["github-app.json"], "no temp file is left behind");
    assert.equal(await exited, 0, "the script exits once the app is installed");
    for (const secret of ["BEGIN", "stub-webhook-secret", "stub-client-secret", "good-code", "ghs_"]) {
      assert.ok(!output.includes(secret), `the setup output never shows ${secret}`);
    }
    assert.match(output, /stored GitHub App factory-stub \(id 1\)/);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}
