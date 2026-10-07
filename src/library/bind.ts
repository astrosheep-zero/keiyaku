import { randomBytes } from "node:crypto";
import { decodeContractDocument } from "../body/decode.js";
import { decodeCanonicalContractDocument } from "../body/render.js";
import { contractIdFromSegment, type ActorId, type ContractId } from "../core/facts/types.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { mintIdentitySegment } from "../identity/mint.js";
import { fitIdentityStemWords, normalizeIdentityStem } from "../identity/normalize.js";
import { bindOperation, type BindTargetSelection } from "../protocol/bind.js";
import { stateOperation, type IntentOutcome, type RepositoryScope } from "../protocol/operations.js";
import { claimTaskHolder, claimTaskHolderWithFence } from "../settlement/holder.js";
import type { ProtocolProgress } from "../protocol/progress.js";
import type { TaskId } from "../task/identity.js";
import type { VerificationDeclarationPreparation } from "../verification/declaration.js";
import type { ForkSourceRefusal, OperationRefusals } from "./refusal.js";
import { KeiyakuError } from "./outcome.js";
import { contractTerms, documentDerivation } from "./input.js";

type BindAttemptInput = Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  title: string;
  terms: Parameters<typeof bindOperation>[0]["terms"];
  verification: VerificationDeclarationPreparation;
  workspace: "worktree";
  targetSelection?: BindTargetSelection;
  coordinates?: Readonly<{ start: import("../core/facts/types.js").SnapshotId }>;
  source?: Parameters<typeof bindOperation>[0]["source"];
  task?: TaskId;
  progress?: ProtocolProgress;
  actor?: ActorId;
}>;

const CONTRACT_ID_CODE_POINTS = 32;
const CONTRACT_ID_ATTEMPTS = 4;

function drawContractSuffix(): string {
  return randomBytes(2).toString("hex");
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
    ...(input.targetSelection === undefined ? {} : { targetSelection: input.targetSelection }),
    ...(input.task === undefined
      ? {}
      : {
          decorateOffer: ({ contractId: owner }) => [claimTaskHolder(input.task!, owner)],
        }),
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(input.progress === undefined ? {} : { progress: input.progress }),
  });
}

async function attemptCandidates(
  input: BindAttemptInput,
): Promise<IntentOutcome<Readonly<{ contractId: ContractId }>, OperationRefusals["bind"]>> {
  const stem = fitIdentityStemWords({
    stem: normalizeIdentityStem({ source: input.title }) || "contract",
    maxCodePoints: CONTRACT_ID_CODE_POINTS,
  });
  return await mintIdentitySegment({
    stem,
    attempts: CONTRACT_ID_ATTEMPTS,
    drawSuffix: drawContractSuffix,
    attempt: (segment) => attempt(input, contractIdFromSegment(segment)),
    collision: (result) => result.kind === "refused" && result.refusal.kind === "contract-exists",
  });
}

export async function admitBindWithAppointment(input: BindAttemptInput) {
  return await attemptCandidates(input);
}

type ForkBindAdmission = Readonly<{
  kind: "document";
  document: ReturnType<typeof decodeContractDocument>;
  admission: IntentOutcome<Readonly<{ contractId: ContractId }>, OperationRefusals["bind"]>;
}>;

/**
 * A legally non-forkable source is an expected refusal; corrupt persisted authority for a source that
 * does exist is exceptional and names that source Contract.
 */
