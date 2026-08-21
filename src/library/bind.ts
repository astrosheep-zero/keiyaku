import { randomBytes } from "node:crypto";
import { contractIdFromSegment, type ActorId, type ContractId } from "../core/facts/types.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { fitIdentityStem, normalizeIdentityStem } from "../identity/normalize.js";
import { bindOperation } from "../protocol/bind.js";
import type { IntentOutcome, RepositoryScope } from "../protocol/operations.js";
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
  workspace: "worktree";
  target?: string;
  coordinates?: Readonly<{ start: import("../core/facts/types.js").SnapshotId }>;
  source?: Parameters<typeof bindOperation>[0]["source"];
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
    terms: input.terms,
    verification: input.verification,
    workspace: input.workspace,
    ...(input.coordinates === undefined ? {} : { coordinates: input.coordinates }),
    ...(input.source === undefined ? {} : { source: input.source }),
    contractId: id,
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.task === undefined
      ? {}
      : {
          decorateOffer: ({ contractId: owner }) => [claimTaskHolder(input.task!, owner)],
        }),
    ...(input.actor === undefined ? {} : { actor: input.actor }),
  });
}

async function attemptCandidates(
  input: BindAttemptInput,
): Promise<IntentOutcome<Readonly<{ contractId: ContractId }>, KeiyakuRefusal>> {
  let result!: IntentOutcome<Readonly<{ contractId: ContractId }>, KeiyakuRefusal>;
  for (let collision = 0; collision <= 3; collision += 1) {
    const id = candidateId(input.title, collision);
    result = await attempt(input, id);
    if (result.kind === "accepted") return result;
    if (result.kind !== "refused" || result.refusal.kind !== "contract-exists") return result;
  }
  return result;
}

export async function admitBindWithAppointment(input: BindAttemptInput) {
  return await attemptCandidates(input);
}
