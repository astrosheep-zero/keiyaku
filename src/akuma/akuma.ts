import { type AkumaLife, type KillEvidence, type ResumeCoordinate } from "./heart/index.js";
export type { KillEvidence };
import { parseAkuId, type AkuId } from "./identity.js";
import { activitySnapshotSchema } from "./projection.js";
import type { Settings } from "../settings.js";
import type { WorldRoot } from "../world.js";
import type { AllowedAction } from "./allowed.js";
import type { ExecutionContext } from "./requests.js";
import { z } from "zod";
import type { BoundedList } from "../bounded-list.js";
import type { Schema } from "./schema.js";
import { createAkumaProduct } from "./akuma-product.js";
import { killAkumaWithRecovery } from "./akuma-handle.js";
import type { TellResult } from "./body.js";
export { killAkumaWithRecovery };

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
export function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export {
  bornStatus,
  fleetListRow,
  readAkumaBirthCwd,
  readBudgetedStatus,
  type BudgetedStatusObservation,
} from "./akuma-observe.js";

export type AkumaConfiguration = Readonly<{ home?: string; settings?: Settings; execution?: ExecutionContext }>;

/** Internal catalog observation for composition owners. */
export async function readAkumaCatalog(path: WorldRoot, input: AkumaListInput = {}): Promise<AkumaList> {
  return await createAkumaProduct(path).list(input);
}

/** Internal timeline observation for composition owners. */
export async function readAkumaTimeline(path: WorldRoot, id: AkuId): Promise<AkumaStatus["timeline"]> {
  return (await createAkumaProduct(path).selectHandle({ id }).status()).timeline;
}

export { AkumaBusyError, AkumaDecodeError, AkumaProviderError } from "./akuma-errors.js";
