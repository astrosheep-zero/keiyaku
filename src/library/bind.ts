import { randomBytes } from "node:crypto";
import { decodeContractDocument } from "../body/decode.js";
import { decodeCanonicalContractDocument } from "../body/render.js";
import { contractIdFromSegment, type ContractId } from "../core/facts/types.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { mintIdentitySegment } from "../identity/mint.js";
import { fitIdentityStemWords, normalizeIdentityStem } from "../identity/normalize.js";
import { bindOperation, type BindTargetSelection } from "../protocol/bind.js";
import { stateOperation, type RepositoryScope } from "../protocol/operations.js";
import { admitWithDebtHolderFence, claimDebtHolder } from "../settlement/holder.js";
import type { ProtocolProgress } from "../protocol/progress.js";
import type { DebtId } from "../debt/identity.js";
import type { VerificationDeclarationPreparation } from "../verification/declaration.js";
import type { ForkSourceRefusal } from "./refusal.js";
import { gitObjectIdForSnapshot } from "../git/identity.js";
import { KeiyakuError } from "./outcome.js";
import { contractTerms, documentDerivation } from "./input.js";

type BindAttemptInput = Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  title: string;
  terms: Parameters<typeof bindOperation>[0]["terms"];
  verification: VerificationDeclarationPreparation;
  targetSelection: BindTargetSelection;
  coordinates?: Readonly<{ start: import("../core/facts/types.js").SnapshotId }>;
  source?: Parameters<typeof bindOperation>[0]["source"];
  debt?: DebtId;
  progress?: ProtocolProgress;
}>;

const CONTRACT_ID_CODE_POINTS = 32;
const CONTRACT_ID_ATTEMPTS = 4;

/** A fork with no target copies its source; `null` clears it and a string overrides it. */
function forkTargetSelection(
  target: string | null | undefined,
  sourceTarget: import("../core/facts/types.js").ContractTarget | undefined,
): BindTargetSelection {
  if (target === null) return { kind: "targetless" };
  if (target !== undefined) return { kind: "explicit", target };
  return sourceTarget === undefined
    ? { kind: "targetless" }
    : typeof sourceTarget === "string"
      ? { kind: "explicit", target: sourceTarget }
      : { kind: "contract", contractId: sourceTarget.contractId, inherited: sourceTarget };
}

function drawContractSuffix(): string {
  return randomBytes(2).toString("hex");
}

async function attempt(input: BindAttemptInput, id: ContractId) {
  return bindOperation({
    scope: input.scope,
    channel: input.channel,
    terms: input.terms,
    verification: input.verification,
    targetSelection: input.targetSelection,
    ...(input.coordinates === undefined ? {} : { coordinates: input.coordinates }),
    ...(input.source === undefined ? {} : { source: input.source }),
    contractId: id,
    ...(input.debt === undefined
      ? {}
      : {
          decorateOffer: ({ contractId: owner }) => [claimDebtHolder(input.debt!, owner)],
        }),
    ...(input.progress === undefined ? {} : { progress: input.progress }),
  });
}

async function attemptCandidates(input: BindAttemptInput): Promise<Awaited<ReturnType<typeof bindOperation>>> {
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

type ForkBindAdmission = Readonly<{
  kind: "document";
  document: ReturnType<typeof decodeContractDocument>;
  admission: Awaited<ReturnType<typeof bindOperation>>;
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
    target?: string | null;
    progress?: ProtocolProgress;
  }>,
): Promise<Readonly<{ kind: "refused"; refusal: ForkSourceRefusal }> | ForkBindAdmission> {
  const missing = (): Readonly<{ kind: "refused"; refusal: ForkSourceRefusal }> => ({
    kind: "refused",
    refusal: { kind: "fork-source-missing" },
  });
  let source = await stateOperation({ scope: input.scope, channel: input.channel, contractId: input.sourceId });
  if (source === null) return missing();
  const sourceOid = gitObjectIdForSnapshot(source.coordinates.start);
  const sourceObject = (await input.channel.readObjects([sourceOid])).get(sourceOid);
  if (sourceObject === undefined) throw new Error(`missing fork source object observation: ${input.sourceId}`);
  if (sourceObject.kind !== "present" || sourceObject.type !== "commit") {
    return { kind: "refused", refusal: { kind: "fork-source-unavailable" } };
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
    return { kind: "refused", refusal: { kind: "fork-source-moved" } };
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
    verification: documentDerivation(document).verification,
    targetSelection: forkTargetSelection(input.target, source.coordinates.target),
    coordinates: { start: source.coordinates.start },
    source: {
      contractId: input.sourceId,
      head: source.head,
      start: source.coordinates.start,
      document: source.terms.document.key,
    },
    ...(input.progress === undefined ? {} : { progress: input.progress }),
  });
  return { kind: "document", admission, document };
}

export async function prepareMarkdownBind(
  input: Readonly<{
    scope: RepositoryScope;
    channel: GitDecodeChannel;
    document: ReturnType<typeof decodeContractDocument>;
    gates: readonly import("../core/facts/types.js").Gate[];
    after: readonly ContractId[];
    targetSelection: BindTargetSelection;
    debt?: DebtId;
    progress?: ProtocolProgress;
  }>,
) {
  const terms = contractTerms(input.document, input.gates, input.after);
  const admitCandidate = () =>
    attemptCandidates({
      scope: input.scope,
      channel: input.channel,
      title: input.document.title,
      terms,
      verification: documentDerivation(input.document).verification,
      targetSelection: input.targetSelection,
      ...(input.debt === undefined ? {} : { debt: input.debt }),
      ...(input.progress === undefined ? {} : { progress: input.progress }),
    });
  const admission =
    input.debt === undefined ? null : await admitWithDebtHolderFence(input.scope, input.debt, admitCandidate);
  return { admission, result: admission === null ? await admitCandidate() : admission.result };
}
