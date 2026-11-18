import {
  changeId,
  entryUlid,
  type EntryUlid,
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
import { AuthorityCorruptionError } from "./facts/errors.js";

export type DependencyKey = Readonly<
  | { readonly kind: "document"; readonly value: DocumentKey }
  | { readonly kind: "segment"; readonly value: DocumentSegmentKey }
  | { readonly kind: "snapshot"; readonly value: SnapshotId }
  | { readonly kind: "change"; readonly value: ChangeId }
  | { readonly kind: "target"; readonly value: EntryUlid }
>;

function keyTuple(key: DependencyKey): readonly [DependencyKey["kind"], string] {
  return [key.kind, key.value];
}

function encodeKey(key: DependencyKey): string {
  return JSON.stringify(keyTuple(key));
}

type DecodedDependencyKeySet = Readonly<{
  canonical: DependencyKeySet;
  encodedKeys: readonly string[];
  keys: readonly DependencyKey[];
}>;

function parseKey(value: unknown, index: number): DependencyKey {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string") {
    throw new AuthorityCorruptionError(`dependency key [${index}] must be a [kind, value] pair`);
  }
  try {
    switch (value[0]) {
      case "document":
        return { kind: "document", value: documentKey(value[1]) };
      case "segment":
        return { kind: "segment", value: documentSegmentKey(value[1]) };
      case "snapshot":
        return { kind: "snapshot", value: snapshotId(value[1]) };
      case "change":
        return { kind: "change", value: changeId(value[1]) };
      case "target":
        return { kind: "target", value: entryUlid(value[1]) };
      default:
        throw new AuthorityCorruptionError(`unknown dependency key kind '${value[0]}'`);
    }
  } catch (error) {
    throw error instanceof AuthorityCorruptionError
      ? error
      : new AuthorityCorruptionError(error instanceof Error ? error.message : `invalid dependency key [${index}]`);
  }
}

function canonicalEncodedKeys(keys: readonly DependencyKey[]): readonly string[] {
  const encoded = keys.map(encodeKey).sort();
  for (let index = 1; index < encoded.length; index += 1) {
    if (encoded[index] === encoded[index - 1])
      throw new AuthorityCorruptionError("dependency key set cannot contain duplicates");
  }
  return encoded;
}

function canonicalKeys(keys: readonly DependencyKey[]): string {
  return `[${canonicalEncodedKeys(keys).join(",")}]`;
}

/** Mint the opaque persisted representation of an ordered producer-selected key set. */
export function dependencyKeySet(keys: readonly DependencyKey[]): DependencyKeySet {
  return canonicalKeys(keys) as DependencyKeySet;
}

function decodeDependencyKeySet(value: string): DecodedDependencyKeySet {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AuthorityCorruptionError("dependency key set must be nonblank");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new AuthorityCorruptionError("dependency key set must be canonical JSON", { cause: error });
  }
  if (!Array.isArray(parsed)) throw new AuthorityCorruptionError("dependency key set must be an array");
  const keys = parsed.map(parseKey);
  const encodedKeys = canonicalEncodedKeys(keys);
  const canonical = `[${encodedKeys.join(",")}]`;
  if (canonical !== value) throw new AuthorityCorruptionError("dependency key set must be canonical JSON");
  return { canonical: canonical as DependencyKeySet, encodedKeys, keys };
}

/** Parse and canonicalize the opaque dependency-key set. */
export function parseDependencyKeySet(value: string): DependencyKeySet {
  return decodeDependencyKeySet(value).canonical;
}

/** Return the validated dependency keys in a persisted subject. */
export function dependencyKeys(value: DependencyKeySet): readonly DependencyKey[] {
  return decodeDependencyKeySet(value).keys;
}

function currentKeys(
  state: ContractState,
  integration: NonNullable<ContractState["currentIntegration"]> | undefined,
): ReadonlySet<string> {
  return new Set([
    encodeKey({ kind: "document", value: state.terms.document.key }),
    ...state.terms.segments.map((value) => encodeKey({ kind: "segment", value })),
    ...(state.targetRevision === undefined ? [] : [encodeKey({ kind: "target", value: state.targetRevision })]),
    ...(integration === undefined
      ? []
      : [
          encodeKey({ kind: "snapshot", value: integration.snapshot }),
          encodeKey({ kind: "change", value: integration.changeId }),
        ]),
  ]);
}

export type SubjectApplicability = "current" | "stale" | "applicability-pending";

/** Judge dependencies against one folded Contract observation. */
export function subjectApplicabilityFor(state: ContractState): (subject: DependencyKeySet) => SubjectApplicability {
  const integration = state.currentIntegration ?? state.delivery?.data.integration;
  const available = currentKeys(state, integration);
  const canBePending = state.terminal === null && state.delivery === null && integration === undefined;
  const observed = new Map<DependencyKeySet, SubjectApplicability>();
  function classify(subject: DependencyKeySet): SubjectApplicability {
    const { keys } = decodeDependencyKeySet(subject);
    // A retained snapshot still carries the target fence even when content determines currency.
    if (
      state.targetRevision !== undefined &&
      keys.some((key) => key.kind === "snapshot") &&
      !keys.some((key) => key.kind === "target" && key.value === state.targetRevision)
    ) {
      return "stale";
    }
    const hasChange = keys.some((key) => key.kind === "change");
    let applicability: SubjectApplicability = "current";
    for (const key of keys) {
      if ((hasChange && key.kind === "snapshot") || available.has(encodeKey(key))) continue;
      if (!canBePending || (key.kind !== "snapshot" && key.kind !== "change")) return "stale";
      applicability = "applicability-pending";
    }
    return applicability;
  }
  return (subject) => {
    const known = observed.get(subject);
    if (known !== undefined) return known;
    const value = classify(subject);
    observed.set(subject, value);
    return value;
  };
}
