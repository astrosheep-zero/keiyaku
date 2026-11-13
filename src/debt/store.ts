import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  acquireSqliteTransactionLock,
  SqliteTransactionLockError,
  type HeldSqliteTransactionLock,
} from "../coordination/sqlite-transaction-lock.js";
import { syncDirectory } from "../coordination/durable-file.js";
import type { WorldRoot } from "../world.js";
import { boundedListLimit, projectBoundedList, type BoundedList } from "../bounded-list.js";
import { DebtAuthorityCorruptionError, parseDebtDocument, type DebtDocument } from "./document.js";
import { canonicalDebtId, physicalDebtSegment, debtAuthorityPath, type DebtId } from "./identity.js";
import type { DebtBoard } from "./board.js";

export type BoardSnapshot = Readonly<{ board: DebtBoard; bytes: ReadonlyMap<DebtId, Uint8Array> }>;
const DEFAULT_DEBT_LOCK_TIMEOUT_MS = 3_000;

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
  const root = resolve(world, ".keiyaku", "debts");
  const path = debtAuthorityPath(root, id);
  if (!(await requireDirectory(root, mode))) return { path, exists: false };
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
    if (stat.isFile() && entry.endsWith(".md")) files.push(path);
  }
  return files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function idFromPath(path: string): DebtId {
  try {
    const member = physicalDebtSegment(basename(path, ".md"));
    return canonicalDebtId(`debt/${member}`);
  } catch (error) {
    throw new DebtAuthorityCorruptionError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

async function ownedAuthorityIds(directory: string): Promise<readonly DebtId[]> {
  const ids: DebtId[] = [];
  for (const path of await authorityFiles(directory)) {
    try {
      ids.push(idFromPath(path));
    } catch {
      // Files outside the Debt identity grammar are not owned candidates.
    }
  }
  return ids;
}

export async function readBoard(world: WorldRoot): Promise<BoardSnapshot> {
  const directory = resolve(world, ".keiyaku", "debts");
  const paths = await authorityFiles(directory);
  const reads = new Array<{ kind: "read"; id: DebtId; source: Uint8Array } | { kind: "failed"; error: unknown }>(
    paths.length,
  );
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
        reads[index] = { kind: "read", id: idFromPath(path), source: await readFile(path) };
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
    const { id, source } = read;
    debts.set(id, parseDebtDocument(source, id));
    bytes.set(id, source);
  }
  return { board: { debts }, bytes };
}

function compareRecentDebts(left: DebtDocument, right: DebtDocument): number {
  const updated = right.updatedAt.localeCompare(left.updatedAt);
  return updated === 0 ? Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)) : updated;
}

export type OpenDebtDocument = Omit<DebtDocument, "state"> & Readonly<{ state: "open" }>;

export async function readRecentDebtDocuments(
  world: WorldRoot,
  input: Readonly<{ limit?: number }>,
): Promise<BoundedList<OpenDebtDocument>> {
  const limit = boundedListLimit(input.limit);
  const directory = resolve(world, ".keiyaku", "debts");
  const debts: OpenDebtDocument[] = [];
  for (const path of await authorityFiles(directory)) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error(`Debt authority is not a regular file: ${path}`);
    const debt = parseDebtDocument(await readFile(path), idFromPath(path));
    if (debt.state !== "open") continue;
    debts.push({ ...debt, state: debt.state });
  }
  return projectBoundedList(debts.sort(compareRecentDebts), limit);
}

export async function readDebtDocument(world: WorldRoot, id: DebtId): Promise<DebtDocument | undefined> {
  const resolved = await resolveAuthority(world, id, "read");
  return resolved.exists ? parseDebtDocument(await readFile(resolved.path), id) : undefined;
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

function lockPath(world: WorldRoot, id: DebtId): string {
  return resolve(world, ".keiyaku", "locks", "debt", `${physicalDebtSegment(canonicalDebtId(id).slice(5))}.sqlite`);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preserveCommittedResult<T>(result: T, errors: readonly unknown[]): T {
  if (typeof result === "object" && result !== null && "kind" in result) {
    const kind = (result as { kind?: unknown }).kind;
    if (kind === "accepted" || kind === "changed") {
      const key = kind === "accepted" ? "warning" : "cleanup";
      const previous = (result as Record<string, string | undefined>)[key];
      return {
        ...(result as object),
        [key]: [previous, `Debt lock release failed: ${errors.map(errorDetail).join("; ")}`]
          .filter((value) => value !== undefined)
          .join("; "),
      } as T;
    }
  }
  throw new AggregateError(errors, "Debt lock cleanup failed");
}

export async function nukeDebtAuthority(
  world: WorldRoot,
  options?: Readonly<{ timeoutMs?: number; onRemoved?(count: number): void }>,
): Promise<number | "busy"> {
  const directory = resolve(world, ".keiyaku", "debts");
  const lockOptions = options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
  const result = await withDebtLocks({ world, allocation: true, ids: [], ...lockOptions }, async () => {
    const ids = await ownedAuthorityIds(directory);
    return await withDebtLocks({ world, allocation: false, ids, ...lockOptions }, async () => {
      let removed = 0;
      for (const id of ids) {
        try {
          const resolved = await resolveAuthority(world, id, "read");
          if (resolved.exists) {
            await unlink(resolved.path);
            removed += 1;
            options?.onRemoved?.(1);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
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
