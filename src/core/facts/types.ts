export { declarationKey } from "../declaration-key.js";
export type { DeclarationKey } from "../declaration-key.js";
import type { DeclarationKey } from "../declaration-key.js";

declare const contractIdBrand: unique symbol;
declare const entryUlidBrand: unique symbol;
declare const contractHeadBrand: unique symbol;
declare const snapshotIdBrand: unique symbol;
declare const changeIdBrand: unique symbol;

export type ContractId = string & { readonly [contractIdBrand]: "ContractId" };
export type EntryUlid = string & { readonly [entryUlidBrand]: "EntryUlid" };
export type ContractHead = string & { readonly [contractHeadBrand]: "ContractHead" };
export type SnapshotId = string & { readonly [snapshotIdBrand]: "SnapshotId" };
export type ChangeId = string & { readonly [changeIdBrand]: "ChangeId" };

const ULID = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const CONTRACT_ID = /^kei\/([a-z0-9][a-z0-9-]*)$/;

function requireText(value: string, label: string): string {
  if (value.length === 0 || /\s/.test(value)) throw new Error(`${label} must be nonempty and contain no whitespace`);
  return value;
}

function requireOpaqueId(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} must be nonblank`);
  return value;
}

export function contractId(value: string): ContractId {
  requireText(value, "contract ID");
  if (!CONTRACT_ID.test(value)) throw new Error("contract ID must be kei/<lowercase-machine-contract>");
  return value as ContractId;
}

export function entryUlid(value: string): EntryUlid {
  if (!ULID.test(value)) throw new Error("entry ULID must be a canonical 26-character uppercase ULID");
  return value as EntryUlid;
}

export function contractHead(value: string): ContractHead {
  return requireOpaqueId(value, "contract head") as ContractHead;
}

/** Validate an opaque persisted snapshot value; only a carrier may mint one. */
export function snapshotId(value: string): SnapshotId {
  return requireOpaqueId(value, "snapshot ID") as SnapshotId;
}

/** Validate an opaque persisted change value; only a carrier may mint one. */
export function changeId(value: string): ChangeId {
  return requireOpaqueId(value, "change ID") as ChangeId;
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

export type ContractCriterion = Readonly<{
  title: string;
  body: string;
}>;

export type Gate = "reviewed" | "verified";

export type ContractCoordinates = Readonly<{
  start: SnapshotId;
  target?: string;
  workspace: "worktree" | "here";
}>;

export type ContractBody = Readonly<{
  title: string;
  context: string;
  objective: string;
  design: string;
  region: readonly string[];
  criteria: readonly ContractCriterion[];
  verification: readonly VerificationDeclaration[];
  extensions: readonly ContractExtension[];
  gates?: readonly Gate[];
  after?: readonly ContractId[];
}>;

export type BindData = Readonly<{
  coordinates: ContractCoordinates;
  body: ContractBody;
}>;

export type AmendData = ContractBody;

export type BoundData = Readonly<Record<string, never>>;

export type VerificationData = Readonly<{
  candidate: SnapshotId;
  declarationKey: DeclarationKey;
  result: "pass" | "fail";
  summary?: string;
}>;

export type DeliverData = Readonly<{
  expectedPredecessor: SnapshotId;
  candidate: SnapshotId;
  deliveryPatchId: ChangeId;
}>;

export type ReviewData = Readonly<{
  verdict: "approved" | "changes-requested";
  reviewedPatchId: ChangeId;
  reviewedHead: SnapshotId;
  summary?: string;
}>;

export type ClaimedData = Readonly<{
  delivery: EntryUlid;
}>;

export type ArcData = Readonly<{
  seq: number;
  title: string;
  objective: string;
  brief: string;
}>;

export type AbandonData = Readonly<{
  note?: string;
}>;

export type AbandonedData = Readonly<{
  finalHead: SnapshotId | null;
}>;

export type JournalEnvelope<Kind extends string, Data> = Readonly<{
  v: 1;
  kind: Kind;
  contract: ContractId;
  entry: EntryUlid;
  at: string;
  actor?: string;
  data: Data;
}>;

export type BindEntry = JournalEnvelope<"bind", BindData>;
export type AmendEntry = JournalEnvelope<"amend", AmendData>;
export type BoundEntry = JournalEnvelope<"bound", BoundData>;
export type DeliverEntry = JournalEnvelope<"deliver", DeliverData>;
export type ReviewEntry = JournalEnvelope<"review", ReviewData>;
export type VerificationEntry = JournalEnvelope<"verification", VerificationData>;
export type ClaimedEntry = JournalEnvelope<"claimed", ClaimedData>;
export type ArcEntry = JournalEnvelope<"arc", ArcData>;
export type AbandonEntry = JournalEnvelope<"abandon", AbandonData>;
export type AbandonedEntry = JournalEnvelope<"abandoned", AbandonedData>;

export type JournalEntry =
  | BindEntry
  | AmendEntry
  | BoundEntry
  | DeliverEntry
  | ReviewEntry
  | VerificationEntry
  | ClaimedEntry
  | ArcEntry
  | AbandonEntry
  | AbandonedEntry;

export type FactKind = JournalEntry["kind"];

export type ContractTerminal = ClaimedEntry | AbandonedEntry;

export type ContractState = Readonly<{
  id: ContractId;
  head: ContractHead | null;
  coordinates: ContractCoordinates | null;
  body: ContractBody | null;
  bound: BoundEntry | null;
  delivery: DeliverEntry | null;
  reviews: readonly ReviewEntry[];
  verifications: readonly VerificationEntry[];
  currentArc?: ArcEntry;
  abandon: AbandonEntry | null;
  terminal: ContractTerminal | null;
}>;
