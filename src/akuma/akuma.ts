import { randomUUID } from "node:crypto";
import {
  CONTROL_RESPONSE_MS,
  handoffPendingTells,
  type TellResult,
  type TellWakeRuntime,
  wakeRecordedTell,
} from "./body.js";
import {
  HeldAkumaLeash,
  readHeart,
  readKill,
  recordTell,
  requestStop,
  type AkumaLife,
  type KillEvidence,
  type ResumeCoordinate,
} from "./heart/index.js";
export type { KillEvidence };
import { parseAkuId, pathsForAkuId, type AkuId, type AkumaPaths } from "./identity.js";
import { activitySnapshotSchema } from "./projection.js";
import type { Settings } from "../settings.js";
import type { WorldRoot } from "../world.js";
import type { AllowedAction } from "./allowed.js";
import type { ExecutionContext } from "./requests.js";
import { z } from "zod";
import type { BoundedList } from "../bounded-list.js";
import type { Schema } from "./schema.js";

export const POLL_MS = 100;

export type AkumaListRow = Readonly<{
  id: AkuId;
  archetype: string;
  description?: string;
  life: AkumaLife;
  lifeAt: string | null;
  lastActivityAt: string | null;
  pending: readonly string[];
}>;

export const akumaIdSchema = z.string().transform((value, context) => {
  try {
    const id = parseAkuId(value).id;
    if (id !== value) throw new Error("not canonical");
    return id;
  } catch {
    context.addIssue({ code: "custom", message: "expected canonical AkuId" });
    return z.NEVER;
  }
});
const readonlySchema = z.union([
  z.object({ enforcement: z.literal("native") }).strict(),
  z.object({ enforcement: z.literal("none"), diagnostic: z.string().refine((value) => value.trim() !== "") }).strict(),
]);
export const akumaStatusSchema = z
  .object({
    id: akumaIdSchema,
    life: z.enum(["running", "asleep", "stranded", "hung", "untidy", "killed"]),
    readonly: readonlySchema.optional(),
    timeline: activitySnapshotSchema,
    strandedReason: z.literal("resume-unsupported").optional(),
  })
  .strict();
export type AkumaStatus = z.infer<typeof akumaStatusSchema>;

export function parseAkumaStatus(value: unknown): AkumaStatus {
  return akumaStatusSchema.parse(value);
}

/** The default completion judgment over one complete status snapshot. */
export function defaultWaitComplete(status: AkumaStatus): boolean {
  return (
    status.life !== "running" &&
    !status.timeline.entries.some(
      (entry) => entry.kind === "row" && entry.row.kind === "tell" && entry.row.state === "pending",
    )
  );
}

export type { ReadonlyRestraint } from "./provider-recipe.js";
export type * from "./projection.js";

export type UnbornAkumaListRow = Readonly<{
  id: AkuId;
  life: "unborn" | "stillborn";
  seal?: Readonly<{ evidence: string; at: string }>;
}>;

export type AkumaList = BoundedList<AkumaListRow | UnbornAkumaListRow> &
  Readonly<{
    observedAt: string;
    searched: readonly string[];
  }>;

export type AkumaCompleteList = Omit<AkumaList, "hasMore">;

export type AkumaListInput = Readonly<{
  archetype?: string;
  limit?: number;
}>;

export type AkumaCallExecution = Readonly<{
  cwd: string;
  source: "input" | "caller" | "process" | "world";
}>;

export { CALL_WITH_CONTEXT } from "./akuma-product-symbols.js";

export type AkumaCallInput = Readonly<{
  archetype: string;
  body: string;
  cwd?: string;
  readonly?: true;
  allowed?: readonly AllowedAction[];
  schema?: Schema<unknown>;
}>;
export type AkumaCallContext = Readonly<{
  initiatorCwd?: string;
  cwdCanonical?: true;
}>;

export type { TellResult, TellWake } from "./body.js";

