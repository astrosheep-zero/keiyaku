import { createHash } from "node:crypto";
import type {
  AmendData,
  AmendEntry,
  BindEntry,
  CheckData,
  CheckEntry,
  ClaimData,
  ClaimEntry,
  ContractBody,
  ContractExtension,
  CriteriaDelta,
  EvidenceRef,
  ForfeitData,
  ForfeitEntry,
  JournalEntry,
  PetitionData,
  PetitionEntry,
  RenewData,
  RenewEntry,
  ReviewData,
  ReviewEntry,
  SectionRevision,
  SealData,
  SealEntry,
  VerificationData,
  VerificationEntry,
} from "./types.js";
import {
  blobOid,
  commitOid,
  contractId,
  evidenceKind,
  entryUlid,
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
  seal: 1,
  claim: 1,
  renew: 1,
  petition: 1,
  forfeit: 1,
  review: 1,
  check: 1,
  verification: 1,
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

function integerValue(value: unknown, path: string, positive = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || (positive ? value < 1 : value < 0)) {
    fail(path, positive ? "expected a positive safe integer" : "expected a nonnegative safe integer");
  }
  return value;
}

function oidValue(value: unknown, path: string, kind: "blob" | "commit"): string {
  if (typeof value !== "string") fail(path, "expected an object ID");
  try {
    return kind === "blob" ? blobOid(value) : commitOid(value);
  } catch (error) {
    fail(path, error instanceof Error ? error.message : "invalid object ID");
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

function arrayValue(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function optionalString(value: RecordValue, key: string, path: string): void {
  if (key in value && value[key] !== undefined) stringValue(value[key], `${path}.${key}`);
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

function validateContractBody(value: unknown, path: string): ContractBody {
  const object = requireRecord(value, path);
  requireKeys(object, ["title", "context", "objective", "design", "region", "criteria", "verification", "extensions"], path);
  const body = {
    title: stringValue(object.title, `${path}.title`),
    context: stringValue(object.context, `${path}.context`),
    objective: stringValue(object.objective, `${path}.objective`),
    design: stringValue(object.design, `${path}.design`),
    region: stringArray(object.region, `${path}.region`),
    criteria: stringArray(object.criteria, `${path}.criteria`),
    verification: verificationArray(object.verification, `${path}.verification`),
    extensions: extensionArray(object.extensions, `${path}.extensions`),
  } satisfies ContractBody;
  return body;
}

function stringArray(value: unknown, path: string): readonly string[] {
  return arrayValue(value, path).map((item, index) => stringValue(item, `${path}[${index}]`));
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

function evidenceRef(value: unknown, path: string): EvidenceRef {
  const object = requireRecord(value, path);
  requireKeys(object, ["entry", "seq", "kind", "oid"], path);
  let kind: string;
  try {
    kind = evidenceKind(stringValue(object.kind, `${path}.kind`));
  } catch (error) {
    fail(`${path}.kind`, error instanceof Error ? error.message : "invalid evidence kind");
  }
  return {
    entry: entryUlid(ulidValue(object.entry, `${path}.entry`)),
    seq: integerValue(object.seq, `${path}.seq`),
    kind,
    oid: blobOid(oidValue(object.oid, `${path}.oid`, "blob")),
  };
}

function evidenceRefs(value: unknown, path: string): readonly EvidenceRef[] {
  return arrayValue(value, path).map((item, index) => evidenceRef(item, `${path}[${index}]`));
}

function sectionRevision(value: unknown, path: string): SectionRevision {
  const object = requireRecord(value, path);
  requireKeys(object, ["target", "op", "body"], path);
  const targetValue = object.target;
  let target: SectionRevision["target"];
  if (typeof targetValue === "string") {
    if (targetValue !== "context" && targetValue !== "objective" && targetValue !== "design") fail(`${path}.target`, "unknown section target");
    target = targetValue;
  } else {
    const extension = requireRecord(targetValue, `${path}.target`);
    requireKeys(extension, ["extension"], `${path}.target`);
    target = { extension: stringValue(extension.extension, `${path}.target.extension`) };
  }
  const op = stringValue(object.op, `${path}.op`);
  if (op !== "replace" && op !== "append" && op !== "add") fail(`${path}.op`, "unknown revision operation");
  if (op === "add" && typeof target === "string") fail(`${path}.target`, "add requires an extension target");
  return { target, op, body: stringValue(object.body, `${path}.body`) };
}

function criteriaDelta(value: unknown, path: string): CriteriaDelta {
  const object = requireRecord(value, path);
  const keys = Object.keys(object);
  if (keys.length !== 1 || (keys[0] !== "add" && keys[0] !== "replace")) fail(path, "expected exactly one criteria delta operation");
  return keys[0] === "add"
    ? { add: stringArray(object.add, `${path}.add`) }
    : { replace: stringArray(object.replace, `${path}.replace`) };
}

function validateData(kind: JournalEntry["kind"], value: unknown): unknown {
  const path = `data.${kind}`;
  switch (kind) {
    case "bind":
      return validateContractBody(value, path);
    case "amend": {
      const object = requireRecord(value, path);
      requireOptionalKeys(object, ["revisions", "region", "criteriaDelta", "verificationDelta"], path);
      if (!("revisions" in object) && !("region" in object) && !("criteriaDelta" in object) && !("verificationDelta" in object)) fail(path, "amend requires at least one body change");
      return {
        ...(object.revisions === undefined ? {} : { revisions: arrayValue(object.revisions, `${path}.revisions`).map((item, index) => sectionRevision(item, `${path}.revisions[${index}]`)) }),
        ...(object.region === undefined ? {} : { region: stringArray(object.region, `${path}.region`) }),
        ...(object.criteriaDelta === undefined ? {} : { criteriaDelta: criteriaDelta(object.criteriaDelta, `${path}.criteriaDelta`) }),
        ...(object.verificationDelta === undefined ? {} : {
          verificationDelta: (() => {
            const delta = requireRecord(object.verificationDelta, `${path}.verificationDelta`);
            requireKeys(delta, ["replace"], `${path}.verificationDelta`);
            return { replace: verificationArray(delta.replace, `${path}.verificationDelta.replace`) };
          })(),
        }),
      } satisfies AmendData;
    }
    case "seal": {
      const object = requireRecord(value, path);
      requireKeys(object, [], path);
      return {} satisfies SealData;
    }
    case "claim": {
      const object = requireRecord(value, path);
      requireKeys(object, ["petition"], path);
      return { petition: entryUlid(ulidValue(object.petition, `${path}.petition`)) } satisfies ClaimData;
    }
    case "renew": {
      const object = requireRecord(value, path);
      requireKeys(object, ["oldHead", "newHead"], path);
      return { oldHead: commitOid(oidValue(object.oldHead, `${path}.oldHead`, "commit")), newHead: commitOid(oidValue(object.newHead, `${path}.newHead`, "commit")) } satisfies RenewData;
    }
    case "petition": {
      const object = requireRecord(value, path);
      const intent = stringValue(object.intent, `${path}.intent`);
      if (intent === "claim") {
        requireKeys(object, ["intent", "oath", "expectedPredecessor", "seat", "candidate"], path);
        return {
          intent,
          oath: stringValue(object.oath, `${path}.oath`),
          expectedPredecessor: commitOid(oidValue(object.expectedPredecessor, `${path}.expectedPredecessor`, "commit")),
          seat: integerValue(object.seat, `${path}.seat`, true),
          candidate: commitOid(oidValue(object.candidate, `${path}.candidate`, "commit")),
        } satisfies Extract<PetitionData, { intent: "claim" }>;
      }
      if (intent === "forfeit") {
        requireKeys(object, ["intent", "seat"], path);
        return { intent, seat: integerValue(object.seat, `${path}.seat`, true) } satisfies Extract<PetitionData, { intent: "forfeit" }>;
      }
      fail(`${path}.intent`, "unknown petition intent");
    }
    case "forfeit": {
      const object = requireRecord(value, path);
      requireOptionalKeys(object, ["reason", "note"], path);
      if (!("reason" in object)) fail(path, "missing field 'reason'");
      const reason = stringValue(object.reason, `${path}.reason`);
      if (reason !== "manual" && reason !== "bind-failed") fail(`${path}.reason`, "unknown forfeit reason");
      if ("note" in object) optionalString(object, "note", path);
      return { reason, ...(object.note === undefined ? {} : { note: stringValue(object.note, `${path}.note`) }) } satisfies ForfeitData;
    }
    case "review": {
      const object = requireRecord(value, path);
      requireKeys(object, ["verdict", "digest", "summary", "evidence"], path);
      const verdict = stringValue(object.verdict, `${path}.verdict`);
      if (verdict !== "approved" && verdict !== "changes-requested") fail(`${path}.verdict`, "unknown review verdict");
      return { verdict, digest: stringValue(object.digest, `${path}.digest`), summary: stringValue(object.summary, `${path}.summary`), evidence: evidenceRefs(object.evidence, `${path}.evidence`) } satisfies ReviewData;
    }
    case "check": {
      const object = requireRecord(value, path);
      requireKeys(object, ["result", "summary", "evidence"], path);
      const result = stringValue(object.result, `${path}.result`);
      if (result !== "pass" && result !== "fail") fail(`${path}.result`, "unknown check result");
      return { result, summary: stringValue(object.summary, `${path}.summary`), evidence: evidenceRefs(object.evidence, `${path}.evidence`) } satisfies CheckData;
    }
    case "verification": {
      const object = requireRecord(value, path);
      requireKeys(object, ["result", "summary", "evidence"], path);
      const result = stringValue(object.result, `${path}.result`);
      if (result !== "pass" && result !== "fail") fail(`${path}.result`, "unknown verification result");
      return { result, summary: stringValue(object.summary, `${path}.summary`), evidence: evidenceRefs(object.evidence, `${path}.evidence`) } satisfies VerificationData;
    }
  }
}

function validateEntry(value: unknown): JournalEntry {
  const object = requireRecord(value, "entry");
  requireKeys(object, ["v", "kind", "contract", "entry", "at", "actor", "data"], "entry");
  const kind = object.kind;
  if (typeof kind !== "string" || !Object.hasOwn(VERSION_BY_KIND, kind)) throw new UnknownEntryError(kind);
  const expectedVersion = VERSION_BY_KIND[kind as keyof typeof VERSION_BY_KIND];
  if (object.v !== expectedVersion) fail("entry.v", `expected version ${expectedVersion} for ${kind}`);
  let contract: string;
  try {
    contract = contractId(stringValue(object.contract, "entry.contract"));
  } catch (error) {
    fail("entry.contract", error instanceof Error ? error.message : "invalid contract ID");
  }
  const validated = {
    v: object.v,
    kind,
    contract,
    entry: entryUlid(ulidValue(object.entry, "entry.entry")),
    at: validateTimestamp(object.at, "entry.at"),
    actor: stringValue(object.actor, "entry.actor"),
    data: validateData(kind as JournalEntry["kind"], object.data),
  };
  const entry = validated as JournalEntry;
  if (entry.kind === "review" || entry.kind === "check" || entry.kind === "verification") {
    for (const ref of entry.data.evidence) {
      if (ref.entry !== entry.entry) fail("entry.data.evidence", "evidence entry must match its journal entry");
    }
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

export function bodyDigest(body: ContractBody): string {
  return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}

export type {
  AmendEntry,
  BindEntry,
  CheckEntry,
  ClaimEntry,
  ForfeitEntry,
  PetitionEntry,
  RenewEntry,
  ReviewEntry,
  SealEntry,
  VerificationEntry,
};
