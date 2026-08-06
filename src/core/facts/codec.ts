import type {
  AbandonData,
  AbandonedData,
  AmendData,
  ArcData,
  BindData,
  BoundData,
  ContractBody,
  ContractCoordinates,
  ContractCriterion,
  ContractExtension,
  ContractId,
  DeclarationKey,
  DeliverData,
  ClaimedData,
  Gate,
  JournalEntry,
  ReviewData,
  VerificationData,
} from "./types.js";
import {
  changeId,
  contractId,
  declarationKey,
  entryUlid,
  snapshotId,
} from "./types.js";

type RecordValue = Record<string, unknown>;

export class FactsCodecError extends Error {
  readonly code: string = "INVALID_FACTS_CODEC";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FactsCodecError";
  }
}

export class UnknownEntryError extends FactsCodecError {
  readonly code = "UNKNOWN_FACT_KIND";

  constructor(kind: unknown) {
    super(`unknown journal entry kind: ${String(kind)}`);
    this.name = "UnknownEntryError";
  }
}

export class NonCanonicalEntryError extends FactsCodecError {
  readonly code = "NON_CANONICAL_FACTS";

  constructor(message = "journal entry is not canonical") {
    super(message);
    this.name = "NonCanonicalEntryError";
  }
}

const VERSION_BY_KIND = {
  bind: 1,
  amend: 1,
  bound: 1,
  deliver: 1,
  review: 1,
  verification: 1,
  claimed: 1,
  arc: 1,
  abandon: 1,
  abandoned: 1,
} as const;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new FactsCodecError(`${path}: ${message}`);
}

function requireRecord(value: unknown, path: string): RecordValue {
  if (!isRecord(value)) fail(path, "expected an object");
  return value;
}

function requireKeys(value: RecordValue, keys: readonly string[], path: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(path, `unknown field '${key}'`);
  }
  for (const key of keys) {
    if (!(key in value)) fail(path, `missing field '${key}'`);
  }
}

function requireOptionalKeys(value: RecordValue, keys: readonly string[], path: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(path, `unknown field '${key}'`);
  }
}

function stringValue(value: unknown, path: string, nonblank = true): string {
  if (typeof value !== "string" || (nonblank && value.trim().length === 0)) {
    fail(path, nonblank ? "expected a nonblank string" : "expected a string");
  }
  return value;
}

function opaqueIdValue(value: unknown, path: string, kind: "snapshot" | "change"): string {
  if (typeof value !== "string") fail(path, "expected a nonblank string");
  try {
    return kind === "snapshot" ? snapshotId(value) : changeId(value);
  } catch (error) {
    fail(path, error instanceof Error ? error.message : "invalid opaque ID");
  }
}

function ulidValue(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "expected an entry ULID");
  try {
    return entryUlid(value);
  } catch (error) {
    fail(path, error instanceof Error ? error.message : "invalid entry ULID");
  }
}

function declarationKeyValue(value: unknown, path: string): DeclarationKey {
  if (typeof value !== "string") fail(path, "expected a declaration key");
  try {
    return declarationKey(value);
  } catch (error) {
    fail(path, error instanceof Error ? error.message : "invalid declaration key");
  }
}

