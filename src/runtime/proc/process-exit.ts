import { open, type FileHandle } from "node:fs/promises";
import type { DetachedProcessExit } from "./types.js";

export function detachedExitStatus(code: number | null, signal: NodeJS.Signals | null): string {
  return code === null ? `signal ${signal ?? "unknown"}` : `exit ${code}`;
}

export async function retainDetachedExitEvidence(
  log: FileHandle,
  path: string,
  from: number,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<DetachedProcessExit> {
  const status = detachedExitStatus(code, signal);
  const marker = Buffer.from(`[child ${status}]\n`);
  let written = 0;
  while (written < marker.byteLength) {
    const write = await log.write(marker, written, marker.byteLength - written);
    if (write.bytesWritten === 0) throw new Error("run log exit marker write made no progress");
    written += write.bytesWritten;
  }
  const evidence = await log.stat();
  if (evidence.size < from) throw new Error("run log shrank before exit evidence was retained");
  const referenced = await open(path, "r");
  try {
    const current = await referenced.stat();
    if (current.dev !== evidence.dev || current.ino !== evidence.ino) {
      throw new Error("run log path changed before exit evidence was retained");
    }
    if (current.size < evidence.size) throw new Error("run log path size changed before exit evidence was retained");
  } finally {
    await referenced.close();
  }
  return { code, signal, log: { path, from, to: evidence.size } };
}
