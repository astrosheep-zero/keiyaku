declare const contractIdBrand: unique symbol;
declare const entryUlidBrand: unique symbol;
declare const contractHeadBrand: unique symbol;
declare const blobOidBrand: unique symbol;
declare const commitOidBrand: unique symbol;

export type ContractId = string & { readonly [contractIdBrand]: "ContractId" };
export type EntryUlid = string & { readonly [entryUlidBrand]: "EntryUlid" };
export type ContractHead = string & { readonly [contractHeadBrand]: "ContractHead" };
export type BlobOid = string & { readonly [blobOidBrand]: "BlobOid" };
export type CommitOid = string & { readonly [commitOidBrand]: "CommitOid" };

const ULID = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const CONTRACT_ID = /^kei\/([a-z0-9][a-z0-9-]*)$/;

function requireText(value: string, label: string): string {
  if (value.length === 0 || /\s/.test(value)) throw new Error(`${label} must be nonempty and contain no whitespace`);
  return value;
}

function requireOid(value: string, label: string): string {
  if (!OID.test(value)) throw new Error(`${label} must be a lowercase SHA-1 or SHA-256 object ID`);
  return value;
}

export function contractId(value: string): ContractId {
  requireText(value, "contract ID");
  if (!CONTRACT_ID.test(value)) {
    throw new Error("contract ID must be kei/<lowercase-machine-contract>");
  }
  return value as ContractId;
}

function contractPayload(contract: ContractId): string {
  const match = CONTRACT_ID.exec(contract);
  if (!match) throw new TypeError(`invalid contract ID: ${contract}`);
  return match[1]!;
}

export function entryUlid(value: string): EntryUlid {
  if (!ULID.test(value)) throw new Error("entry ULID must be a canonical 26-character uppercase ULID");
  return value as EntryUlid;
}

export function blobOid(value: string): BlobOid {
  return requireOid(value, "blob OID") as BlobOid;
}

export function contractHead(value: string): ContractHead {
  return requireOid(value, "contract head") as ContractHead;
}

export function commitOid(value: string): CommitOid {
  return requireOid(value, "commit OID") as CommitOid;
}

export type Phase =
  | "active"
  | "sealed"
  | "awaiting-verdict"
  | "approved"
  | "claimed"
  | "forfeited";

export type EvidenceRef = Readonly<{
  entry: EntryUlid;
  seq: number;
  kind: string;
  oid: BlobOid;
}>;

export function evidenceKind(kind: string): string {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(kind)) {
    throw new Error("evidence kind must be a lowercase path-safe name");
  }
  return kind;
}

export function evidencePath(contract: ContractId, ref: EvidenceRef): string;
export function evidencePath(input: Readonly<{ contract: ContractId; ref: EvidenceRef }>): string;
export function evidencePath(
  contractOrInput: ContractId | Readonly<{ contract: ContractId; ref: EvidenceRef }>,
  maybeRef?: EvidenceRef,
): string {
  const contract = typeof contractOrInput === "string" ? contractOrInput : contractOrInput.contract;
  const ref = typeof contractOrInput === "string" ? maybeRef : contractOrInput.ref;
  if (!ref) throw new Error("evidence path requires an evidence reference");
  if (!Number.isSafeInteger(ref.seq) || ref.seq < 0) throw new Error("evidence sequence must be a nonnegative safe integer");
  return `contracts/${contractPayload(contract)}/evidence/${ref.entry}/${ref.seq}-${evidenceKind(ref.kind)}`;
}

export function contractJournalPath(contract: ContractId): string {
  return `contracts/${contractPayload(contract)}.jsonl`;
}

export type VerificationExecutor = "bash" | "zsh" | "pwsh";
export type VerificationDeclaration = Readonly<{
  executor: VerificationExecutor;
  script: string;
}>;

export type ContractExtension = Readonly<{
  title: string;
  content: string;
}>;

export type ContractBody = Readonly<{
  title: string;
  context: string;
  objective: string;
  design: string;
  region: readonly string[];
  criteria: readonly string[];
  verification: readonly VerificationDeclaration[];
  extensions: readonly ContractExtension[];
}>;

export type SectionTarget = "context" | "objective" | "design" | Readonly<{ extension: string }>;
export type SectionRevision = Readonly<{
  target: SectionTarget;
  op: "replace" | "append" | "add";
  body: string;
}>;

export type CriteriaDelta =
  | Readonly<{ add: readonly string[] }>
  | Readonly<{ replace: readonly string[] }>;

export type DeliveryCoordinate = Readonly<{
  base: CommitOid;
  head: CommitOid;
}>;

export type AmendData = Readonly<{
  revisions?: readonly SectionRevision[];
  region?: readonly string[];
  criteriaDelta?: CriteriaDelta;
  verificationDelta?: Readonly<{ replace: readonly VerificationDeclaration[] }>;
}>;

export type SealData = Readonly<Record<string, never>>;

export type ClaimData = Readonly<{
  petition: EntryUlid;
}>;

export type RenewData = Readonly<{
  oldHead: CommitOid;
  newHead: CommitOid;
}>;

export type PetitionData =
  | Readonly<{
    intent: "claim";
    oath: string;
    expectedPredecessor: CommitOid;
    seat: number;
    candidate: CommitOid;
  }>
  | Readonly<{
    intent: "forfeit";
    seat: number;
  }>;

export type ForfeitData = Readonly<{
  reason: "manual" | "bind-failed";
  note?: string;
}>;

export type ReviewData = Readonly<{
  verdict: "approved" | "changes-requested";
  digest: string;
  summary: string;
  evidence: readonly EvidenceRef[];
}>;

export type CheckData = Readonly<{
  result: "pass" | "fail";
  summary: string;
  evidence: readonly EvidenceRef[];
}>;

export type VerificationData = Readonly<{
  result: "pass" | "fail";
  summary: string;
  evidence: readonly EvidenceRef[];
}>;

export type JournalEnvelope<Kind extends string, Data> = Readonly<{
  v: 1;
  kind: Kind;
  contract: ContractId;
  entry: EntryUlid;
  at: string;
  actor: string;
  data: Data;
}>;

export type BindEntry = JournalEnvelope<"bind", ContractBody>;
export type AmendEntry = JournalEnvelope<"amend", AmendData>;
export type SealEntry = JournalEnvelope<"seal", SealData>;
export type ClaimEntry = JournalEnvelope<"claim", ClaimData>;
export type RenewEntry = JournalEnvelope<"renew", RenewData>;
export type PetitionEntry = JournalEnvelope<"petition", PetitionData>;
export type ForfeitEntry = JournalEnvelope<"forfeit", ForfeitData>;
export type ReviewEntry = JournalEnvelope<"review", ReviewData>;
export type CheckEntry = JournalEnvelope<"check", CheckData>;
export type VerificationEntry = JournalEnvelope<"verification", VerificationData>;

export type JournalEntry =
  | BindEntry
  | AmendEntry
  | SealEntry
  | ClaimEntry
  | RenewEntry
  | PetitionEntry
  | ForfeitEntry
  | ReviewEntry
  | CheckEntry
  | VerificationEntry;

export type JournalEntryKind = JournalEntry["kind"];

export type ContractState = Readonly<{
  id: ContractId;
  head: ContractHead | null;
  phase: Phase;
  body: ContractBody | null;
  delivery: DeliveryCoordinate | null;
  petition: PetitionEntry | null;
  evidence: readonly (ReviewEntry | CheckEntry | VerificationEntry)[];
  terminal: ClaimEntry | ForfeitEntry | null;
}>;
