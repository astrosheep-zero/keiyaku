import type {
  AbandonedData,
  AmendData,
  AttestationData,
  ArcData,
  BindData,
  BoundData,
  ContractTerms,
  ContractCoordinates,
  DeliverData,
  ClaimedData,
  JournalEntry,
  DependencyKeySet,
} from "./types.js";
import { parseDependencyKeySet } from "../subject.js";
import { AuthorityCorruptionError } from "./errors.js";
import {
  changeId,
  actorId,
  contractId,
  documentKey,
  documentSegmentKey,
  entryUlid,
  gate,
  snapshotId,
} from "./types.js";

type RecordValue = Record<string, unknown>;

const VERSION_BY_KIND = {
  bind: 1,
  amend: 1,
  bound: 1,
  deliver: 1,
  attestation: 1,
  claimed: 1,
  arc: 1,
  abandoned: 1,
} as const;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new AuthorityCorruptionError(`${path}: ${message}`);
}

function requireRecord(value: unknown, path: string): RecordValue {
  if (!isRecord(value)) fail(path, "expected an object");
  return value;
}

function requireKeys(
  value: RecordValue,
  required: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  const expected = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(path, `unknown field '${key}'`);
  }
  for (const key of required) {
    if (!(key in value)) fail(path, `missing field '${key}'`);
  }
}

function stringValue(value: unknown, path: string, nonblank = true): string {
  if (typeof value !== "string" || (nonblank && value.trim().length === 0)) {
    fail(path, nonblank ? "expected a nonblank string" : "expected a string");
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}

function brandedValue<T>(value: unknown, path: string, brand: (value: string) => T): T {
  const text = stringValue(value, path);
  try {
    return brand(text);
  } catch (error) {
    fail(path, error instanceof Error ? error.message : "invalid branded value");
  }
}

function dependencyKeySetValue(value: unknown, path: string): DependencyKeySet {
  if (typeof value !== "string") fail(path, "expected a canonical dependency key set");
  try {
    return parseDependencyKeySet(value);
  } catch (error) {
    fail(path, error instanceof Error ? error.message : "invalid dependency key set");
  }
}

function documentValue(value: unknown, path: string): ContractTerms["document"] {
  const object = requireRecord(value, path);
  requireKeys(object, ["bytes", "key"], path);
  return {
    bytes: stringValue(object.bytes, `${path}.bytes`),
    key: brandedValue(object.key, `${path}.key`, documentKey),
  };
}

function arrayValue(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function brandedArray<T>(value: unknown, path: string, brand: (value: string) => T): readonly T[] {
  return arrayValue(value, path).map((item, index) => brandedValue(item, `${path}[${index}]`, brand));
}

function validateTimestamp(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)) {
    fail(path, "expected a UTC RFC-3339 timestamp");
  }
  const milliseconds = Date.parse(text);
  const canonical = Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : "";
  if (!Number.isFinite(milliseconds) || (text.includes(".") ? canonical !== text : canonical.replace(".000Z", "Z") !== text)) {
    fail(path, "expected a real canonical UTC timestamp");
  }
  return text;
}

function validateCoordinates(value: unknown, path: string): ContractCoordinates {
  const object = requireRecord(value, path);
  requireKeys(object, ["start", "workspace"], path, ["target"]);
  const workspace = stringValue(object.workspace, `${path}.workspace`);
  if (workspace !== "worktree" && workspace !== "here") fail(`${path}.workspace`, "unknown workspace");
  return {
    start: brandedValue(object.start, `${path}.start`, snapshotId),
    workspace,
    ...(object.target === undefined ? {} : { target: stringValue(object.target, `${path}.target`) }),
  };
}

function termsValue(value: unknown, path: string): ContractTerms {
  const object = requireRecord(value, path);
  requireKeys(object, ["document", "segments", "gates", "after"], path);
  return {
    document: documentValue(object.document, `${path}.document`),
    segments: brandedArray(object.segments, `${path}.segments`, documentSegmentKey),
    gates: brandedArray(object.gates, `${path}.gates`, gate),
    after: brandedArray(object.after, `${path}.after`, contractId),
  };
}

function validateAttestation(value: unknown, path: string): AttestationData {
  const object = requireRecord(value, path);
  requireKeys(object, ["gate", "subject", "verdict"], path, ["summary"]);
  const declaredGate = brandedValue(object.gate, `${path}.gate`, gate);
  const verdict = stringValue(object.verdict, `${path}.verdict`);
  if (verdict !== "satisfied" && verdict !== "unsatisfied") fail(`${path}.verdict`, "unknown attestation verdict");
  return {
    gate: declaredGate,
    subject: dependencyKeySetValue(object.subject, `${path}.subject`),
    verdict,
    ...(object.summary === undefined ? {} : { summary: stringValue(object.summary, `${path}.summary`) }),
  };
}

function validateArc(value: unknown, path: string): ArcData {
  const object = requireRecord(value, path);
  requireKeys(object, ["seq", "title", "objective", "brief"], path);
  const seq = object.seq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    fail(`${path}.seq`, "expected a positive safe integer");
  }
  return {
    seq,
    title: stringValue(object.title, `${path}.title`),
    objective: stringValue(object.objective, `${path}.objective`),
    brief: stringValue(object.brief, `${path}.brief`),
  };
}

