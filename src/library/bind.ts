import { randomBytes } from "node:crypto";
import {
  releaseContractWorktree,
  reserveContractWorktree,
  withContractWorktreeAppointment,
} from "../contract-worktree.js";
import { contractIdFromSegment, type ActorId, type ContractId } from "../core/facts/types.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { fitIdentityStem, normalizeIdentityStem } from "../identity/normalize.js";
import { bindOperation, type IntentOutcome, type RepositoryScope } from "../protocol/operations.js";
import { claimTaskHolder } from "../settlement/holder.js";
import type { TaskId } from "../task/identity.js";
import type { VerificationDeclarationPreparation } from "../verification/declaration.js";
import type { KeiyakuRefusal } from "./refusal.js";

type BindAttemptInput = Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  title: string;
  terms: Parameters<typeof bindOperation>[0]["terms"];
  verification: VerificationDeclarationPreparation;
  workspace: "worktree" | "here";
  target?: string;
  task?: TaskId;
  actor?: ActorId;
}>;

function candidateId(title: string, collision: number): ContractId {
  const stem = fitIdentityStem({ stem: normalizeIdentityStem({ source: title }) || "contract", maxBytes: 48 });
  const suffix = collision === 0 ? "" : `-${randomBytes(8).toString("hex")}`;
  return contractIdFromSegment(`${stem}${suffix}`);
}

async function attempt(input: BindAttemptInput, id: ContractId) {
  return bindOperation({
    scope: input.scope,
    channel: input.channel,
    title: input.title,
    terms: input.terms,
    verification: input.verification,
    workspace: input.workspace,
    contractId: id,
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.task === undefined ? {} : {
      decorateOffer: ({ contractId: owner }) => [claimTaskHolder(input.task!, owner)],
    }),
    ...(input.actor === undefined ? {} : { actor: input.actor }),
  });
}

async function attemptCandidates(input: BindAttemptInput): Promise<IntentOutcome<Readonly<{ contractId: ContractId }>, KeiyakuRefusal>> {
  for (let collision = 0; collision <= 3; collision += 1) {
    const id = candidateId(input.title, collision);
    let reserved = false;
    if (input.workspace === "here") {
      const reservation = await reserveContractWorktree(input.scope, id);
      if (reservation.kind !== "reserved") {
        return { kind: "refused", refusal: {
          kind: "here-worktree-appointed",
          path: reservation.path,
          ...(reservation.kind === "appointed" ? { contract: reservation.contract } : {}),
        } };
      }
      reserved = true;
    }
    const result = await attempt(input, id);
    if (result.kind === "accepted") return result;
    if (reserved) await releaseContractWorktree(input.scope, id);
    if (result.kind !== "refused" || result.refusal.kind !== "contract-exists") return result;
  }
  throw new Error("contract identity collision attempts exhausted");
}

export async function admitBindWithAppointment(input: BindAttemptInput) {
  const action = () => attemptCandidates(input);
  return input.workspace === "here" ? await withContractWorktreeAppointment(input.scope, action) : action();
}
