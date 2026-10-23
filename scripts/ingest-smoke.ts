export {};

// Exercises the deployed ingest function: idempotency, out-of-order delivery, auth, validation.
process.loadEnvFile(".env.local");

const base = process.env.NEON_FUNCTION_INGEST_BASE_URL!.replace(/\/$/, "");
const secret = process.env.FACTORY_INGEST_SECRET!;
const run = `smoke-${Date.now()}`;
const t0 = Date.now() - 60_000;
const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, model: "claude-sonnet-5-5" };

const post = (body: unknown, token = secret) =>
  fetch(`${base}/ingest`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const common = { sessionId: run };
const batch = [
  { ...common, eventId: `${run}-1`, kind: "session_start", at: t0, cwd: "/tmp/x", branch: "factory/LIN-9", repo: "x" },
  { ...common, eventId: `${run}-2`, kind: "agent_start", at: t0 + 1000, toolUseId: `${run}-tu1`, subagentType: "general-purpose", description: "list files" },
];

for (const attempt of [1, 2]) {
  const res = await post(batch);
  console.log(`batch attempt ${attempt}:`, res.status, await res.text());
}

// agent_stop and agent_launched arrive before agent_start / session_start of a second agent.
const agent2 = [
  { ...common, eventId: `${run}-4`, kind: "agent_stop", at: t0 + 5000, agentId: `${run}-a2`, status: "completed", usage },
  { ...common, eventId: `${run}-5`, kind: "agent_launched", at: t0 + 5100, toolUseId: `${run}-tu2`, agentId: `${run}-a2` },
  { ...common, eventId: `${run}-3`, kind: "agent_start", at: t0 + 2000, toolUseId: `${run}-tu2`, subagentType: "Explore", description: "late start" },
];
const res = await post(agent2);
console.log("out-of-order:", res.status, await res.text());

const bad = await post(batch, "wrong");
console.log("bad secret:", bad.status);
const invalid = await post({ kind: "nope" });
console.log("invalid body:", invalid.status);
console.log("session:", run);

const tail = [
  { ...common, eventId: `${run}-6`, kind: "turn_stop", at: t0 + 10_000, usage: { ...usage, input: 100 }, lastMessage: "done" },
  { ...common, eventId: `${run}-7`, kind: "agent_start", at: t0 + 3000, toolUseId: `${run}-tu3`, subagentType: "late", description: "older than turn_stop" },
];
const tailRes = await post(tail);
console.log("turn_stop then older agent_start:", tailRes.status, await tailRes.text());