function arrayValue(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
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

function stringArray(value: unknown, path: string): readonly string[] {
  return arrayValue(value, path).map((item, index) => stringValue(item, `${path}[${index}]`));
}

function contractIdArray(value: unknown, path: string): readonly ContractId[] {
  return arrayValue(value, path).map((item, index) => {
    try {
      return contractId(stringValue(item, `${path}[${index}]`));
    } catch (error) {
      fail(`${path}[${index}]`, error instanceof Error ? error.message : "invalid contract ID");
    }
  });
}

function gatesArray(value: unknown, path: string): readonly Gate[] {
  return arrayValue(value, path).map((item, index) => {
    const gate = stringValue(item, `${path}[${index}]`);
    if (gate !== "reviewed" && gate !== "verified") fail(`${path}[${index}]`, "unknown gate");
    return gate;
  });
}

function verificationArray(value: unknown, path: string): readonly { executor: "bash" | "zsh" | "pwsh"; script: string }[] {
  return arrayValue(value, path).map((item, index) => {
    const object = requireRecord(item, `${path}[${index}]`);
    requireKeys(object, ["executor", "script"], `${path}[${index}]`);
    const executor = stringValue(object.executor, `${path}[${index}].executor`);
    if (executor !== "bash" && executor !== "zsh" && executor !== "pwsh") fail(`${path}[${index}].executor`, "unknown executor");
    return { executor, script: stringValue(object.script, `${path}[${index}].script`) };
  });
}

function extensionArray(value: unknown, path: string): readonly ContractExtension[] {
  return arrayValue(value, path).map((item, index) => {
    const object = requireRecord(item, `${path}[${index}]`);
    requireKeys(object, ["title", "content"], `${path}[${index}]`);
    return { title: stringValue(object.title, `${path}[${index}].title`), content: stringValue(object.content, `${path}[${index}].content`) };
  });
}

function criteriaArray(value: unknown, path: string): readonly ContractCriterion[] {
  return arrayValue(value, path).map((item, index) => {
    const object = requireRecord(item, `${path}[${index}]`);
    requireKeys(object, ["title", "body"], `${path}[${index}]`);
    return {
      title: stringValue(object.title, `${path}[${index}].title`),
      body: stringValue(object.body, `${path}[${index}].body`),
    };
  });
}

function validateCoordinates(value: unknown, path: string): ContractCoordinates {
  const object = requireRecord(value, path);
  requireOptionalKeys(object, ["start", "target", "workspace"], path);
  for (const key of ["start", "workspace"] as const) {
    if (!(key in object)) fail(path, `missing field '${key}'`);
  }
  const workspace = stringValue(object.workspace, `${path}.workspace`);
  if (workspace !== "worktree" && workspace !== "here") fail(`${path}.workspace`, "unknown workspace");
  return {
    start: snapshotId(opaqueIdValue(object.start, `${path}.start`, "snapshot")),
    workspace,
    ...(object.target === undefined ? {} : { target: stringValue(object.target, `${path}.target`) }),
  };
}

export function validateContractBody(value: unknown, path = "ContractBody"): ContractBody {
  const object = requireRecord(value, path);
  const required = ["title", "context", "objective", "design", "region", "criteria", "verification", "extensions"] as const;
  requireOptionalKeys(object, [...required, "gates", "after"], path);
  for (const key of required) {
    if (!(key in object)) fail(path, `missing field '${key}'`);
  }
  return {
    title: stringValue(object.title, `${path}.title`),
    context: stringValue(object.context, `${path}.context`),
    objective: stringValue(object.objective, `${path}.objective`),
    design: stringValue(object.design, `${path}.design`),
    region: stringArray(object.region, `${path}.region`),
    criteria: criteriaArray(object.criteria, `${path}.criteria`),
    verification: verificationArray(object.verification, `${path}.verification`),
    extensions: extensionArray(object.extensions, `${path}.extensions`),
    ...(object.gates === undefined ? {} : { gates: gatesArray(object.gates, `${path}.gates`) }),
    ...(object.after === undefined ? {} : { after: contractIdArray(object.after, `${path}.after`) }),
  };
}

function validateVerification(value: unknown, path: string): VerificationData {
  const object = requireRecord(value, path);
  requireOptionalKeys(object, ["candidate", "declarationKey", "result", "summary"], path);
  for (const key of ["candidate", "declarationKey", "result"] as const) {
    if (!(key in object)) fail(path, `missing field '${key}'`);
  }
  const result = stringValue(object.result, `${path}.result`);
  if (result !== "pass" && result !== "fail") fail(`${path}.result`, "unknown verification result");
  return {
    candidate: snapshotId(opaqueIdValue(object.candidate, `${path}.candidate`, "snapshot")),
    declarationKey: declarationKeyValue(object.declarationKey, `${path}.declarationKey`),
    result,
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
      requireKeys(object, ["coordinates", "body"], path);
      return {
        coordinates: validateCoordinates(object.coordinates, `${path}.coordinates`),
        body: validateContractBody(object.body, `${path}.body`),
      } satisfies BindData;
    }
    case "amend":
      return validateContractBody(value, path) satisfies AmendData;
    case "bound": {
      const object = requireRecord(value, path);
      requireKeys(object, [], path);
      return {} satisfies BoundData;
    }
    case "deliver": {
      const object = requireRecord(value, path);
      requireKeys(object, ["expectedPredecessor", "candidate", "deliveryPatchId"], path);
      return {
        expectedPredecessor: snapshotId(opaqueIdValue(object.expectedPredecessor, `${path}.expectedPredecessor`, "snapshot")),
        candidate: snapshotId(opaqueIdValue(object.candidate, `${path}.candidate`, "snapshot")),
        deliveryPatchId: changeId(opaqueIdValue(object.deliveryPatchId, `${path}.deliveryPatchId`, "change")),
      } satisfies DeliverData;
    }
    case "review": {
      const object = requireRecord(value, path);
      requireOptionalKeys(object, ["verdict", "reviewedPatchId", "reviewedHead", "summary"], path);
      for (const key of ["verdict", "reviewedPatchId", "reviewedHead"] as const) {
        if (!(key in object)) fail(path, `missing field '${key}'`);
      }
      const verdict = stringValue(object.verdict, `${path}.verdict`);
      if (verdict !== "approved" && verdict !== "changes-requested") fail(`${path}.verdict`, "unknown review verdict");
      return {
        verdict,
        reviewedPatchId: changeId(opaqueIdValue(object.reviewedPatchId, `${path}.reviewedPatchId`, "change")),
        reviewedHead: snapshotId(opaqueIdValue(object.reviewedHead, `${path}.reviewedHead`, "snapshot")),
        ...(object.summary === undefined ? {} : { summary: stringValue(object.summary, `${path}.summary`) }),
      } satisfies ReviewData;
    }
    case "verification":
      return validateVerification(value, path) satisfies VerificationData;
    case "claimed": {
      const object = requireRecord(value, path);
      requireKeys(object, ["delivery"], path);
      return { delivery: entryUlid(ulidValue(object.delivery, `${path}.delivery`)) } satisfies ClaimedData;
    }
    case "arc":
      return validateArc(value, path) satisfies ArcData;
    case "abandon": {
      const object = requireRecord(value, path);
      requireOptionalKeys(object, ["note"], path);
      return {
        ...(object.note === undefined ? {} : { note: stringValue(object.note, `${path}.note`) }),
      } satisfies AbandonData;
    }
    case "abandoned": {
      const object = requireRecord(value, path);
      requireKeys(object, ["finalHead"], path);
      if (object.finalHead === null) return { finalHead: null } satisfies AbandonedData;
      return { finalHead: snapshotId(opaqueIdValue(object.finalHead, `${path}.finalHead`, "snapshot")) } satisfies AbandonedData;
    }
  }
}

