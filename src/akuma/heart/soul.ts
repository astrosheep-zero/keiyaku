import type { DatabaseSync } from "node:sqlite";
import { parseAkuId, type AkuId } from "../identity.js";
import { decodeProviderOptions, decodeProviderRecipe, decodeReadonlyRestraint } from "../provider-recipe.js";
import type { AkumaOrigin, Soul, SoulRow } from "./facts.js";
import { effectiveAllowedActions } from "../allowed.js";

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

function decodeOrigin(value: unknown): AkumaOrigin {
  const origin = record(value);
  if (origin === null) throw new Error("Akuma soul origin must be an object");
  if (origin.kind === "direct") {
    return { kind: "direct" };
  }
  if (origin.kind === "request") {
    return {
      kind: "request",
      parent: soulAkuIdentity(origin.parent, "request parent").id,
      requestId: nonblank(origin.requestId, "request requestId"),
    };
  }
  if (origin.kind === "fork") {
    return {
      kind: "fork",
      parent: soulAkuIdentity(origin.parent, "fork parent").id,
      at: nonblank(origin.at, "fork at"),
    };
  }
  throw new Error("Akuma soul origin must be direct, request, or fork");
}

function validateSoul(value: unknown): Soul {
  const soul = record(value);
  if (soul === null) throw new Error("Akuma soul must be an object");
  const identity = soulAkuIdentity(soul.id, "id");
  const id: AkuId = identity.id;
  const archetype = nonblank(soul.archetype, "name");
  if (identity.archetype !== archetype) throw new Error("Akuma soul id and name must agree");
  const description = soul.description === undefined ? undefined : nonblank(soul.description, "description");
  const provider = decodeProviderRecipe(soul.provider);
  const options = decodeProviderOptions(soul.options);
  const restraint = soul.readonly === undefined ? undefined : decodeReadonlyRestraint(soul.readonly);
  if ((options.readonly === true) !== (restraint !== undefined)) {
    throw new Error("Akuma soul readonly option and restraint must agree");
  }
  return {
    id,
    archetype,
    ...(description === undefined ? {} : { description }),
    provider,
    options,
    ...(restraint === undefined ? {} : { readonly: restraint }),
    cwd: nonblank(soul.cwd, "cwd"),
    origin: decodeOrigin(soul.origin),
    allowed: effectiveAllowedActions(soul.allowed),
    createdAt: nonblank(soul.createdAt, "createdAt"),
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
  return deepFreeze(validateSoul(value));
}

export function encodeSoul(soul: Soul): string {
  return JSON.stringify(validateSoul(soul));
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
