import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./harness";
import { pricingSchema } from "./pricing";
import { inTestMode } from "./test-mode";

export const CONFIG_PATH = process.env.MARSHAL_FACTORY_CONFIG ?? join(homedir(), ".config/marshal-factory/config.json");

/** The machine a regression run's runner code acts as, so the jobs a script creates can belong to it. */
export const TEST_MACHINE_ID = "test-machine";

/** The Modal image runners launch sandboxes from; scripts/sandbox-image.ts writes it. */
export const SANDBOX_IMAGE_PATH = process.env.MARSHAL_FACTORY_SANDBOX_IMAGE ?? join(dirname(CONFIG_PATH), "sandbox-image.json");

export const GITHUB_APP_PATH = process.env.MARSHAL_FACTORY_GITHUB_APP ?? join(homedir(), ".config/marshal-factory/github-app.json");

const home = (path: string) => path.replace(/^~(?=\/|$)/, homedir());

/** Modal sandboxes, used when the panel's settings say jobs run on Modal. */
export const sandboxSchema = z
  .object({
    appName: z.string().default("marshal-factory"),
    /** What the sandbox image installs; a runner launches nothing from an image built with other versions. */
    t3Version: z.string().default("0.1.3-nightly.20261023.3566"),
    claudeCodeVersion: z.string().default("2.1.310"),
    codexVersion: z.string().default("0.164.0"),
    playwrightMcpVersion: z.string().default("0.0.83"),
    /** The PStack marketplace repo at a commit; version is the plugin version that commit declares. */
    pstack: z
      .object({
        repo: z.string().default("michael-denyer/pstack-claude"),
        commit: z.string().regex(/^[0-9a-f]{40}$/).default("614d2f9791ddf73e0654c9be5a42c5a48d8f5ba0"),
        version: z.string().default("0.9.69"),
      })
      .prefault({}),
    /** Cores and MiB a sandbox reserves, and the most it may burst to. */
    cpu: z.number().positive().default(1),
    cpuLimit: z.number().positive().default(2),
    memoryMiB: z.number().int().positive().default(2048),
    memoryLimitMiB: z.number().int().positive().default(8192),
    /** The hard cap on a sandbox's life; one that hits it is gone, and its job follows the gone-thread rules. */
    timeoutMs: z.number().int().positive().default(4 * 3_600_000),
    /** How long a job waiting in pr or waiting keeps its sandbox running once its thread settles. */
    hibernateAfterMinutes: z.number().nonnegative().default(5),
    /** How long a hibernated sandbox's snapshot lives; a job still waiting after that has a gone thread. */
    snapshotTtlDays: z.number().positive().default(30),
    /** CODEX_HOME dirs on this machine, each with its own ChatGPT login; a sandbox running Codex holds one at a time. */
    codexSlots: z.array(z.string().transform(home)).default(["~/.codex-factory-1"].map(home)),
    maxParallel: z.number().int().positive().default(4),
    /** The Codex model a Claude Code job falls back to when this runner has no Claude token. */
    codexModel: z.string().default("gpt-6-astra"),
  })
  .prefault({});
export type SandboxLimits = z.infer<typeof sandboxSchema>;

