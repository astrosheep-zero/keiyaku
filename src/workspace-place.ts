import { lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { replaceFileDurably } from "./coordination/durable-file.js";
import { acquireSqliteTransactionLock } from "./coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "./core/facts/errors.js";
import { contractId, type ContractId } from "./core/facts/types.js";
import { contractLocator } from "./git/identity.js";
import type { GitRepository } from "./git/process.js";
import { pathExists, registeredWorktreeNames } from "./git/repository.js";
import { worktreePath } from "./git/workspace.js";

const PLACE_VERSION = 1;
const PORTABLE_PLACE = /^[a-z][a-z0-9-]*$/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u;
const placeAuthorityFence: unique symbol = Symbol("place-authority-fence");

export type Place = string & { readonly [placeBrand]: "Place" };
declare const placeBrand: unique symbol;

export type PlaceAppointment = Readonly<{ place: Place; contract: ContractId }>;
export type ContractWorkspaceLocation = Readonly<{ kind: "worktree"; path: string }>;
export type PlaceRegister = ReadonlyMap<ContractId, Place>;
export type ManagedWorktreeAppointment =
  | Readonly<{ kind: "appointed"; place: Place; path: string }>
  | Readonly<{ kind: "unappointed" }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;
export type PlaceAuthorityFence = Readonly<{ readonly [placeAuthorityFence]: true }>;

function placePaths(repository: GitRepository): Readonly<{ authority: string; lock: string }> {
  return {
    authority: join(repository.commonDirectory, "keiyaku", "places.json"),
    lock: join(repository.commonDirectory, "keiyaku", "locks", "places.sqlite"),
  };
}

export function placeRegisterPath(repository: GitRepository): string {
  return placePaths(repository).authority;
}

export function place(value: string): Place {
  if (!PORTABLE_PLACE.test(value) || WINDOWS_RESERVED.test(value))
    throw new TypeError(`Place is not canonical: ${value}`);
  return value as Place;
}

export function canonicalPlaceRegister(register: PlaceRegister): string {
  const entries = [...register].sort(([, left], [, right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const appointments = Object.fromEntries(entries.map(([contract, place]) => [place, contract]));
  return `${JSON.stringify({ version: PLACE_VERSION, appointments })}\n`;
}

function placeCorruption(path: string, message: string, cause?: unknown): never {
  throw new AuthorityCorruptionError(`${message}: ${path}`, cause === undefined ? {} : { cause });
}

export function decodePlaceRegister(path: string, bytes: string): PlaceRegister {
  let value: unknown;
  try {
    if (!bytes.endsWith("\n") || bytes.slice(0, -1).includes("\n")) {
      placeCorruption(path, "Place file is not one canonical JSON line");
    }
    value = JSON.parse(bytes);
  } catch (error) {
    if (error instanceof AuthorityCorruptionError) throw error;
    return placeCorruption(path, "invalid Place JSON", error);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    placeCorruption(path, "Place file must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "version") || !Object.hasOwn(record, "appointments")) {
    placeCorruption(path, "Place file has invalid fields");
  }
  if (record.version !== PLACE_VERSION) placeCorruption(path, `Place file version must be ${PLACE_VERSION}`);
  if (typeof record.appointments !== "object" || record.appointments === null || Array.isArray(record.appointments)) {
    placeCorruption(path, "Place appointments must be an object");
  }
  const relation = new Map<ContractId, Place>();
  const contracts = new Set<ContractId>();
  for (const [rawPlace, rawContract] of Object.entries(record.appointments as Record<string, unknown>)) {
    if (typeof rawContract !== "string") placeCorruption(path, "Place appointment must be a ContractId");
    try {
      const appointed = contractId(rawContract);
      if (contracts.has(appointed)) placeCorruption(path, "Place file has duplicate Contract appointment");
      contracts.add(appointed);
      relation.set(appointed, place(rawPlace));
    } catch (error) {
      return placeCorruption(path, "Place appointment is invalid", error);
    }
  }
  if (canonicalPlaceRegister(relation) !== bytes) placeCorruption(path, "Place bytes are not canonical");
  return relation;
}

export function emptyPlaceRegister(): PlaceRegister {
  return new Map();
}

export async function readPlaceRegister(repository: GitRepository): Promise<PlaceRegister> {
  const path = placePaths(repository).authority;
  try {
    return decodePlaceRegister(path, await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyPlaceRegister();
    throw error;
  }
}

export function appointmentFor(register: PlaceRegister, contract: ContractId): PlaceAppointment | undefined {
  const place = register.get(contract);
  return place === undefined ? undefined : { place, contract };
}

export async function withPlaceAuthorityFence<T>(
  repository: GitRepository,
  action: (fence: PlaceAuthorityFence) => T | Promise<T>,
): Promise<T> {
  const location = placePaths(repository);
  const held = await acquireSqliteTransactionLock({ path: location.lock, mode: "immediate" });
  try {
    return await action({ [placeAuthorityFence]: true });
  } finally {
    held.close();
  }
}

async function mutatePlaceRegisterInFence(
  repository: GitRepository,
  mutate: (register: PlaceRegister) => PlaceRegister | Promise<PlaceRegister>,
): Promise<PlaceRegister> {
  const location = placePaths(repository);
  const current = await readPlaceRegister(repository);
  const next = await mutate(current);
  const bytes = canonicalPlaceRegister(next);
  try {
    if ((await readFile(location.authority, "utf8")) === bytes) return next;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(location.authority), { recursive: true });
  await replaceFileDurably(location.authority, bytes);
  return next;
}

async function mutatePlaceRegister(
  repository: GitRepository,
  mutate: (register: PlaceRegister) => PlaceRegister | Promise<PlaceRegister>,
  fence?: PlaceAuthorityFence,
): Promise<PlaceRegister> {
  if (fence !== undefined) return await mutatePlaceRegisterInFence(repository, mutate);
  return await withPlaceAuthorityFence(repository, async () => await mutatePlaceRegisterInFence(repository, mutate));
}

export async function appointManagedWorktrees(
  repository: GitRepository,
  contracts: readonly ContractId[],
): Promise<PlaceRegister> {
  return await mutatePlaceRegister(repository, async (register) => {
    if (contracts.every((contract) => register.has(contract))) return register;
    const directory = worktreePath(repository, "");
    const occupied = new Set([...register.values(), ...(await registeredWorktreeNames(repository, directory))]);
    const next = new Map(register);
    for (const contract of contracts) {
      if (next.has(contract)) continue;
      const stem = `w-${contractLocator(contract)}`;
      for (let suffix = 1; ; suffix += 1) {
        const candidate = place(suffix === 1 ? stem : `${stem}-${suffix}`);
        if (occupied.has(candidate) || (await pathExists(join(directory, candidate)))) continue;
        next.set(contract, candidate);
        occupied.add(candidate);
        break;
      }
    }
    return next;
  });
}

export async function releaseManagedWorktrees(
  repository: GitRepository,
  contracts: readonly ContractId[],
  fence?: PlaceAuthorityFence,
): Promise<void> {
  if (contracts.length === 0) return;
  const drop = new Set(contracts);
  await mutatePlaceRegister(
    repository,
    (current) => {
      if (!contracts.some((contract) => current.has(contract))) return current;
      const next = new Map(current);
      for (const contract of drop) next.delete(contract);
      return next;
    },
    fence,
  );
}

async function regularFile(path: string): Promise<boolean> {
  const value = await lstat(path).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : Promise.reject(error),
  );
  if (value === undefined) return false;
  if (!value.isFile() || value.isSymbolicLink()) throw new Error(`Place custody is not a regular file: ${path}`);
  return true;
}

/** Remove only an already-empty Place authority. */
export async function nukeEmptyPlaceAuthority(repository: GitRepository, fence?: PlaceAuthorityFence): Promise<void> {
  const location = placePaths(repository);
  const [authorityPresent, lockPresent] = [await regularFile(location.authority), await regularFile(location.lock)];
  if (!authorityPresent && !lockPresent) return;

  const nuke = async () => {
    const current = await readPlaceRegister(repository);
    if (current.size !== 0) throw new Error("Place authority still has managed worktree appointments");
    if (await regularFile(location.authority)) await unlink(location.authority);
  };
  if (fence !== undefined) await nuke();
  else await withPlaceAuthorityFence(repository, nuke);
}

export async function readManagedWorktreeAppointment(
  repository: GitRepository,
  contract: ContractId,
  register?: PlaceRegister,
): Promise<ManagedWorktreeAppointment> {
  try {
    const snapshot = register ?? (await readPlaceRegister(repository));
    const appointed = appointmentFor(snapshot, contract);
    return appointed === undefined
      ? { kind: "unappointed" }
      : { kind: "appointed", place: appointed.place, path: worktreePath(repository, appointed.place) };
  } catch (error) {
    return { kind: "failed", diagnostic: error instanceof Error ? error.message : String(error) };
  }
}
