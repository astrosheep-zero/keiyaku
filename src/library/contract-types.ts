/** @architectureCompositionRoot */
import { z } from "zod";
import { contractIdSchema, snapshotIdSchema } from "../git/identity.js";
import { worktreeWorkspaceSchema } from "../git/workspace.js";
import { dispatchSchema } from "../dispatch/index.js";
import { journalEntrySchema } from "../protocol/result-leaves.js";
import type { ActorId, AttestationData, ContractId } from "../core/facts/types.js";
import type { ContractBoard, ContractRow } from "../protocol/read/status.js";
import type { Settings } from "../settings.js";
import type { DebtId } from "../debt/identity.js";

/** Public gate words remain ordinary strings; private policy interprets them. */
export type Gate = string;

export const contractHistoryEventSchema = z.union([
  z.strictObject({ source: z.literal("journal"), fact: journalEntrySchema }).readonly(),
  z.strictObject({ source: z.literal("dispatch"), dispatch: dispatchSchema }).readonly(),
]);
export const contractHistorySchema = z
  .strictObject({
    id: contractIdSchema,
    state: snapshotIdSchema,
    workspace: worktreeWorkspaceSchema.exactOptional(),
    events: z.array(contractHistoryEventSchema).readonly(),
  })
  .readonly()
  .nullable();

export type ContractHistoryEvent = z.output<typeof contractHistoryEventSchema>;
export type ContractHistory = NonNullable<z.output<typeof contractHistorySchema>>;

type MarkdownBindInput = Readonly<{
  markdown: string;
  debt?: DebtId;
  /** A literal target branch; `null` is deliberately targetless; omitted is the Repo worktree's current branch. */
  target?: string | null;
  workspace?: "worktree";
  actor?: string;
  after?: readonly ContractId[];
  gates?: readonly string[];
}>;
type ForkBindInput = Readonly<{
  forkOf: ContractId;
  /** A literal target branch; `null` clears the source target; omitted inherits it. */
  target?: string | null;
  workspace?: "worktree";
  actor?: string;
}>;
export type BindInput = MarkdownBindInput | ForkBindInput;
type ActorOptions = Readonly<{ actor?: string }>;
/** Contract-local composition: one captured Settings selection and the operation actor. */
export type KeisOptions = Readonly<{
  settings?: Settings;
  actor?: ActorId;
}>;

export type AmendInput = ActorOptions &
  Readonly<{
    markdown?: string;
    after?: readonly ContractId[];
    gates?: readonly string[];
  }>;
export type ArcInput = ActorOptions & Readonly<{ markdown: string }>;
export type ContractListInput = Readonly<{ limit?: number }>;
export type ContractList = Omit<ContractBoard, "rows"> & Readonly<{ rows: readonly ContractRow[]; hasMore: boolean }>;
export type ContractObservationInput = Readonly<{ id: ContractId }>;
export type ContractResolveInput = Readonly<{ selector?: string; cwd?: string }>;
export const contractSelectorRefusalSchema = z.union([
  z.strictObject({ kind: z.literal("invalid-selector"), selector: z.string(), diagnostic: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("redundant-short-selector"), selector: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("unknown-short-selector"), selector: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("ambiguous-selector"), selector: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("ambiguous-selector"), cwd: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("no-contextual-match"), cwd: z.string() }).readonly(),
]);
export const contractResolutionSchema = z.union([
  z.strictObject({ kind: z.literal("resolved"), id: contractIdSchema }).readonly(),
  z.strictObject({ kind: z.literal("refused"), refusal: contractSelectorRefusalSchema }).readonly(),
]);
export type ContractSelectorRefusal = z.output<typeof contractSelectorRefusalSchema>;
export type ContractResolution = z.output<typeof contractResolutionSchema>;
export type ReviewInput = ActorOptions &
  Readonly<{ verdict: AttestationData["verdict"]; summary?: string; signal?: AbortSignal }>;
export type AbandonInput = ActorOptions & Readonly<{ note?: string }>;
export type VerifyInput = Readonly<{ index?: number; includeDirty?: boolean; signal?: AbortSignal }>;
export type DeliverInput = Readonly<{
  message?: string;
  includeDirty?: boolean;
  materializeConflict?: boolean;
  overwrite?: boolean;
  signal?: AbortSignal;
}>;
