import { randomBytes } from "node:crypto";
import {
  closeSync, fsyncSync, openSync, renameSync, writeFileSync,
} from "node:fs";
import { lstat, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { acquireSqliteTransactionLock, SqliteTransactionLockError, type HeldSqliteTransactionLock } from "../coordination/sqlite-transaction-lock.js";
import type { WorldRoot } from "../world.js";
import { parseTaskDocument, type TaskDocument } from "./document.js";
import { formatTaskId, parseTaskId, taskAuthorityPath, type TaskId } from "./identity.js";
import type { TaskBoard } from "./board.js";

export type BoardSnapshot = Readonly<{ board: TaskBoard; bytes: ReadonlyMap<TaskId, Uint8Array> }>;
type TaskNukeCustody = Readonly<{
  authorityIds: readonly TaskId[];
  lockIds: readonly TaskId[];
  lockPaths: readonly string[];
}>;

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

function tasksDirectory(world: WorldRoot): string { return resolve(world, ".keiyaku", "tasks"); }
function taskLocksDirectory(world: WorldRoot): string { return resolve(world, ".keiyaku", "locks", "task"); }
function allocationLockPath(world: WorldRoot): string { return resolve(world, ".keiyaku", "locks", "task-allocation.sqlite"); }

async function authorityFiles(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await authorityFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function coordinateFromPath(tasksDirectory: string, path: string) {
  const local = relative(tasksDirectory, path);
  if (local.startsWith("..") || resolve(tasksDirectory, local) !== path || !local.endsWith(".md")) throw new Error(`invalid Task authority path: ${path}`);
  return parseTaskId(`task/${local.slice(0, -3).split(sep).join("/")}`);
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

function equal(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === null || right === null ? left === right : Buffer.from(left).equals(Buffer.from(right));
}
async function currentBytes(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function replaceAuthority(input: Readonly<{
  path: string;
  expected: Uint8Array | null;
  next: Uint8Array;
}>): Promise<"replaced" | "concurrent-modification"> {
  const parent = dirname(input.path);
  await mkdir(parent, { recursive: true });
  const temporary = resolve(parent, `.tmp-${randomBytes(8).toString("hex")}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, input.next);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (!equal(await currentBytes(input.path), input.expected)) return "concurrent-modification";
    renameSync(temporary, input.path);
    syncTaskDirectory(parent);
    return "replaced";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { await unlink(temporary); } catch { /* renamed or best effort */ }
  }
}

function lockPath(world: WorldRoot, id: TaskId): string {
  const coordinate = parseTaskId(id);
  return resolve(world, ".keiyaku", "locks", "task", ...coordinate.namespace, `${coordinate.localId}.sqlite`);
}

async function regularFile(path: string, label: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function taskLockFiles(world: WorldRoot, directory = taskLocksDirectory(world)): Promise<readonly Readonly<{ id: TaskId; path: string }>[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: Readonly<{ id: TaskId; path: string }>[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await taskLockFiles(world, path));
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".sqlite")) {
      throw new Error(`Task lock has foreign or corrupt custody: ${path}`);
    }
    const local = relative(taskLocksDirectory(world), path);
    const id = formatTaskId(parseTaskId(`task/${local.slice(0, -7).split(sep).join("/")}`));
    if (lockPath(world, id) !== path) throw new Error(`Task lock has invalid coordinate: ${path}`);
    files.push({ id, path });
  }
  return files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}

async function taskNukeCustody(world: WorldRoot): Promise<TaskNukeCustody> {
  const snapshot = await readBoard(world);
  const locks = await taskLockFiles(world);
  const allocation = allocationLockPath(world);
  const lockPaths = [
    ...(await regularFile(allocation, "Task allocation lock") ? [allocation] : []),
    ...locks.map((lock) => lock.path),
  ];
  return {
    authorityIds: [...snapshot.board.tasks.keys()].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
    lockIds: locks.map((lock) => lock.id),
    lockPaths,
  };
}

function sameIds(left: readonly TaskId[], right: readonly TaskId[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

async function removeRegularFile(path: string, label: string): Promise<void> {
  if (!(await regularFile(path, label))) return;
  await unlink(path);
}

export async function nukeTaskAuthority(world: WorldRoot): Promise<void | "busy"> {
  const initial = await taskNukeCustody(world);
  if (initial.authorityIds.length === 0 && initial.lockPaths.length === 0) return;

  const ids = [...new Set([...initial.authorityIds, ...initial.lockIds])];
  const result = await withTaskLocks({ world, allocation: true, ids }, async () => {
    const fresh = await taskNukeCustody(world);
    if (!sameIds(initial.authorityIds, fresh.authorityIds)) {
      throw new Error("Task authority changed while acquiring reset locks");
    }
    const expectedLocks = new Set([
      ...initial.lockPaths,
      allocationLockPath(world),
      ...initial.authorityIds.map((id) => lockPath(world, id)),
    ]);
    if (fresh.lockPaths.some((path) => !expectedLocks.has(path))) {
      throw new Error("Task lock custody changed while acquiring reset locks");
    }
    for (const id of fresh.authorityIds) {
      await removeRegularFile(authorityPath(world, id), "Task authority");
    }
  });
  if (result === "busy") return "busy";
}

export async function withTaskLocks<T>(input: Readonly<{
  world: WorldRoot; allocation: boolean; ids: readonly TaskId[]; timeoutMs?: number; signal?: AbortSignal;
}>, action: () => Promise<T>): Promise<T | "busy"> {
  const paths = [
    ...(input.allocation ? [allocationLockPath(input.world)] : []),
    ...[...new Set(input.ids)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map((id) => lockPath(input.world, id)),
  ];
  const held: HeldSqliteTransactionLock[] = [];
  try {
    for (const path of paths) held.push(await acquireSqliteTransactionLock({
      path,
      mode: "immediate",
      timeoutMs: input.timeoutMs ?? DEFAULT_TASK_LOCK_TIMEOUT_MS,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }));
    return await action();
  } catch (error) {
    if (error instanceof SqliteTransactionLockError && error.reason === "timeout") return "busy";
    throw error;
  } finally {
    for (const lock of held.reverse()) lock.close();
  }
}

export function authorityPath(world: WorldRoot, id: TaskId): string { return taskAuthorityPath(tasksDirectory(world), parseTaskId(id)); }
