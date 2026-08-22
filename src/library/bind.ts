import { randomBytes } from "node:crypto";
import { decodeContractDocument } from "../body/decode.js";
import { contractIdFromSegment, type ActorId, type ContractId } from "../core/facts/types.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { fitIdentityStem, normalizeIdentityStem } from "../identity/normalize.js";
import { bindOperation } from "../protocol/bind.js";
import { stateOperation, type IntentOutcome, type RepositoryScope } from "../protocol/operations.js";
import { claimTaskHolder, claimTaskHolderWithFence } from "../settlement/holder.js";
import type { TaskId } from "../task/identity.js";
import type { VerificationDeclarationPreparation } from "../verification/declaration.js";
import { KeiyakuRefused, type KeiyakuRefusal } from "./refusal.js";
import { contractTerms, documentDerivation } from "./input.js";

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

export async function admitForkBindWithAppointment(input: Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  sourceId: ContractId;
  target?: string;
  actor?: ActorId;
}>) {
  let source: Awaited<ReturnType<typeof stateOperation>>;
  try {
    source = await stateOperation({ scope: input.scope, channel: input.channel, contractId: input.sourceId });
  } catch (error) {
    if (error instanceof Error && error.message === `contract does not exist: ${input.sourceId}`) {
      throw new KeiyakuRefused({ kind: "fork-source-missing", contractId: input.sourceId });
    }
    if (error instanceof AuthorityCorruptionError) {
      throw new KeiyakuRefused({ kind: "fork-source-invalid", contractId: input.sourceId });
    }
    throw error;
  }
  const sourceObject = (await input.channel.readObjects([source.coordinates.start as never])).get(source.coordinates.start as never);
  if (sourceObject?.kind !== "present" || sourceObject.type !== "commit") {
    throw new KeiyakuRefused({ kind: "fork-source-unavailable", contractId: input.sourceId });
  }
  const currentSource = await stateOperation({ scope: input.scope, channel: input.channel, contractId: input.sourceId });
  if (
    currentSource.head !== source.head
    || currentSource.coordinates.start !== source.coordinates.start
    || currentSource.terms.document.key !== source.terms.document.key
  ) {
    throw new KeiyakuRefused({ kind: "fork-source-moved", contractId: input.sourceId });
  }
  let sourceDocument: ReturnType<typeof decodeContractDocument>;
  try {
    sourceDocument = decodeContractDocument(source.terms.document.bytes);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new KeiyakuRefused({ kind: "fork-source-invalid", contractId: input.sourceId });
    }
    throw error;
  }
  const markdown = sourceDocument.document.bytes.replace(
    /^\s*#\s*[^\r\n]*(?:\r?\n|$)/u,
    `# Fork · ${sourceDocument.title}${sourceDocument.document.bytes.includes("\r\n") ? "\r\n" : "\n"}`,
  );
  const document = decodeContractDocument(markdown);
  const terms = contractTerms(document, source.terms.gates, source.terms.after);
  const admission = await attemptCandidates({
    scope: input.scope,
    channel: input.channel,
    title: document.title,
    terms,
    verification: documentDerivation(document, terms.gates).verification,
    workspace: "worktree",
    ...(input.target === undefined
      ? (source.coordinates.target === undefined ? {} : { target: source.coordinates.target })
      : { target: input.target }),
    coordinates: { start: source.coordinates.start },
    source: {
      contractId: input.sourceId,
      head: source.head,
      start: source.coordinates.start,
      document: source.terms.document.key,
    },
    ...(input.actor === undefined ? {} : { actor: input.actor }),
  });
  return { admission, document };
}

export async function admitMarkdownBind(input: Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  title: string;
  terms: Parameters<typeof bindOperation>[0]["terms"];
  verification: VerificationDeclarationPreparation;
  workspace: "worktree";
  target?: string;
  task?: TaskId;
  actor?: ActorId;
}>) {
  return await admitBindWithAppointment(input);
}

export async function prepareMarkdownBind(input: Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  document: ReturnType<typeof decodeContractDocument>;
  gates: readonly import("../core/facts/types.js").Gate[];
  after: readonly ContractId[];
  workspace: "worktree";
  target?: string;
  task?: TaskId;
  actor?: ActorId;
}>) {
  const terms = contractTerms(input.document, input.gates, input.after);
  const admitCandidate = () => admitMarkdownBind({
    scope: input.scope,
    channel: input.channel,
    title: input.document.title,
    terms,
    verification: documentDerivation(input.document, terms.gates).verification,
    workspace: input.workspace,
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.task === undefined ? {} : { task: input.task }),
    ...(input.actor === undefined ? {} : { actor: input.actor }),
  });
  const admission = input.task === undefined ? null : await claimTaskHolderWithFence(input.scope, input.task, admitCandidate);
  return { admission, result: admission === null ? await admitCandidate() : admission.result };
}
