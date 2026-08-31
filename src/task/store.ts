import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  acquireSqliteTransactionLock,
  SqliteTransactionLockError,
  type HeldSqliteTransactionLock,
} from "../coordination/sqlite-transaction-lock.js";
import type { WorldRoot } from "../world.js";
import { boundedListLimit, projectBoundedList, type BoundedList } from "../bounded-list.js";
import { parseTaskDocument, type TaskDocument } from "./document.js";
import { formatTaskId, parseTaskId, sameNamespace, taskAuthorityPath, type TaskId } from "./identity.js";
import type { TaskBoard } from "./board.js";

export type BoardSnapshot = Readonly<{ board: TaskBoard; bytes: ReadonlyMap<TaskId, Uint8Array> }>;
export const DEFAULT_TASK_LOCK_TIMEOUT_MS = 3_000;

function syncTaskDirectory(path: string): void {
  if (process.platform === "win32") return;
  const directory = openSync(path, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function tasksDirectory(world: WorldRoot): string {
  return resolve(world, ".keiyaku", "tasks");
}
function allocationLockPath(world: WorldRoot): string {
  return resolve(world, ".keiyaku", "locks", "task-allocation.sqlite");
}

function custodyError(path: string): Error {
  return new Error(`Task authority custody violation: symlink or non-authority component: ${path}`);
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
  id: TaskId,
  mode: "read" | "write",
): Promise<{ path: string; exists: boolean }> {
  const coordinate = parseTaskId(id);
  const root = tasksDirectory(world);
  if (!(await requireDirectory(root, mode))) return { path: taskAuthorityPath(root, coordinate), exists: false };
  let parent = root;
  for (const segment of coordinate.namespace) {
    parent = resolve(parent, segment);
    if (!(await requireDirectory(parent, mode))) return { path: taskAuthorityPath(root, coordinate), exists: false };
  }
  const path = taskAuthorityPath(root, coordinate);
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

function coordinateFromPath(tasksDirectory: string, path: string) {
  const local = relative(tasksDirectory, path);
  if (local.startsWith("..") || resolve(tasksDirectory, local) !== path || !local.endsWith(".md"))
    throw new Error(`invalid Task authority path: ${path}`);
  return parseTaskId(`task/${local.slice(0, -3).split(sep).join("/")}`);
}

function ownedTaskId(tasksDirectory: string, path: string): TaskId | null {
  try {
    return formatTaskId(coordinateFromPath(tasksDirectory, path));
  } catch {
    return null;
  }
}

async function ownedAuthorityCandidates(directory: string): Promise<readonly Readonly<{ id: TaskId; path: string }>[]> {
  const candidates: Readonly<{ id: TaskId; path: string }>[] = [];
  for (const path of await authorityFiles(directory)) {
    const id = ownedTaskId(directory, path);
    if (id !== null) candidates.push({ id, path });
  }
  return candidates;
}

async function removeEmptyTaskDirectories(directory: string, removeSelf: boolean): Promise<void> {
  if (!(await requireDirectory(directory, "read"))) return;
  const entries = await readdir(directory);
  for (const entry of entries) {
    const path = resolve(directory, entry);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw custodyError(path);
    if (stat.isDirectory()) await removeEmptyTaskDirectories(path, true);
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
  const directory = tasksDirectory(world);
  const tasks = new Map<TaskId, TaskDocument>();
  const bytes = new Map<TaskId, Uint8Array>();
  for (const path of await authorityFiles(directory)) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Task authority is not a regular file: ${path}`);
    }
    const coordinate = coordinateFromPath(directory, path);
    const id = formatTaskId(coordinate);
    const source = await readFile(path);
    tasks.set(id, parseTaskDocument(source, coordinate));
    bytes.set(id, source);
  }
  return { board: { tasks }, bytes };
}

function compareRecentTasks(left: TaskDocument, right: TaskDocument): number {
  const updated = right.updatedAt.localeCompare(left.updatedAt);
  return updated === 0 ? Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)) : updated;
}

export async function readRecentTaskDocuments(
  world: WorldRoot,
  input: Readonly<{ namespace?: readonly string[]; selection?: "all" | "active"; limit?: number }>,
): Promise<BoundedList<TaskDocument>> {
  const limit = boundedListLimit(input.limit);
  const directory = tasksDirectory(world);
  const tasks: TaskDocument[] = [];
  for (const path of await authorityFiles(directory)) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error(`Task authority is not a regular file: ${path}`);
    const coordinate = coordinateFromPath(directory, path);
    if (input.namespace !== undefined && !sameNamespace(coordinate.namespace, input.namespace)) continue;
    const task = parseTaskDocument(await readFile(path), coordinate);
    if (input.selection === "active" && (task.state === "done" || task.state === "drop")) continue;
    tasks.push(task);
  }
  return projectBoundedList(tasks.sort(compareRecentTasks), limit);
}

export async function readTaskDocument(world: WorldRoot, id: TaskId): Promise<TaskDocument | undefined> {
  const resolved = await resolveAuthority(world, id, "read");
  return resolved.exists ? parseTaskDocument(await readFile(resolved.path), parseTaskId(id)) : undefined;
}

function equal(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === null || right === null ? left === right : Buffer.from(left).equals(Buffer.from(right));
}
async function currentBytes(world: WorldRoot, id: TaskId): Promise<Uint8Array | null> {
  const resolved = await resolveAuthority(world, id, "read");
  return resolved.exists ? readFile(resolved.path) : null;
}

export async function replaceAuthority(
  input: Readonly<{
    world: WorldRoot;
    id: TaskId;
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
    syncTaskDirectory(parent);
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

export async function authorityBytesMatch(world: WorldRoot, id: TaskId, expected: Uint8Array | null): Promise<boolean> {
  return equal(await currentBytes(world, id), expected);
}

function lockPath(world: WorldRoot, id: TaskId): string {
  const coordinate = parseTaskId(id);
  return resolve(world, ".keiyaku", "locks", "task", ...coordinate.namespace, `${coordinate.localId}.sqlite`);
}

export async function nukeTaskAuthority(
  world: WorldRoot,
  options?: Readonly<{ timeoutMs?: number }>,
): Promise<void | "busy"> {
  const directory = tasksDirectory(world);
  const lockOptions = options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
  const result = await withTaskLocks({ world, allocation: true, ids: [], ...lockOptions }, async () => {
    const candidates = await ownedAuthorityCandidates(directory);
    const ids = [...new Set(candidates.map((candidate) => candidate.id))].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    return await withTaskLocks({ world, allocation: false, ids, ...lockOptions }, async () => {
      for (const candidate of candidates) {
        try {
          const resolved = await resolveAuthority(world, candidate.id, "read");
          if (resolved.exists) await unlink(resolved.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await removeEmptyTaskDirectories(directory, false);
    });
  });
  if (result === "busy") return "busy";
}

export async function withTaskLocks<T>(
  input: Readonly<{
    world: WorldRoot;
    allocation: boolean;
    ids: readonly TaskId[];
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
  try {
    for (const path of paths)
      held.push(
        await acquireSqliteTransactionLock({
          path,
          mode: "immediate",
          timeoutMs: input.timeoutMs ?? DEFAULT_TASK_LOCK_TIMEOUT_MS,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
      );
    return await action();
  } catch (error) {
    if (error instanceof SqliteTransactionLockError && error.reason === "timeout") return "busy";
    throw error;
  } finally {
    for (const lock of held.reverse()) lock.close();
  }
}

export function authorityPath(world: WorldRoot, id: TaskId): string {
  return taskAuthorityPath(tasksDirectory(world), parseTaskId(id));
}
