declare const contractIdBrand: unique symbol;
declare const entryUlidBrand: unique symbol;
declare const contractHeadBrand: unique symbol;
declare const snapshotIdBrand: unique symbol;
declare const changeIdBrand: unique symbol;
declare const documentKeyBrand: unique symbol;
declare const documentSegmentKeyBrand: unique symbol;
declare const gateBrand: unique symbol;
declare const dependencyKeySetBrand: unique symbol;
declare const actorIdBrand: unique symbol;

export type ContractId = string & { readonly [contractIdBrand]: "ContractId" };
export type EntryUlid = string & { readonly [entryUlidBrand]: "EntryUlid" };
export type ContractHead = string & { readonly [contractHeadBrand]: "ContractHead" };
export type SnapshotId = string & { readonly [snapshotIdBrand]: "SnapshotId" };
export type ChangeId = string & { readonly [changeIdBrand]: "ChangeId" };
export type DocumentKey = string & { readonly [documentKeyBrand]: "DocumentKey" };
export type DocumentSegmentKey = string & { readonly [documentSegmentKeyBrand]: "DocumentSegmentKey" };
export type Gate = string & { readonly [gateBrand]: "Gate" };
export type DependencyKeySet = string & { readonly [dependencyKeySetBrand]: "DependencyKeySet" };
export type ActorId = string & { readonly [actorIdBrand]: "ActorId" };

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

/** Validate optional opaque testimony without imposing a registry. */
export function actorId(value: string): ActorId {
  return requireOpaqueId(value, "actor") as ActorId;
}

export function documentKey(value: string): DocumentKey {
  return requireOpaqueId(value, "document key") as DocumentKey;
}

export function documentSegmentKey(value: string): DocumentSegmentKey {
  return requireOpaqueId(value, "document segment key") as DocumentSegmentKey;
}

export function gate(value: string): Gate {
  return requireOpaqueId(value, "gate") as Gate;
}

export type ContractCoordinates = Readonly<{
  start: SnapshotId;
  target?: string;
  workspace: "worktree" | "here";
}>;

export type ContractTerms = Readonly<{
  document: DocumentKey;
  segments: readonly DocumentSegmentKey[];
  gates: readonly Gate[];
  after: readonly ContractId[];
}>;

export type BindData = Readonly<{
  coordinates: ContractCoordinates;
  terms: ContractTerms;
}>;

export type AmendData = ContractTerms;

export type BoundData = Readonly<Record<string, never>>;

export type DeliverData = Readonly<{
  expectedPredecessor: SnapshotId;
  candidate: SnapshotId;
  deliveryPatchId: ChangeId;
}>;

export type AttestationData = Readonly<{
  gate: Gate;
  subject: DependencyKeySet;
  verdict: "satisfied" | "unsatisfied";
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
  actor?: ActorId;
  data: Data;
}>;

export type BindEntry = JournalEnvelope<"bind", BindData>;
export type AmendEntry = JournalEnvelope<"amend", AmendData>;
export type BoundEntry = JournalEnvelope<"bound", BoundData>;
export type DeliverEntry = JournalEnvelope<"deliver", DeliverData>;
export type AttestationEntry = JournalEnvelope<"attestation", AttestationData>;
export type ClaimedEntry = JournalEnvelope<"claimed", ClaimedData>;
export type ArcEntry = JournalEnvelope<"arc", ArcData>;
export type AbandonEntry = JournalEnvelope<"abandon", AbandonData>;
export type AbandonedEntry = JournalEnvelope<"abandoned", AbandonedData>;

export type JournalEntry =
  | BindEntry
  | AmendEntry
  | BoundEntry
  | DeliverEntry
  | AttestationEntry
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
  terms: ContractTerms | null;
  bound: BoundEntry | null;
  delivery: DeliverEntry | null;
  attestations: readonly AttestationEntry[];
  currentArc?: ArcEntry;
  abandon: AbandonEntry | null;
  terminal: ContractTerminal | null;
}>;
