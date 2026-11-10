import type { JobRow } from "../../db/schema";
import type { Stage } from "../events";
import type { SourceOverrides } from "../ticket-overrides";
import type { IntentDraft, Verdict } from "../webhooks";
import type { JobId, JobSource, SourceStateDraftOf, SourceStateOf, WritebackOf } from "./shapes";

export type { JobId, JobSource } from "./shapes";

export type Job<S extends JobSource = JobSource> = Omit<JobRow, "id" | "source" | "writeback" | "source_state"> & {
  id: JobId<S>;
  source: S;
  writeback: WritebackOf<S>;
  source_state: SourceStateOf<S>;
};

/** What a source reports for work it wants claimed; the claim turns it into a row. */
export type JobDraft<S extends JobSource = JobSource> = {
  externalId: string;
  key: string;
  title: string;
  url: string;
  description: string | null;
  writeback: WritebackOf<S>;
  /** Merged over the stored state on a reclaim, so state the adapter accumulated survives. */
  sourceState: SourceStateDraftOf<S>;
};

/** The source no longer has the job's item, or this key can't see it; retrying changes nothing. */
export class SourceGoneError extends Error {}

export type StageTransition = { stage: Stage; eventId: string };

export type Reply = { id: string; body: string; createdAt: string };

export type ResumePlan =
  | { kind: "wait" }
  | { kind: "close"; state: string }
  | { kind: "resume"; question: string; replies: Reply[]; answer: string };

export type StopReason = string;

export type StopCheck = { stop: false } | { stop: true; reopen: boolean };

export interface SourceWebhook {
  secretEnv: string;
  deliveryHeader: string;
  eventHeader: string;
  verify(raw: string, headers: Headers, secret: string | undefined, now?: number): Verdict;
  /** What a delivery means; `env` is the ingest function's, where the source reads its own scope (Linear: team key and label). */
  intent(body: unknown, env: Readonly<Record<string, string | undefined>>): IntentDraft | null;
}

export interface SourceAdapter<S extends JobSource> {
  source: S;
  webhook?: SourceWebhook;
  ready(): Promise<JobDraft<S>[]>;
  /** Tells the source the job's current attempt was picked up; does nothing once it has. */
  announceClaim(job: Job<S>): Promise<void>;
  /** Reports the stage to the source; false when the stage has nothing to say there. Throws SourceGoneError when the item is gone. */
  writeBack(job: Job<S>, transition: StageTransition): Promise<boolean>;
  /** What a waiting job needs from what the source shows: wait, close, or resume with the new replies. */
  replies(job: Job<S>): Promise<ResumePlan>;
  acknowledgeReplies(job: Job<S>, replyIds: readonly string[]): Promise<void>;
  /** Of these jobs, the ones the source says should stop, with why. A failed read throws and decides nothing. */
  stopWanted(jobs: readonly Job<S>[]): Promise<{ job: Job<S>; reason: StopReason }[]>;
  /** Re-reads the source before a stop intent is acted on, so an unrelated change does not stop a run. */
  confirmStop(externalId: string, detail: string): Promise<StopCheck>;
  /** Posts a comment on the job; one key is posted once, so a replay changes nothing. */
  note(job: Job<S>, key: string, body: string): Promise<void>;
  /** The harness, place and repository the job asks for, from what the claim stored; see lib/ticket-overrides.ts. */
  overrides(state: SourceStateDraftOf<S>): SourceOverrides;
  /** The job's labels as the source shows them now. */
  labels(job: Job<S>): Promise<string[]>;
  /** Returns a stopped job to the source's not-started state, so adding the label again retries it. */
  reopen(job: Job<S>): Promise<void>;
  /** Puts a failed job where the source's intake offers it again, as a person adding the factory label does; the next claim starts a new attempt. */
  requeue(job: Job<S>): Promise<void>;
  /** The noun phrase naming the job in messages to the thread, such as "Linear issue FAC-7". */
  describe(job: Pick<Job<S>, "key">): string;
  /**
   * Rewrites the source's private image links in text sent to a thread into files on this machine,
   * since the agent cannot fetch them. Returns the text unchanged when it has none.
   */
  localizeImages?(job: Pick<Job<S>, "key">, text: string): Promise<string>;
  /** Posts the owner's answer to a waiting job as a person would; the runner then reads it as a reply. */
  reply?(job: Job<S>, requestId: string, body: string): Promise<void>;
  /** Files a new job in the source as a person would; the source's own intake then claims it. */
  file?(draft: FileDraft): Promise<FiledJob>;
  /** Creates the label groups and children the source is missing; it never renames or deletes one. */
  syncLabelGroups?(groups: readonly LabelGroupSpec[]): Promise<{ team: string; created: string[]; problems: string[] }>;
  /** syncLabelGroups for the panel, which reads the source's credentials from its env instead of the runner's config. */
  panelSyncLabelGroups?(groups: readonly LabelGroupSpec[]): Promise<{ team: string; created: string[]; problems: string[] }>;
  /** Stores an image where the source keeps uploads, for a job about to be filed; returns its markdown. */
  uploadImage?(image: ImageFile): Promise<string>;
}

export type LabelGroupSpec = { group: string; children: readonly string[] };

export type FileDraft = {
  requestId: string;
  title: string;
  description: string;
  /** Override labels the job is filed with, each a child of a source label group. */
  labels?: { group: string; name: string }[];
  /** Plain labels by name, outside any group, such as `review`; created on the team when missing. */
  tags?: string[];
};
export type ImageFile = { filename: string; contentType: string; bytes: Uint8Array<ArrayBuffer> };
export type FiledJob = { key: string; url: string };
