import { decodeAkumaCaller } from "../caller.js";
import type { DatabaseSync } from "node:sqlite";
import { parseAkuId, type AkuId } from "../identity.js";
import { decodeProviderOptions, decodeProviderRecipe } from "../provider-recipe.js";
import { akumaOriginSchema, type Soul, type SoulRow } from "./facts.js";
import { historicalAllowedActions } from "../allowed.js";

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function nonblank(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Akuma soul ${what} must be a nonblank string`);
  }
  return value;
}

function soulAkuIdentity(value: unknown, what: string): ReturnType<typeof parseAkuId> {
  try {
    return parseAkuId(nonblank(value, what));
  } catch (error) {
    throw new Error(`Akuma soul ${what} is not an Akuma identity coordinate`, { cause: error });
  }
}

export function decodeSoulSeed(value: unknown): Omit<Soul, "createdAt"> {
  const soul = record(value);
  if (soul === null) throw new Error("Akuma soul must be an object");
  const identity = soulAkuIdentity(soul.id, "id");
  const id: AkuId = identity.id;
  const archetype = nonblank(soul.archetype, "name");
  if (identity.archetype !== archetype) throw new Error("Akuma soul id and name must agree");
  const description = soul.description === undefined ? undefined : nonblank(soul.description, "description");
  const provider = decodeProviderRecipe(soul.provider);
  const options = decodeProviderOptions(soul.options);
  const caller = decodeAkumaCaller(soul.caller);
  if (soul.bare !== undefined && typeof soul.bare !== "boolean") {
    throw new Error("Akuma soul bare must be a boolean");
  }
  return {
    id,
    archetype,
    ...(description === undefined ? {} : { description }),
    provider,
    options,
    cwd: nonblank(soul.cwd, "cwd"),
    origin: akumaOriginSchema.parse(soul.origin),
    ...(caller === undefined ? {} : { caller }),
    allowed: historicalAllowedActions(soul.allowed),
    ...(soul.bare === undefined ? {} : { bare: soul.bare }),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Readonly<Record<string, unknown>>)) {
      deepFreeze((value as Readonly<Record<string, unknown>>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export function decodeSoul(value: unknown): Soul {
  const soul = record(value);
  if (soul === null) throw new Error("Akuma soul must be an object");
  return deepFreeze({ ...decodeSoulSeed(soul), createdAt: nonblank(soul.createdAt, "createdAt") });
}

export function encodeSoul(soul: Soul): string {
  return JSON.stringify(decodeSoul(soul));
}

export function encodeSoulRow(soul: Soul): readonly [string] {
  return [encodeSoul(soul)];
}

export function decodeSoulRow(row: SoulRow): Soul {
  return decodeSoul(JSON.parse(row.soul_json));
}

export function soulFact(database: DatabaseSync): Soul | null {
  const row = database.prepare("SELECT soul_json FROM soul WHERE singleton = 1").get() as SoulRow | undefined;
  return row === undefined ? null : decodeSoulRow(row);
}

export function insertSoulFact(database: DatabaseSync, soul: Soul): void {
  database.prepare("INSERT INTO soul(singleton, soul_json) VALUES (1, ?)").run(...encodeSoulRow(soul));
}

/**
 * Replace only the current-model member of the singleton Soul and report
 * whether the stored value actually moved. Every other raw member is carried
 * through byte-identically: the codec normalizes recipe options, origin and
 * allowed, so decoding and re-encoding a whole Soul here would silently
 * rewrite fields this update never touched. A Soul this build cannot read is
 * refused rather than mutated.
 */
export function setSoulModel(database: DatabaseSync, model: string | undefined): boolean {
  const row = database.prepare("SELECT soul_json FROM soul WHERE singleton = 1").get() as SoulRow | undefined;
  if (row === undefined) throw new Error("Akuma soul is absent");
  const raw = JSON.parse(row.soul_json) as unknown;
  decodeSoul(raw);
  const soul = record(raw)!;
  const options = record(soul.options);
  if (options === null) throw new Error("Akuma soul options must be an object");
  const current = options.model;
  if (model === undefined ? current === undefined : current === model) return false;
  const next: Record<string, unknown> = { ...options };
  if (model === undefined) delete next.model;
  else next.model = model;
  database.prepare("UPDATE soul SET soul_json = ? WHERE singleton = 1").run(JSON.stringify({ ...soul, options: next }));
  return true;
}
