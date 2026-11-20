import { z } from "zod";
import { publicationFailedSchema } from "../git/admission.js";
import type { ContractReadView } from "../git/observe.js";
import {
  appendPrivateStateSeatClose,
  isPrivateStateSeatContention,
  mergePrivateStateSeatClose,
  withPrivateStatePublicationSeat,
  type PrivateStatePublicationSeat,
  type PrivateStateSeatCloseLag,
} from "../git/private-state-seat.js";
import type { GitRepository } from "../git/process.js";
import { readRef } from "../git/repository.js";
import { contractState } from "../core/facts/observation.js";
import type { AttemptContext } from "../core/decide.js";
import type { ContractHead, ContractId } from "../core/facts/types.js";
import type { Offer, TreeUpdate } from "../core/facts/offer.js";
import type { AcceptedAdmission } from "./attempt.js";

export const protocolTerminalSchema = z.union([
  z.strictObject({ kind: z.literal("exhausted") }).readonly(),
  z.strictObject({ kind: z.literal("collision") }).readonly(),
  publicationFailedSchema,
]);
export type ProtocolTerminal = z.infer<typeof protocolTerminalSchema>;
export type ProtocolResult<Refusal> =
  | AcceptedAdmission
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | ProtocolTerminal;

export type CompanionDecorator = (
  input: Readonly<{
    repository: GitRepository;
    observation: ContractReadView;
    contractId: ContractId;
    offer: Offer;
  }>,
) => readonly TreeUpdate[] | Promise<readonly TreeUpdate[]>;

/** One preparation whose observed coordinates a fresh admission no longer justifies. */
export const spentPreparation = { kind: "spent" } as const;
export type SpentPreparation = typeof spentPreparation;

export type ObservedRef = Readonly<{ ref: string; oid: string | null }>;

/** One attempt's seat-external preparation: usable artifacts, a real refusal, or a spent premise. */
export type PreparedAttempt<Prepared, Refusal> =
  | Readonly<{ kind: "prepared"; prepared: Prepared }>
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | SpentPreparation;

export type BoundedAttemptResult<Final, Refusal> =
  | Final
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | SpentPreparation
  | ProtocolTerminal;

type BoundedFinalKind =
  | "accepted"
  | "refused"
  | "collision"
  | "publication-failed"
  | "exhausted"
  | "integration-conflict-materialized"
  | "target-moved"
  | "unchanged";

/**
 * Run one seat-external preparation and one in-seat admission per fresh attempt until an attempt
 * reaches a final result. A spent preparation retires only its own attempt: the next attempt
 * observes and prepares again outside custody and mints fresh entry identities, so no offer is
 * rebuilt or replayed. Budget exhaustion alone yields `exhausted`; identity collision keeps its own
 * category, and a publication failure whose premise did not move is returned without retry.
 */
export async function runBoundedAttempts<Prepared, Final extends Readonly<{ kind: BoundedFinalKind }>, Refusal>(
  attempts: readonly AttemptContext[],
  prepare: (attempt: AttemptContext, index: number) => Promise<PreparedAttempt<Prepared, Refusal>>,
  attempt: (prepared: Prepared, attempt: AttemptContext) => Promise<BoundedAttemptResult<Final, Refusal>>,
): Promise<Final | Readonly<{ kind: "refused"; refusal: Refusal }> | ProtocolTerminal> {
  for (let index = 0; index < attempts.length; index += 1) {
    const current = attempts[index]!;
    const prepared = await prepare(current, index);
    if (prepared.kind === "refused") return prepared;
    if (prepared.kind === "spent") continue;
    const result = await attempt(prepared.prepared, current);
    if (result.kind === "spent") continue;
    if (result.kind === "collision" && index + 1 < attempts.length) continue;
    return result;
  }
  return { kind: "exhausted" };
}

/** Check whether immutable artifacts still apply, not whether publication will succeed. */
export async function preparationIsCurrent(
  repository: GitRepository,
  observation: ContractReadView,
  id: ContractId,
  expectedHead: ContractHead | null,
  expectedRef?: ObservedRef,
): Promise<boolean> {
  if ((contractState(observation.decision, id)?.head ?? null) !== expectedHead) return false;
  if (expectedRef === undefined) return true;
  const repo = expectedRef.ref.startsWith("worktrees/")
    ? { ...repository, effectiveCwd: repository.primaryWorktree }
    : repository;
  return (await readRef(repo, expectedRef.ref)) === expectedRef.oid;
}

export async function privateStateSeatAttempt<
  T extends Readonly<{ kind: string; seatClose?: readonly PrivateStateSeatCloseLag[] }>,
>(repository: GitRepository, action: (seat: PrivateStatePublicationSeat) => Promise<T>): Promise<T | ProtocolTerminal> {
  try {
    return mergePrivateStateSeatClose(await withPrivateStatePublicationSeat(repository, action), (value, closeLag) => {
      if (value.kind !== "accepted") throw new Error(closeLag.diagnostic);
      return { ...value, seatClose: appendPrivateStateSeatClose(value.seatClose, closeLag) };
    });
  } catch (error) {
    if (isPrivateStateSeatContention(error)) return { kind: "publication-failed", diagnostic: error.message };
    throw error;
  }
}
