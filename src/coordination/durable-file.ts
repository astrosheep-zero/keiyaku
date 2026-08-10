import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