/** Every factory limit lives here, with defaults; the config file overrides any of them. */
export const factorySchema = z
  .object({
    teamKey: z.string().default("FAC"),
    label: z.string().default("factory"),
    maxInFlight: z.number().int().positive().default(4),
    /** A working job with no event for this long, or whose thread stopped, gets one nudge. */
    stuckAfterMinutes: z.number().positive().default(30),
    /** A stopped thread counts as stuck only after this much quiet, so a turn that just ended isn't. */
    stoppedGraceMinutes: z.number().nonnegative().default(2),
    /** After a nudge, this much more quiet marks the job failed. */
    failAfterNudgeMinutes: z.number().positive().default(30),
    /** USD per million tokens by model id, over lib/pricing.ts's defaults; null makes a model's cost unknown. The runner's spend reconcile uses it; the panel shows the defaults. */
    pricing: pricingSchema.default({}),
    /** Days a failed job keeps its worktree for a human to look at before cleanup removes it. */
    cleanupGraceDays: z.number().nonnegative().default(3),
    /** Minutes a PR head with no check run and no status waits for CI to show up before the repo counts as having none; also how long onboarding waits for Bugbot on the recipe PR. */
    noCiGraceMinutes: z.number().nonnegative().default(5),
    /** How long the runner watches the base branch's checks after it merged a PR, reverting when they fail. */
    postMergeWatchMinutes: z.number().positive().default(60),
    /** Hours a Claude Code subagent worktree must sit untouched before cleanup considers it. */
    subagentIdleHours: z.number().nonnegative().default(6),
    /** Target repos the factory works in; the installer adds each one. */
    repos: z.array(z.string()).default([]),
    /** The provider and model for new factory threads when the panel's settings hold none. */
    provider: z.string().default(DEFAULT_PROVIDER),
    model: z.string().default(DEFAULT_MODEL),
    /** How often the runner's timer runs the watchdog and usage reconcile. */
    tickSeconds: z.number().positive().default(90),
    /** Overrides this machine's IOPlatformUUID (macOS) or /etc/machine-id (Linux) as its id in the machines table, so test runners keep their own row. */
    machineId: z.string().min(1).optional(),
    /** T3's state database, read-only, for the machine inventory. */
    t3StatePath: z.string().optional(),
    /** How often the runner re-collects the slow machine inventory (T3, Connect, projects, repos). */
    inventoryMinutes: z.number().positive().default(10),
    /** Ids of the webhooks scripts/install-webhooks.ts created. It records `linear`; GitHub deliveries come from the GitHub App. */
    webhooks: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
    /** Whether the runner creates missing Harness and Runs on label groups in the team, about once a day. */
    syncLinearLabels: z.boolean().default(false),
    /** How a stop is confirmed; see lib/stop.ts. The runner looks on its tick, so each wait rounds up to tickSeconds. */
    stop: z
      .object({
        /** The least time between two looks at a stopping thread. */
        checkSeconds: z.number().positive().default(15),
        /** How long the thread and its subagents must show no active run before the stop counts as confirmed. */
        settleSeconds: z.number().nonnegative().default(30),
        /** How long after the stop message the runner asks T3 to interrupt what still runs. */
        interruptAfterSeconds: z.number().nonnegative().default(60),
        /** How long after the stop message a stop that still isn't confirmed is marked unconfirmed for the owner. */
        giveUpAfterMinutes: z.number().positive().default(5),
      })
      .prefault({}),
    sandbox: sandboxSchema,
  })
  .prefault({});
export type FactoryLimits = z.infer<typeof factorySchema>;

const configSchema = z.object({
  linearApiKey: z.string().min(1),
  ingestUrl: z.url(),
  secret: z.string().min(1),
  factory: factorySchema,
});
export type FactoryConfig = z.infer<typeof configSchema>;

/** Just the limits, for readers that hold no secrets, such as the sandbox image build. */
export function loadLimits(): FactoryLimits {
  const raw = existsSync(/* turbopackIgnore: true */ CONFIG_PATH) ? JSON.parse(readFileSync(/* turbopackIgnore: true */ CONFIG_PATH, "utf8")).factory : undefined;
  return factorySchema.parse(raw ?? {});
}

export function loadConfig(): FactoryConfig {
  if (inTestMode()) {
    return configSchema.parse({
      linearApiKey: "test-only",
      ingestUrl: "https://ingest.invalid/ingest",
      secret: "test-only",
      factory: { machineId: TEST_MACHINE_ID },
    });
  }
  return configSchema.parse(JSON.parse(readFileSync(/* turbopackIgnore: true */ CONFIG_PATH, "utf8")));
}
