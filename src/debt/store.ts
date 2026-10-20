import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  acquireSqliteTransactionLock,
  SqliteTransactionLockError,
  type HeldSqliteTransactionLock,
} from "../coordination/sqlite-transaction-lock.js";
import { syncDirectory } from "../coordination/durable-file.js";
import type { WorldRoot } from "../world.js";
import { boundedListLimit, projectBoundedList, type BoundedList } from "../bounded-list.js";
import { parseDebtDocument, type DebtDocument } from "./document.js";
import {
  formatDebtId,
  parseDebtId,
  physicalDebtSegment,
  DEBT_LOCAL_ID_BYTES,
  sameNamespace,
  debtAuthorityPath,
  type DebtCoordinate,
  type DebtId,
} from "./identity.js";
import type { DebtBoard } from "./board.js";

export type BoardSnapshot = Readonly<{ board: DebtBoard; bytes: ReadonlyMap<DebtId, Uint8Array> }>;
const DEFAULT_DEBT_LOCK_TIMEOUT_MS = 3_000;

async function debtsDirectory(world: WorldRoot): Promise<string> {
  const legacy = resolve(world, ".keiyaku", "tasks");
  try {
    await lstat(legacy);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolve(world, ".keiyaku", "debts");
  }
  throw new Error(`Unmigrated ledger authority: ${legacy}`);
}
function allocationLockPath(world: WorldRoot): string {
  return resolve(world, ".keiyaku", "locks", "debt-allocation.sqlite");
}

function custodyError(path: string): Error {
  return new Error(`Debt authority custody violation: symlink or non-authority component: ${path}`);
}

async function requireDirectory(path: string, mode: "read" | "write"): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw custodyError(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (mode === "read") return false;
    try {
      await mkdir(path);
      syncDirectory(dirname(path));
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw custodyError(path);
    return true;
  }
}

async function resolveAuthority(
  world: WorldRoot,
  id: DebtId,
  mode: "read" | "write",
): Promise<{ path: string; exists: boolean }> {
  const coordinate = parseDebtId(id);
  const root = await debtsDirectory(world);
  const safePath = debtAuthorityPath(root, coordinate);
  if (!(await requireDirectory(root, mode))) return { path: safePath, exists: false };
  let parent = root;
  for (const segment of coordinate.namespace) {
    parent = resolve(parent, physicalDebtSegment(segment));
    if (!(await requireDirectory(parent, mode))) return { path: safePath, exists: false };
  }
  const path = safePath;
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw custodyError(path);
    return { path, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, exists: false };
    throw error;
  }
}

