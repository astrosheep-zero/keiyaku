import { randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { acquireSqliteTransactionLock, SqliteTransactionLockError, type HeldSqliteTransactionLock } from "../coordination/sqlite-transaction-lock.js";
import type { WorldRoot } from "../world.js";
import { parseTaskDocument, type TaskDocument } from "./document.js";
import { formatTaskId, parseTaskId, taskAuthorityPath, type TaskId } from "./identity.js";
import { projectStatusRows, type TaskBoard, type TaskStatusRow } from "./board.js";

export type BoardSnapshot = Readonly<{ board: TaskBoard; bytes: ReadonlyMap<TaskId, Uint8Array> }>;

function tasksDirectory(world: WorldRoot): string { return resolve(world, ".keiyaku", "tasks"); }

function authorityFiles(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...authorityFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    else throw new Error(`unexpected Task authority entry: ${path}`);
  }
  return files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function coordinateFromPath(tasksDirectory: string, path: string) {
  const local = relative(tasksDirectory, path);
  if (local.startsWith("..") || resolve(tasksDirectory, local) !== path || !local.endsWith(".md")) throw new Error(`invalid Task authority path: ${path}`);
  return parseTaskId(`task/${local.slice(0, -3).split(sep).join("/")}`);
}

export function readBoard(world: WorldRoot): BoardSnapshot {
  const directory = tasksDirectory(world);
  const tasks = new Map<TaskId, TaskDocument>(), bytes = new Map<TaskId, Uint8Array>();
  for (const path of authorityFiles(directory)) {
    const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Task authority is not a regular file: ${path}`);
    const coordinate = coordinateFromPath(directory, path); const id = formatTaskId(coordinate); const source = readFileSync(path);
    tasks.set(id, parseTaskDocument(source, coordinate)); bytes.set(id, source);
  }
  return { board: { tasks }, bytes };
}

/** Read one complete Task board and retain blocker evidence on blocked rows. */
export function readTaskStatusRows(world: WorldRoot): readonly TaskStatusRow[] {
  return projectStatusRows(readBoard(world).board, null);
}

function equal(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === null || right === null ? left === right : Buffer.from(left).equals(Buffer.from(right));
}
function currentBytes(path: string): Uint8Array | null {
  try { return readFileSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export function replaceAuthority(input: Readonly<{ path: string; expected: Uint8Array | null; next: Uint8Array }>): "replaced" | "concurrent-modification" {
  const parent = dirname(input.path); mkdirSync(parent, { recursive: true });
  const temporary = resolve(parent, `.tmp-${randomBytes(8).toString("hex")}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600); writeFileSync(descriptor, input.next); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    if (!equal(currentBytes(input.path), input.expected)) return "concurrent-modification";
    renameSync(temporary, input.path);
    const directoryDescriptor = openSync(parent, "r"); try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    return "replaced";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* renamed or best effort */ }
  }
}

function lockPath(world: WorldRoot, id: TaskId): string {
  const coordinate = parseTaskId(id);
  return resolve(world, ".keiyaku", "locks", "task", ...coordinate.namespace, `${coordinate.localId}.sqlite`);
}

export async function withTaskLocks<T>(input: Readonly<{
  world: WorldRoot; allocation: boolean; ids: readonly TaskId[]; signal?: AbortSignal;
}>, action: () => Promise<T>): Promise<T | "busy"> {
  const paths = [
    ...(input.allocation ? [resolve(input.world, ".keiyaku", "locks", "task-allocation.sqlite")] : []),
    ...[...new Set(input.ids)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map((id) => lockPath(input.world, id)),
  ];
  const held: HeldSqliteTransactionLock[] = [];
  try {
    for (const path of paths) held.push(await acquireSqliteTransactionLock({ path, mode: "immediate", timeoutMs: 3_000, ...(input.signal === undefined ? {} : { signal: input.signal }) }));
    return await action();
  } catch (error) {
    if (error instanceof SqliteTransactionLockError && error.reason === "timeout") return "busy";
    throw error;
  } finally {
    for (const lock of held.reverse()) lock.close();
  }
}

export function authorityPath(world: WorldRoot, id: TaskId): string { return taskAuthorityPath(tasksDirectory(world), parseTaskId(id)); }
