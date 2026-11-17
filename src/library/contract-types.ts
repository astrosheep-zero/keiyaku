/** @architectureCompositionRoot */
import { z } from "zod";
import type { LifecycleSelection } from "../bounded-list.js";
import { contractIdSchema, snapshotIdSchema } from "../git/identity.js";
import { gateSchema, requirementIdSchema, verdictSchema } from "../protocol/result-leaves.js";
import { canonicalDecimalSchema, historyPageSchemas } from "../history.js";
import type { AttestationData, ContractId } from "../core/facts/types.js";
import type { ContractCatalogue } from "../protocol/read/status.js";
import type { Settings } from "../settings.js";
import type { DebtId } from "../debt/identity.js";

import { akumaIdSchema } from "../akuma/identity.js";

/** Public gate words remain ordinary strings; private policy interprets them. */
export type { Gate } from "../core/facts/types.js";

/** A journal row's public address is its one-based append position, never its private entry identity. */
const historyCommon = {
  id: canonicalDecimalSchema,
  at: z.string(),
};
const historyTarget = z.union([
  z.string(),
  z.strictObject({ kind: z.literal("contract"), contractId: contractIdSchema }).readonly(),
]);
const historyIncarnation = z.strictObject({ id: z.string(), identity: z.string() }).readonly();
const historyGates = z.array(gateSchema).readonly().exactOptional();
const historyAfter = z.array(contractIdSchema).readonly().exactOptional();
function historyEvent<Kind extends string, Fields extends z.ZodRawShape>(kind: Kind, fields: Fields) {
  return z.strictObject({ ...historyCommon, kind: z.literal(kind), ...fields }).readonly();
}
/** A page row keeps the semantic fact; an exact read adds that record's complete retained terms. */
export const contractJournalRowSchema = z.union([
  historyEvent("bind", {
    start: snapshotIdSchema,
    target: historyTarget.exactOptional(),
    gates: historyGates,
    after: historyAfter,
    document: z.string().exactOptional(),
    targetIncarnation: historyIncarnation.exactOptional(),
  }),
  historyEvent("amend", {
    target: historyTarget.exactOptional(),
    targetIncarnation: historyIncarnation.exactOptional(),
    changedSections: z.array(z.string()).readonly().exactOptional(),
    gates: historyGates,
    after: historyAfter,
    document: z.string().exactOptional(),
  }),
  historyEvent("deliver", {
    candidate: snapshotIdSchema,
    integration: snapshotIdSchema,
    contentId: z.string(),
    predecessor: snapshotIdSchema,
    note: z.string().exactOptional(),
    requireBranchesToBeUpToDate: z.boolean().exactOptional(),
  }),
  historyEvent("reintegrated", { predecessor: snapshotIdSchema, integration: snapshotIdSchema }),
  historyEvent("attestation", {
    gate: gateSchema,
    requirement: requirementIdSchema,
    verdict: verdictSchema,
    subject: z.string(),
    summary: z.string().exactOptional(),
  }),
  historyEvent("claimed", { deliveryId: canonicalDecimalSchema }),
  historyEvent("arc", { chapter: z.number().int().positive(), title: z.string(), body: z.string().exactOptional() }),
  historyEvent("abandoned", { note: z.string().exactOptional() }),
]);
/** One available Dispatch association, presented after the journal row it enriches. */
export const contractDispatchRowSchema = z
  .strictObject({ kind: z.literal("dispatch"), at: z.string(), akumaId: akumaIdSchema })
  .readonly();
export const contractHistoryEventSchema = z.union([contractJournalRowSchema, contractDispatchRowSchema]);
export const contractHistorySchema = z.union([
  z
    .strictObject({
      kind: z.literal("contract"),
      contractId: contractIdSchema,
      events: z.array(contractHistoryEventSchema).readonly(),
      omitted: z.number().int().positive().exactOptional(),
      lowestRetainedSequence: z.number().int().positive().exactOptional(),
      highestSequence: z.number().int().positive().exactOptional(),
      dispatches: z
        .strictObject({
          kind: z.literal("unavailable"),
          category: z.enum(["authority-corruption", "internal"]),
          diagnostic: z.string(),
        })
        .readonly()
        .exactOptional(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("contract-exact"),
      contractId: contractIdSchema,
      event: contractJournalRowSchema,
    })
    .readonly(),
  z.strictObject({ kind: z.literal("contract-unknown-history"), contractId: contractIdSchema }).readonly(),
  z.strictObject({ kind: z.literal("contract-missing"), contractId: contractIdSchema }).readonly(),
]);

/** A page, one exact journal record, an unknown address, or absent Contract authority. */
export type ContractHistoryEvent = z.output<typeof contractHistoryEventSchema>;
export type ContractDispatchRow = z.output<typeof contractDispatchRowSchema>;
export type ContractJournalRow = z.output<typeof contractJournalRowSchema>;
export type ContractHistory = z.output<typeof contractHistorySchema>;
/** One exact address or one page window; the family's schema rejects contradictory intent. */
export const contractHistoryInputSchema = z.union([
  z.strictObject({ item: canonicalDecimalSchema }),
  ...historyPageSchemas,
]);
export type ContractHistoryInput = Readonly<{ item?: string; before?: number; since?: number; limit?: number }>;

type MarkdownBindInput = Readonly<{
  terms: string;
  debt?: DebtId;
  /** A literal target branch; `null` is deliberately targetless; omitted is the Repo worktree's current branch. */
  target?: string | null;
  after?: readonly ContractId[];
  gates?: readonly string[];
}>;
type ForkBindInput = Readonly<{
  forkOf: ContractId;
  /** A literal target branch; `null` clears the source target; omitted inherits it. */
  target?: string | null;
}>;
export type BindInput = MarkdownBindInput | ForkBindInput;
/** Contract-local composition: one captured Settings selection. */
export type KeisOptions = Readonly<{
  settings?: Settings;
}>;

export type AmendInput = Readonly<{
  /** Explicit existing branch or active Contract; omission retains the target. */
  target?: string;
  edits?: string;
  after?: readonly ContractId[];
  gates?: readonly string[];
}>;
export type ArcInput = Readonly<{ body: string }>;
export type ContractListInput = Readonly<{
  selection?: LifecycleSelection;
  limit?: number;
}>;
export type ContractList = ContractCatalogue;
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
export type ReviewInput = Readonly<{ verdict: AttestationData["verdict"]; summary: string; signal?: AbortSignal }>;
export type AbandonInput = Readonly<{ note?: string }>;
export type VerifyInput = Readonly<{ index?: number; includeDirty?: boolean; signal?: AbortSignal }>;
export type DeliverInput = Readonly<{
  message?: string;
  includeDirty?: boolean;
  materializeConflict?: boolean;
  overwrite?: boolean;
  signal?: AbortSignal;
}>;