function validateEntry(value: unknown): JournalEntry {
  const object = requireRecord(value, "entry");
  requireOptionalKeys(object, ["v", "kind", "contract", "entry", "at", "actor", "data"], "entry");
  for (const key of ["v", "kind", "contract", "entry", "at", "data"] as const) {
    if (!(key in object)) fail("entry", `missing field '${key}'`);
  }
  const kind = object.kind;
  if (typeof kind !== "string" || !Object.hasOwn(VERSION_BY_KIND, kind)) throw new UnknownEntryError(kind);
  const expectedVersion = VERSION_BY_KIND[kind as keyof typeof VERSION_BY_KIND];
  if (object.v !== expectedVersion) fail("entry.v", `expected version ${expectedVersion} for ${kind}`);
  let contract: ContractId;
  try {
    contract = contractId(stringValue(object.contract, "entry.contract"));
  } catch (error) {
    fail("entry.contract", error instanceof Error ? error.message : "invalid contract ID");
  }
  const entry = {
    v: object.v,
    kind,
    contract,
    entry: entryUlid(ulidValue(object.entry, "entry.entry")),
    at: validateTimestamp(object.at, "entry.at"),
    ...(object.actor === undefined ? {} : { actor: stringValue(object.actor, "entry.actor") }),
    data: validateData(kind as JournalEntry["kind"], object.data),
  } as JournalEntry;
  const after = entry.kind === "bind" ? entry.data.body.after : entry.kind === "amend" ? entry.data.after : undefined;
  if (after?.some((dependency) => dependency === entry.contract)) {
    fail(`entry.data.${entry.kind}.after`, "after cannot reference its own contract");
  }
  return entry;
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new FactsCodecError("canonical JSON cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
  }
  throw new FactsCodecError("canonical JSON accepts only JSON values");
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

export function encodeEntry(entry: JournalEntry): string {
  const validated = validateEntry(entry);
  return `${canonicalJson(validated)}\n`;
}

export function decodeEntry(line: string): JournalEntry {
  if (line.includes("\r") || line.includes("\n\n")) throw new FactsCodecError("journal entry must be one LF-delimited JSON value");
  const body = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (body.length === 0) throw new FactsCodecError("journal entry cannot be empty");
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch (error) {
    throw new FactsCodecError("journal entry is not valid JSON", { cause: error });
  }
  const entry = validateEntry(value);
  if (canonicalJson(entry) !== body) throw new NonCanonicalEntryError();
  return entry;
}

export function decodeJournal(journal: string): JournalEntry[] {
  if (journal.length === 0) return [];
  if (journal.includes("\r") || !journal.endsWith("\n")) throw new FactsCodecError("journal must use LF lines and end with LF");
  return journal.slice(0, -1).split("\n").map((line) => decodeEntry(line));
}

export function appendEntry(journal: string, entry: JournalEntry): string {
  if (journal.length !== 0 && !journal.endsWith("\n")) throw new FactsCodecError("cannot append to a noncanonical journal prefix");
  return `${journal}${encodeEntry(entry)}`;
}
