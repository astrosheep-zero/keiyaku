import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export function replaceFileDurably(path: string, bytes: string | Uint8Array): void {
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
      const directory = openSync(parent, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
      return;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch { /* renamed, absent, or best-effort cleanup */ }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export type DerivedFileAction = "created" | "updated" | "unchanged";

export function createFileDurablyExclusive(path: string, bytes: string | Uint8Array, mode = 0o600): boolean {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", mode);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const directory = openSync(parent, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return true;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    try { unlinkSync(path); } catch { /* absent or best-effort cleanup */ }
    throw error;
  }
}

export function repairDerivedFile(path: string, bytes: string | Uint8Array): DerivedFileAction {
  const expected = Buffer.from(bytes);
  mkdirSync(dirname(path), { recursive: true });
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat !== undefined && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error(`derived file is not a regular file: ${path}`);
  }
  if (stat !== undefined && readFileSync(path).equals(expected)) return "unchanged";
  replaceFileDurably(path, expected);
  return stat === undefined ? "created" : "updated";
}
