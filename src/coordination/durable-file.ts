import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const directory = openSync(path, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export async function replaceFileDurably(path: string, bytes: string | Uint8Array): Promise<void> {
  const parent = dirname(path);
  for (;;) {
    const temporary = resolve(parent, `.tmp-${randomBytes(8).toString("hex")}`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, path);
      syncDirectory(parent);
      return;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try { await unlink(temporary); } catch { /* renamed, absent, or best-effort cleanup */ }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export type DerivedFileAction = "created" | "updated" | "unchanged";

export async function createFileDurablyExclusive(
  path: string,
  bytes: string | Uint8Array,
  mode = 0o600,
): Promise<boolean> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", mode);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    syncDirectory(parent);
    return true;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    try { await unlink(path); } catch { /* absent or best-effort cleanup */ }
    throw error;
  }
}

export async function repairDerivedFile(path: string, bytes: string | Uint8Array): Promise<DerivedFileAction> {
  const expected = Buffer.from(bytes);
  await mkdir(dirname(path), { recursive: true });
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat !== undefined && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error(`derived file is not a regular file: ${path}`);
  }
  if (stat !== undefined && (await readFile(path)).equals(expected)) return "unchanged";
  await replaceFileDurably(path, expected);
  return stat === undefined ? "created" : "updated";
}
