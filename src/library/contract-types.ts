/** @architectureCompositionRoot */
import { z } from "zod";
import { contractIdSchema, snapshotIdSchema } from "../git/identity.js";
import { entryUlidSchema, gateSchema, requirementIdSchema, verdictSchema } from "../protocol/result-leaves.js";
import type { ActorId, AttestationData, ContractId } from "../core/facts/types.js";
import type { ContractCatalogue } from "../protocol/read/status.js";
import type { Settings } from "../settings.js";
import type { DebtId } from "../debt/identity.js";

import { akumaIdSchema } from "../akuma/identity.js";

/** Public gate words remain ordinary strings; private policy interprets them. */
export type Gate = string;

const historyCommon = {
  id: entryUlidSchema,
  at: z.string(),
  actor: z.string().exactOptional(),
};
const historyTarget = z.union([
  z.string(),
  z.strictObject({ kind: z.literal("contract"), contractId: contractIdSchema }).readonly(),
]);
const historyGates = z.array(gateSchema).readonly().exactOptional();
const historyAfter = z.array(contractIdSchema).readonly().exactOptional();
function historyEvent<Kind extends string, Fields extends z.ZodRawShape>(kind: Kind, fields: Fields) {
  return z.strictObject({ ...historyCommon, kind: z.literal(kind), ...fields }).readonly();
}
export const contractHistoryEventSchema = z.union([
  historyEvent("bind", {
    start: snapshotIdSchema,
    target: historyTarget.exactOptional(),
    gates: historyGates,
    after: historyAfter,
    document: z.string().exactOptional(),
    targetIncarnation: z.strictObject({ id: z.string(), identity: z.string() }).readonly().exactOptional(),
  }),
  historyEvent("amend", {
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
  historyEvent("claimed", { deliveryId: entryUlidSchema }),
  historyEvent("arc", { chapter: z.number().int().positive(), title: z.string(), body: z.string().exactOptional() }),
  historyEvent("abandoned", { note: z.string().exactOptional() }),
  z
    .strictObject({
      kind: z.literal("dispatch"),
      at: z.string(),
      akumaId: akumaIdSchema,
    })
    .readonly(),
]);
export const contractHistorySchema = z.union([
  z
    .strictObject({
      kind: z.literal("contract"),
      contractId: contractIdSchema,
      events: z.array(contractHistoryEventSchema).readonly(),
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
  z.strictObject({ kind: z.literal("contract-missing"), contractId: contractIdSchema }).readonly(),
]);

export type ContractHistoryEvent = z.output<typeof contractHistoryEventSchema>;
export type ContractHistory = z.output<typeof contractHistorySchema>;
export type ContractHistoryInput = Readonly<{ full?: boolean }>;

type MarkdownBindInput = Readonly<{
  markdown: string;
  debt?: DebtId;
  /** A literal target branch; `null` is deliberately targetless; omitted is the Repo worktree's current branch. */
  target?: string | null;
  actor?: string;
  after?: readonly ContractId[];
  gates?: readonly string[];
}>;
type ForkBindInput = Readonly<{
  forkOf: ContractId;
  /** A literal target branch; `null` clears the source target; omitted inherits it. */
  target?: string | null;
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
export type ReviewInput = ActorOptions &
  Readonly<{ verdict: AttestationData["verdict"]; summary: string; signal?: AbortSignal }>;
export type AbandonInput = ActorOptions & Readonly<{ note?: string }>;
export type VerifyInput = Readonly<{ index?: number; includeDirty?: boolean; signal?: AbortSignal }>;
export type DeliverInput = Readonly<{
  message?: string;
  includeDirty?: boolean;
  materializeConflict?: boolean;
  overwrite?: boolean;
  signal?: AbortSignal;
}>;