export async function admitForkBindWithAppointment(
  input: Readonly<{
    scope: RepositoryScope;
    channel: GitDecodeChannel;
    sourceId: ContractId;
    target?: string;
    progress?: ProtocolProgress;
    actor?: ActorId;
  }>,
): Promise<Readonly<{ kind: "refused"; refusal: ForkSourceRefusal }> | ForkBindAdmission> {
  const missing = (): Readonly<{ kind: "refused"; refusal: ForkSourceRefusal }> => ({
    kind: "refused",
    refusal: { kind: "fork-source-missing", contractId: input.sourceId },
  });
  let source = await stateOperation({ scope: input.scope, channel: input.channel, contractId: input.sourceId });
  if (source === null) return missing();
  const sourceObject = (await input.channel.readObjects([source.coordinates.start as never])).get(
    source.coordinates.start as never,
  );
  if (sourceObject === undefined) throw new Error(`missing fork source object observation: ${input.sourceId}`);
  if (sourceObject.kind !== "present" || sourceObject.type !== "commit") {
    return { kind: "refused", refusal: { kind: "fork-source-unavailable", contractId: input.sourceId } };
  }
  const currentSource = await stateOperation({
    scope: input.scope,
    channel: input.channel,
    contractId: input.sourceId,
  });
  if (
    currentSource === null ||
    currentSource.head !== source.head ||
    currentSource.coordinates.start !== source.coordinates.start ||
    currentSource.terms.document.key !== source.terms.document.key
  ) {
    return { kind: "refused", refusal: { kind: "fork-source-moved", contractId: input.sourceId } };
  }
  source = currentSource;
  let sourceDocument: ReturnType<typeof decodeContractDocument>;
  try {
    sourceDocument = decodeContractDocument(source.terms.document.bytes);
  } catch (error) {
    if (error instanceof AuthorityCorruptionError) throw error;
    throw new KeiyakuError("authority-corruption", `fork source ${input.sourceId} has an undecodable document`, {
      cause: error,
    });
  }
  const markdown = sourceDocument.document.bytes.replace(
    /^\s*#\s*[^\r\n]*(?:\r?\n|$)/u,
    `# Fork · ${sourceDocument.title}${sourceDocument.document.bytes.includes("\r\n") ? "\r\n" : "\n"}`,
  );
  const document = decodeCanonicalContractDocument(markdown, { requireTimeout: true });
  const terms = contractTerms(document, source.terms.gates, source.terms.after);
  const admission = await attemptCandidates({
    scope: input.scope,
    channel: input.channel,
    title: document.title,
    terms,
    verification: documentDerivation(document, terms.gates).verification,
    workspace: "worktree",
    targetSelection:
      input.target === undefined
        ? source.coordinates.target === undefined
          ? { kind: "targetless" }
          : { kind: "explicit", target: source.coordinates.target }
        : { kind: "explicit", target: input.target },
    coordinates: { start: source.coordinates.start },
    source: {
      contractId: input.sourceId,
      head: source.head,
      start: source.coordinates.start,
      document: source.terms.document.key,
    },
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(input.progress === undefined ? {} : { progress: input.progress }),
  });
  return { kind: "document", admission, document };
}

export async function admitMarkdownBind(
  input: Readonly<{
    scope: RepositoryScope;
    channel: GitDecodeChannel;
    title: string;
    terms: Parameters<typeof bindOperation>[0]["terms"];
    verification: VerificationDeclarationPreparation;
    workspace: "worktree";
    targetSelection?: BindTargetSelection;
    task?: TaskId;
    progress?: ProtocolProgress;
    actor?: ActorId;
  }>,
) {
  return await admitBindWithAppointment(input);
}

export async function prepareMarkdownBind(
  input: Readonly<{
    scope: RepositoryScope;
    channel: GitDecodeChannel;
    document: ReturnType<typeof decodeContractDocument>;
    gates: readonly import("../core/facts/types.js").Gate[];
    after: readonly ContractId[];
    workspace: "worktree";
    targetSelection?: BindTargetSelection;
    task?: TaskId;
    progress?: ProtocolProgress;
    actor?: ActorId;
  }>,
) {
  const terms = contractTerms(input.document, input.gates, input.after);
  const admitCandidate = () =>
    admitMarkdownBind({
      scope: input.scope,
      channel: input.channel,
      title: input.document.title,
      terms,
      verification: documentDerivation(input.document, terms.gates).verification,
      workspace: input.workspace,
      ...(input.targetSelection === undefined ? {} : { targetSelection: input.targetSelection }),
      ...(input.task === undefined ? {} : { task: input.task }),
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      ...(input.progress === undefined ? {} : { progress: input.progress }),
    });
  const admission =
    input.task === undefined ? null : await claimTaskHolderWithFence(input.scope, input.task, admitCandidate);
  return { admission, result: admission === null ? await admitCandidate() : admission.result };
}
