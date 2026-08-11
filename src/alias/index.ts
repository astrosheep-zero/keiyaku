import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseAkuId, type AkuId } from "../akuma/identity.js";
import { replaceFileDurably } from "../coordination/durable-file.js";
import { acquireSqliteTransactionLock } from "../coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { parseAkumaAlias, type AkumaAlias } from "../identity/selector.js";

const VERSION = 1;

export type AliasBinding = Readonly<{ alias: AkumaAlias; akuId: AkuId }>;
export type AliasMove = Readonly<{ alias: AliasBinding; previous: AkuId | null }>;

type AliasFile = Readonly<{
  version: typeof VERSION;
  aliases: Readonly<Record<string, string>>;
}>;

function paths(world: string): Readonly<{ authority: string; lock: string }> {
  if (typeof world !== "string" || world.trim().length === 0) {
    throw new TypeError("Alias world must be a nonblank path");
  }
  const root = resolve(world);
  return {
    authority: resolve(root, ".keiyaku", "akuma", "alias.json"),
    lock: resolve(root, ".keiyaku", "locks", "akuma-alias.sqlite"),
  };
}

function canonical(bindings: readonly AliasBinding[]): string {
  const aliases = Object.fromEntries(bindings
    .slice()
    .sort((left, right) => Buffer.compare(Buffer.from(left.alias), Buffer.from(right.alias)))
    .map((binding) => [binding.alias, binding.akuId]));
  const file: AliasFile = { version: VERSION, aliases };
  return `${JSON.stringify(file)}\n`;
}

function corruption(message: string, cause?: unknown): never {
  throw new AuthorityCorruptionError(message, cause === undefined ? {} : { cause });
}

function decode(path: string, bytes: string): readonly AliasBinding[] {
  let value: unknown;
  try {
    if (!bytes.endsWith("\n") || bytes.slice(0, -1).includes("\n")) {
      corruption(`Alias file is not one canonical JSON line: ${path}`);
    }
    value = JSON.parse(bytes);
  } catch (error) {
    if (error instanceof AuthorityCorruptionError) throw error;
    return corruption(`invalid Alias JSON: ${path}`, error);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    corruption(`Alias file must be an object: ${path}`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "version") || !Object.hasOwn(record, "aliases")) {
    corruption(`Alias file has invalid fields: ${path}`);
  }
  if (record.version !== VERSION) corruption(`Alias file version must be ${VERSION}: ${path}`);
  if (typeof record.aliases !== "object" || record.aliases === null || Array.isArray(record.aliases)) {
    corruption(`Alias map must be an object: ${path}`);
  }
  const bindings: AliasBinding[] = [];
  for (const [rawAlias, rawAkuId] of Object.entries(record.aliases as Record<string, unknown>)) {
    if (typeof rawAkuId !== "string") corruption(`Alias target must be an AkuId: ${path}`);
    try {
      bindings.push({ alias: parseAkumaAlias(rawAlias), akuId: parseAkuId(rawAkuId).id });
    } catch (error) {
      return corruption(`Alias binding is invalid: ${path}`, error);
    }
  }
  bindings.sort((left, right) => Buffer.compare(Buffer.from(left.alias), Buffer.from(right.alias)));
  if (canonical(bindings) !== bytes) corruption(`Alias bytes are not canonical: ${path}`);
  return bindings;
}

function read(path: string): readonly AliasBinding[] {
  try {
    return decode(path, readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function readAliases(world: string): readonly AliasBinding[] {
  return read(paths(world).authority);
}

export function resolveAlias(world: string, value: AkumaAlias): AkuId | null {
  const alias = parseAkumaAlias(value);
  return readAliases(world).find((binding) => binding.alias === alias)?.akuId ?? null;
}

export async function moveAlias(input: Readonly<{
  world: string;
  alias: AkumaAlias;
  akuId: AkuId;
}>): Promise<AliasMove> {
  const alias = parseAkumaAlias(input.alias);
  const akuId = parseAkuId(input.akuId).id;
  const location = paths(input.world);
  const held = await acquireSqliteTransactionLock({ path: location.lock, mode: "immediate" });
  try {
    const current = read(location.authority);
    const previous = current.find((binding) => binding.alias === alias)?.akuId ?? null;
    const next = [...current.filter((binding) => binding.alias !== alias), { alias, akuId }];
    mkdirSync(dirname(location.authority), { recursive: true });
    replaceFileDurably(location.authority, canonical(next));
    return { alias: { alias, akuId }, previous };
  } finally {
    held.close();
  }
}
