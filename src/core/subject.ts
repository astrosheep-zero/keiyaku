import {
  changeId,
  documentKey,
  documentSegmentKey,
  snapshotId,
  type ChangeId,
  type ContractState,
  type DependencyKeySet,
  type DocumentKey,
  type DocumentSegmentKey,
  type SnapshotId,
} from "./facts/types.js";

export type DependencyKey = Readonly<
  | { readonly kind: "document"; readonly value: DocumentKey }
  | { readonly kind: "segment"; readonly value: DocumentSegmentKey }
  | { readonly kind: "snapshot"; readonly value: SnapshotId }
  | { readonly kind: "change"; readonly value: ChangeId }
>;

function encodeKey(key: DependencyKey): string {
  return JSON.stringify([key.kind, key.value]);
}

function parseKey(value: unknown, index: number): DependencyKey {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string") {
    throw new TypeError(`dependency key [${index}] must be a [kind, value] pair`);
  }
  try {
    switch (value[0]) {
      case "document": return { kind: "document", value: documentKey(value[1]) };
      case "segment": return { kind: "segment", value: documentSegmentKey(value[1]) };
      case "snapshot": return { kind: "snapshot", value: snapshotId(value[1]) };
      case "change": return { kind: "change", value: changeId(value[1]) };
      default: throw new TypeError(`unknown dependency key kind '${value[0]}'`);
    }
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : `invalid dependency key [${index}]`);
  }
}

function canonicalKeys(keys: readonly DependencyKey[]): string {
  const values = keys.map(encodeKey).sort();
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] === values[index - 1]) throw new TypeError("dependency key set cannot contain duplicates");
  }
  return JSON.stringify(values);
}

/** Mint the opaque persisted representation of an ordered producer-selected key set. */
export function dependencyKeySet(keys: readonly DependencyKey[]): DependencyKeySet {
  if (!Array.isArray(keys)) throw new TypeError("dependency key set must be an array");
  return canonicalKeys(keys) as DependencyKeySet;
}

/** Parse and canonicalize the opaque dependency-key-set fact value. */
export function parseDependencyKeySet(value: string): DependencyKeySet {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("dependency key set must be nonblank");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError("dependency key set must be canonical JSON", { cause: error });
  }
  if (!Array.isArray(parsed)) throw new TypeError("dependency key set must be an array");
  const keys = parsed.map(parseKey);
  const canonical = canonicalKeys(keys);
  if (canonical !== value) throw new TypeError("dependency key set must be canonical JSON");
  return canonical as DependencyKeySet;
}

function currentKeys(state: ContractState): ReadonlySet<string> | null {
  if (state.delivery === null || state.terms === null) return null;
  return new Set([
    encodeKey({ kind: "document", value: state.terms.document }),
    ...state.terms.segments.map((value) => encodeKey({ kind: "segment", value })),
    encodeKey({ kind: "snapshot", value: state.delivery.data.candidate }),
    encodeKey({ kind: "change", value: state.delivery.data.deliveryPatchId }),
  ]);
}

/** Return whether every producer-selected dependency key remains current. */
export function subjectIsCurrent(state: ContractState, subject: DependencyKeySet): boolean {
  const available = currentKeys(state);
  if (available === null) return false;
  const selected = JSON.parse(parseDependencyKeySet(subject)) as readonly [string, string][];
  return selected.every((key) => available.has(JSON.stringify(key)));
}