export type InterruptReceipt =
  | Readonly<{
      kind: "unavailable";
      evidence: "hung" | "untidy" | "unavailable";
    }>
  | Readonly<{
      kind: "interrupted";
      putDown: "was-idle" | "self-aborted";
      tell: TellResult;
    }>;

export type ForkReceipt =
  | Readonly<{ kind: "forked"; child: AkuId }>
  | Readonly<{ kind: "provider-cannot-fork"; provider: string }>
  | Readonly<{ kind: "unknown-history"; at: string }>
  | Readonly<{ kind: "fork-failed"; diagnostic: string }>
  | Readonly<{ kind: "upstream-forked"; childSession: ResumeCoordinate; diagnostic: string }>;

export { AkumaNotBornError } from "./akuma-errors.js";
import { AkumaNotBornError } from "./akuma-errors.js";
export function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function takeLeashUntil(paths: AkumaPaths, deadline: number): Promise<HeldAkumaLeash | null> {
  for (;;) {
    const leash = await HeldAkumaLeash.try(paths);
    if (leash !== null) return leash;
    if (performance.now() >= deadline) return null;
    await wait(Math.min(POLL_MS, Math.max(0, deadline - performance.now())));
  }
}

export async function recordTellBody(
  paths: AkumaPaths,
  akuma: AkuId,
  body: string,
  id: string = randomUUID(),
  recordedAt = new Date().toISOString(),
): Promise<Readonly<{ kind: "recorded"; tellId: string }>> {
  const admitted = await recordTell(paths, { kind: "tell", id, body, recordedAt });
  if (admitted.kind === "not-born") throw new AkumaNotBornError(akuma);
  return { kind: "recorded", tellId: admitted.tell.id };
}

export async function tellAkumaWithId(
  input: Readonly<{
    worldPath: WorldRoot;
    id: AkuId;
    body: string;
    tellId: string;
    recordedAt?: string;
    runtime?: TellWakeRuntime;
  }>,
): Promise<TellResult> {
  const paths = pathsForAkuId(input.worldPath, input.id);
  const recorded = await recordTellBody(paths, input.id, input.body, input.tellId, input.recordedAt);
  return await wakeRecordedTell(paths, recorded.tellId, input.runtime);
}

export function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function killAkumaWithRecovery(
  paths: AkumaPaths,
  recover: (paths: AkumaPaths) => Promise<void> = handoffPendingTells,
): Promise<KillEvidence> {
  try {
    const request = await requestStop(paths, new Date().toISOString());
    if (request.kind !== "requested") return request.kind;
    const target = request.body;
    const leash = await takeLeashUntil(paths, performance.now() + CONTROL_RESPONSE_MS);
    if ((await readKill(paths, target.sequence)) !== null) {
      leash?.release();
      return "killed";
    }
    if (leash === null) {
      if ((await readKill(paths, target.sequence)) !== null) return "killed";
      const body = (await readHeart(paths)).latestBody;
      return body?.sequence === target.sequence && body.hung !== undefined ? "hung" : "unavailable";
    }
    try {
      const settledBody = (await readHeart(paths)).latestBody;
      if (settledBody?.sequence !== target.sequence)
        return (await readKill(paths, target.sequence)) === null ? "unavailable" : "killed";
      if (settledBody.end !== "put-down") {
        await leash.clearStop(paths);
        return "untidy";
      }
      const settled = await leash.settleStop(paths, target.sequence);
      return settled === null ? "unavailable" : "killed";
    } finally {
      leash.release();
    }
  } finally {
    void recover(paths).catch(() => undefined);
  }
}

export {
  bornStatus,
  fleetListRow,
  readAkumaBirthCwd,
  readBudgetedStatus,
  type BudgetedStatusObservation,
} from "./akuma-observe.js";

export type AkumaConfiguration = Readonly<{ home?: string; settings?: Settings; execution?: ExecutionContext }>;

export { AkumaHandle, akumaCallExecution, type LastAnswer } from "./akuma-handle.js";
export { Akuma } from "./akuma-product.js";
export { AkumaBusyError, AkumaDecodeError, AkumaProviderError } from "./akuma-errors.js";