async function authorityFiles(directory: string): Promise<readonly string[]> {
  if (!(await requireDirectory(directory, "read"))) return [];
  const files: string[] = [];
  const entries = await readdir(directory);
  for (const entry of entries) {
    const path = resolve(directory, entry);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw custodyError(path);
    if (stat.isDirectory()) files.push(...(await authorityFiles(path)));
    else if (stat.isFile() && entry.endsWith(".md")) files.push(path);
  }
  return files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function coordinateFromPath(debtsDirectory: string, path: string) {
  const local = relative(debtsDirectory, path);
  if (local.startsWith("..") || resolve(debtsDirectory, local) !== path || !local.endsWith(".md"))
    throw new Error(`invalid Debt authority path: ${path}`);
  const segments = local.slice(0, -3).split(sep);
  segments.forEach((segment) => physicalDebtSegment(segment));
  return parseDebtId(`debt/${segments.join("/")}`);
}

async function ownedAuthorityCandidates(directory: string): Promise<readonly Readonly<{ id: DebtId; path: string }>[]> {
  const candidates: Readonly<{ id: DebtId; path: string }>[] = [];
  for (const path of await authorityFiles(directory)) {
    try {
      candidates.push({ id: formatDebtId(coordinateFromPath(directory, path)), path });
    } catch {
      // Files outside the Debt identity grammar are not owned candidates.
    }
  }
  return candidates;
}

async function removeEmptyDebtDirectories(directory: string, removeSelf: boolean): Promise<void> {
  if (!(await requireDirectory(directory, "read"))) return;
  const entries = await readdir(directory);
  for (const entry of entries) {
    const path = resolve(directory, entry);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw custodyError(path);
    if (stat.isDirectory()) await removeEmptyDebtDirectories(path, true);
  }
  if (!removeSelf) return;
  try {
    await rmdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
}

export async function readBoard(world: WorldRoot): Promise<BoardSnapshot> {
  const directory = await debtsDirectory(world);
  const paths = await authorityFiles(directory);
  const reads = new Array<
    { kind: "read"; coordinate: DebtCoordinate; source: Uint8Array } | { kind: "failed"; error: unknown }
  >(paths.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const index = next++;
      const path = paths[index]!;
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error(`Debt authority is not a regular file: ${path}`);
        }
        const coordinate = coordinateFromPath(directory, path);
        reads[index] = { kind: "read", coordinate, source: await readFile(path) };
      } catch (error) {
        reads[index] = { kind: "failed", error };
      }
    }
  };
  // Drain all owned reads; authority and errors are then judged in canonical path order.
  await Promise.all(Array.from({ length: Math.min(8, paths.length) }, worker));
  const debts = new Map<DebtId, DebtDocument>();
  const bytes = new Map<DebtId, Uint8Array>();
  for (const read of reads) {
    if (read.kind === "failed") throw read.error;
    const { coordinate, source } = read;
    const id = formatDebtId(coordinate);
    debts.set(id, parseDebtDocument(source, coordinate));
    bytes.set(id, source);
  }
  return { board: { debts }, bytes };
}

function compareRecentDebts(left: DebtDocument, right: DebtDocument): number {
  const updated = right.updatedAt.localeCompare(left.updatedAt);
  return updated === 0 ? Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)) : updated;
}

export async function readRecentDebtDocuments(
  world: WorldRoot,
  input: Readonly<{ namespace?: readonly string[]; selection?: "all" | "active"; limit?: number }>,
): Promise<BoundedList<DebtDocument>> {
  const limit = boundedListLimit(input.limit);
  const directory = await debtsDirectory(world);
  const debts: DebtDocument[] = [];
  for (const path of await authorityFiles(directory)) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error(`Debt authority is not a regular file: ${path}`);
    const coordinate = coordinateFromPath(directory, path);
    if (input.namespace !== undefined && !sameNamespace(coordinate.namespace, input.namespace)) continue;
    const debt = parseDebtDocument(await readFile(path), coordinate);
    if (input.selection === "active" && (debt.state === "done" || debt.state === "drop")) continue;
    debts.push(debt);
  }
  return projectBoundedList(debts.sort(compareRecentDebts), limit);
}

export async function readDebtDocument(world: WorldRoot, id: DebtId): Promise<DebtDocument | undefined> {
  const resolved = await resolveAuthority(world, id, "read");
  return resolved.exists ? parseDebtDocument(await readFile(resolved.path), parseDebtId(id)) : undefined;
}

function equal(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === null || right === null ? left === right : Buffer.from(left).equals(Buffer.from(right));
}
async function currentBytes(world: WorldRoot, id: DebtId): Promise<Uint8Array | null> {
  const resolved = await resolveAuthority(world, id, "read");
  return resolved.exists ? readFile(resolved.path) : null;
}