function validateData(kind: JournalEntry["kind"], value: unknown): unknown {
  const path = `data.${kind}`;
  switch (kind) {
    case "bind": {
      const object = requireRecord(value, path);
      requireKeys(object, ["coordinates", "terms"], path);
      return {
        coordinates: validateCoordinates(object.coordinates, `${path}.coordinates`),
        terms: termsValue(object.terms, `${path}.terms`),
      } satisfies BindData;
    }
    case "amend":
      return termsValue(value, path) satisfies AmendData;
    case "bound": {
      const object = requireRecord(value, path);
      requireKeys(object, [], path);
      return {} satisfies BoundData;
    }
    case "deliver": {
      const object = requireRecord(value, path);
      requireKeys(object, ["tenderSnapshot", "integration", "method", "policy"], path);
      const integration = requireRecord(object.integration, `${path}.integration`);
      requireKeys(integration, ["predecessor", "snapshot", "changeId"], `${path}.integration`);
      const method = stringValue(object.method, `${path}.method`);
      if (method !== "squash") fail(`${path}.method`, "unknown merge method");
      const policy = requireRecord(object.policy, `${path}.policy`);
      requireKeys(policy, ["requireBranchesToBeUpToDate"], `${path}.policy`);
      return {
        tenderSnapshot: brandedValue(object.tenderSnapshot, `${path}.tenderSnapshot`, snapshotId),
        integration: {
          predecessor: brandedValue(integration.predecessor, `${path}.integration.predecessor`, snapshotId),
          snapshot: brandedValue(integration.snapshot, `${path}.integration.snapshot`, snapshotId),
          changeId: brandedValue(integration.changeId, `${path}.integration.changeId`, changeId),
        },
        method,
        policy: {
          requireBranchesToBeUpToDate: booleanValue(
            policy.requireBranchesToBeUpToDate,
            `${path}.policy.requireBranchesToBeUpToDate`,
          ),
        },
      } satisfies DeliverData;
    }
    case "attestation":
      return validateAttestation(value, path) satisfies AttestationData;
    case "claimed": {
      const object = requireRecord(value, path);
      requireKeys(object, ["delivery"], path);
      return { delivery: brandedValue(object.delivery, `${path}.delivery`, entryUlid) } satisfies ClaimedData;
    }
    case "arc":
      return validateArc(value, path) satisfies ArcData;
    case "abandoned": {
      const object = requireRecord(value, path);
      requireKeys(object, [], path, ["note"]);
      return {
        ...(object.note === undefined ? {} : { note: stringValue(object.note, `${path}.note`) }),
      } satisfies AbandonedData;
    }
  }
}

function validateEntry(value: unknown): JournalEntry {
  const object = requireRecord(value, "entry");
  requireKeys(object, ["v", "kind", "contract", "entry", "at", "data"], "entry", ["actor"]);
  const kind = object.kind;
  if (typeof kind !== "string" || !Object.hasOwn(VERSION_BY_KIND, kind)) {
    throw new AuthorityCorruptionError(`unknown journal entry kind: ${String(kind)}`);
  }
  const expectedVersion = VERSION_BY_KIND[kind as keyof typeof VERSION_BY_KIND];
  if (object.v !== expectedVersion) fail("entry.v", `expected version ${expectedVersion} for ${kind}`);
  const entry = {
    v: object.v,
    kind,
    contract: brandedValue(object.contract, "entry.contract", contractId),
    entry: brandedValue(object.entry, "entry.entry", entryUlid),
    at: validateTimestamp(object.at, "entry.at"),
    ...(object.actor === undefined ? {} : { actor: brandedValue(object.actor, "entry.actor", actorId) }),
    data: validateData(kind as JournalEntry["kind"], object.data),
  } as JournalEntry;
  const after = entry.kind === "bind" ? entry.data.terms.after : entry.kind === "amend" ? entry.data.after : undefined;
  if (after?.some((dependency) => dependency === entry.contract)) {
    fail(`entry.data.${entry.kind}.after`, "after cannot reference its own contract");
  }
  return entry;
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AuthorityCorruptionError("canonical JSON cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
  }
  throw new AuthorityCorruptionError("canonical JSON accepts only JSON values");
}

function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

export function encodeEntry(entry: JournalEntry): string {
  const validated = validateEntry(entry);
  return `${canonicalJson(validated)}\n`;
}

function decodeEntry(line: string): JournalEntry {
  if (line.includes("\r") || line.includes("\n\n")) throw new AuthorityCorruptionError("journal entry must be one LF-delimited JSON value");
  const body = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (body.length === 0) throw new AuthorityCorruptionError("journal entry cannot be empty");
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch (error) {
    throw new AuthorityCorruptionError("journal entry is not valid JSON", { cause: error });
  }
  const entry = validateEntry(value);
  if (canonicalJson(entry) !== body) throw new AuthorityCorruptionError("journal entry is not canonical");
  return entry;
}

export function decodeJournal(journal: string): JournalEntry[] {
  if (journal.length === 0) return [];
  if (journal.includes("\r") || !journal.endsWith("\n")) throw new AuthorityCorruptionError("journal must use LF lines and end with LF");
  return journal.slice(0, -1).split("\n").map((line) => decodeEntry(line));
}
