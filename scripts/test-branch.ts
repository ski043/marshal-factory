import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { z } from "zod";
import { endpointOf, TEST_BRANCH_ENV, TEST_ENDPOINT_ENV } from "../lib/test-mode";

const exec = promisify(execFile);
const EXPIRES_AFTER_MS = 2 * 3_600_000;
const scriptsDir = import.meta.dirname;
const contextFile = join(scriptsDir, "../.neon");
const project =
  process.env.NEON_PROJECT_ID ??
  (existsSync(contextFile) ? z.object({ projectId: z.string() }).parse(JSON.parse(readFileSync(contextFile, "utf8"))).projectId : undefined);
if (!project) throw new Error("set NEON_PROJECT_ID or run `neon set-context` so .neon names the project");

const neon = async (...args: string[]) =>
  (await exec("neon", [...args, "--project-id", project], { maxBuffer: 16 * 1024 * 1024 })).stdout;

const created = z.object({
  branch: z.object({ id: z.string(), name: z.string() }),
  endpoints: z.array(z.object({ id: z.string() })).min(1),
});

async function waitUntilReachable(url: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const client = new Client({ connectionString: url.replace("sslmode=require", "sslmode=verify-full") });
    try {
      await client.connect();
      await client.query("select 1");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  throw new Error("the test branch never became reachable");
}

function spawnInherit(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<number>((resolve) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    // A missing executable emits "error" and never "close"; without this the run hangs.
    child.on("error", (error) => {
      console.error(`${command}: ${error.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const only = process.argv.slice(2);
const scripts = readdirSync(scriptsDir)
  .filter((f) => f.endsWith("-regressions.ts") && (only.length === 0 || only.some((name) => f.startsWith(name))))
  .sort();
if (scripts.length === 0) throw new Error(`no regression script matches ${only.join(", ")}`);

const name = `test-regressions-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
const { branch, endpoints } = created.parse(
  JSON.parse(
    await neon(
      "branches", "create",
      "--name", name,
      "--expires-at", new Date(Date.now() + EXPIRES_AFTER_MS).toISOString(),
      "--output", "json",
    ),
  ),
);
console.log(`created test branch ${branch.id} (${branch.name}), expires in 2 h`);

let deleted = false;
async function deleteBranch() {
  if (deleted) return;
  deleted = true;
  await neon("branches", "delete", branch.id, "--output", "json");
  console.log(`deleted test branch ${branch.id}`);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void deleteBranch().finally(() => process.exit(130)));
}

const failed: string[] = [];
try {
  const urlFor = async (...flags: string[]) => (await neon("connection-string", branch.id, ...flags)).trim();
  const pooled = await urlFor("--pooled");
  const direct = await urlFor();
  await waitUntilReachable(direct);
  const env = {
    ...process.env,
    DATABASE_URL: pooled,
    DATABASE_URL_UNPOOLED: direct,
    NEON_BRANCH: branch.name,
    [TEST_BRANCH_ENV]: branch.id,
    [TEST_ENDPOINT_ENV]: endpointOf(direct),
  };
  if (endpointOf(direct) !== endpoints[0]!.id) throw new Error("the connection string is not for the branch's endpoint");
  // The branch copies the parent's schema; regressions run against this checkout's migrations.
  if ((await spawnInherit(process.execPath, ["x", "drizzle-kit", "migrate"], env)) !== 0) throw new Error("migrating the test branch failed");
  for (const script of scripts) {
    console.log(`\n== ${script}`);
    if ((await spawnInherit(process.execPath, [join("scripts", script)], env)) !== 0) failed.push(script);
  }
} finally {
  await deleteBranch();
}
console.log(failed.length ? `\nFAILED: ${failed.join(", ")}` : `\nall ${scripts.length} regression scripts passed`);
process.exit(failed.length ? 1 : 0);