export async function replaceAuthority(
  input: Readonly<{
    world: WorldRoot;
    id: DebtId;
    expected: Uint8Array | null;
    next: Uint8Array;
  }>,
): Promise<"replaced" | "concurrent-modification"> {
  const resolved = await resolveAuthority(input.world, input.id, "write");
  const parent = dirname(resolved.path);
  const temporary = resolve(parent, `.tmp-${randomBytes(8).toString("hex")}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, input.next);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (!equal(await currentBytes(input.world, input.id), input.expected)) return "concurrent-modification";
    renameSync(temporary, resolved.path);
    syncDirectory(parent);
    return "replaced";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      await unlink(temporary);
    } catch {
      /* renamed or best effort */
    }
  }
}

export async function authorityBytesMatch(world: WorldRoot, id: DebtId, expected: Uint8Array | null): Promise<boolean> {
  return equal(await currentBytes(world, id), expected);
}

function lockPath(world: WorldRoot, id: DebtId): string {
  const coordinate = parseDebtId(id);
  return resolve(
    world,
    ".keiyaku",
    "locks",
    "debt",
    ...coordinate.namespace.map((segment) => physicalDebtSegment(segment)),
    `${physicalDebtSegment(coordinate.localId, DEBT_LOCAL_ID_BYTES)}.sqlite`,
  );
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preserveCommittedResult<T>(result: T, errors: readonly unknown[]): T {
  if (typeof result === "object" && result !== null && "kind" in result) {
    const kind = (result as { kind?: unknown }).kind;
    if (kind === "accepted" || kind === "changed" || kind === "incomplete") {
      const previous = (result as { cleanup?: { diagnostics: readonly string[] } }).cleanup;
      return {
        ...(result as object),
        cleanup: {
          kind: "lock-release-failed",
          diagnostics: [...(previous?.diagnostics ?? []), ...errors.map(errorDetail)],
        },
      } as T;
    }
  }
  throw new AggregateError(errors, "Debt lock cleanup failed");
}

export async function nukeDebtAuthority(
  world: WorldRoot,
  options?: Readonly<{ timeoutMs?: number; onRemoved?(count: number): void }>,
): Promise<number | "busy"> {
  const directory = await debtsDirectory(world);
  const lockOptions = options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
  const result = await withDebtLocks({ world, allocation: true, ids: [], ...lockOptions }, async () => {
    const candidates = await ownedAuthorityCandidates(directory);
    const ids = [...new Set(candidates.map((candidate) => candidate.id))].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    return await withDebtLocks({ world, allocation: false, ids, ...lockOptions }, async () => {
      let removed = 0;
      for (const candidate of candidates) {
        try {
          const resolved = await resolveAuthority(world, candidate.id, "read");
          if (resolved.exists) {
            await unlink(resolved.path);
            removed += 1;
            options?.onRemoved?.(1);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await removeEmptyDebtDirectories(directory, false);
      return removed;
    });
  });
  if (result === "busy") return "busy";
  return result;
}

export async function withDebtLocks<T>(
  input: Readonly<{
    world: WorldRoot;
    allocation: boolean;
    ids: readonly DebtId[];
    timeoutMs?: number;
    signal?: AbortSignal;
  }>,
  action: () => Promise<T>,
): Promise<T | "busy"> {
  const paths = [
    ...(input.allocation ? [allocationLockPath(input.world)] : []),
    ...[...new Set(input.ids)]
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map((id) => lockPath(input.world, id)),
  ];
  const held: HeldSqliteTransactionLock[] = [];
  let result: T | undefined;
  let failure: unknown;
  try {
    for (const path of paths)
      held.push(
        await acquireSqliteTransactionLock({
          path,
          mode: "immediate",
          timeoutMs: input.timeoutMs ?? DEFAULT_DEBT_LOCK_TIMEOUT_MS,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
      );
    result = await action();
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const lock of held.reverse()) {
      try {
        lock.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      if (failure === undefined && result !== undefined) result = preserveCommittedResult(result, cleanupErrors);
      else if (failure === undefined) failure = new AggregateError(cleanupErrors, "Debt lock cleanup failed");
      else {
        const originalFailure = failure;
        failure = new AggregateError([originalFailure, ...cleanupErrors], errorDetail(originalFailure), {
          cause: originalFailure,
        });
      }
    }
  }
  if (failure !== undefined) {
    if (failure instanceof SqliteTransactionLockError && failure.reason === "timeout") return "busy";
    throw failure;
  }
  return result as T;
}
