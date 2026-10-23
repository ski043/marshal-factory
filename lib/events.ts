import { z } from "zod";

export const usageSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  model: z.string(),
});
export type Usage = z.infer<typeof usageSchema>;

const base = {
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  at: z.number().int().nonnegative(),
};

export const eventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("session_start"),
    cwd: z.string(),
    branch: z.string().optional(),
    repo: z.string().optional(),
    source: z.enum(["startup", "resume", "compact"]).optional(),
    t3ThreadId: z.string().optional(),
    title: z.string().optional(),
    model: z.string().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("agent_start"),
    toolUseId: z.string().min(1),
    subagentType: z.string(),
    description: z.string(),
    model: z.string().optional(),
    parentAgentId: z.string().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("agent_launched"),
    toolUseId: z.string().min(1),
    agentId: z.string().min(1),
  }),
  z.object({
    ...base,
    kind: z.literal("agent_stop"),
    agentId: z.string().min(1),
    status: z.enum(["completed", "failed"]),
    usage: usageSchema,
    model: z.string().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("turn_stop"),
    usage: usageSchema,
    lastMessage: z.string().max(500).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("session_end"),
    reason: z.string().optional(),
  }),
]);
export type FactoryEvent = z.infer<typeof eventSchema>;
export type EventKind = FactoryEvent["kind"];

export const MAX_BATCH = 100;

export const ingestBodySchema = z
  .union([eventSchema, z.array(eventSchema).min(1).max(MAX_BATCH)])
  .transform((body) => (Array.isArray(body) ? body : [body]));
