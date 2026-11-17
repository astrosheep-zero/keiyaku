import { gitObjectId } from "./identity.js";

export type TreeEntry = Readonly<{ mode: string; type: string; oid: string }>;
export type TreeChange = Readonly<{ oid: string; mode?: string; type?: string }> | null;

export function validPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  )
    throw new Error(`invalid Git path: ${path}`);
}

function entryType(mode: string): string {
  return mode === "040000" || mode === "40000" ? "tree" : mode === "160000" ? "commit" : "blob";
}

export function parseTreeObject(bytes: Buffer, oidBytes: number): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  let offset = 0;
  while (offset < bytes.length) {
    const modeEnd = bytes.indexOf(0x20, offset);
    const nameEnd = modeEnd < 0 ? -1 : bytes.indexOf(0, modeEnd + 1);
    if (modeEnd < 0 || nameEnd < 0 || nameEnd + 1 + oidBytes > bytes.length) {
      throw new Error("malformed Git tree object");
    }
    const rawMode = bytes.subarray(offset, modeEnd).toString("ascii");
    const mode = rawMode === "40000" ? "040000" : rawMode;
    const name = bytes.subarray(modeEnd + 1, nameEnd).toString("utf8");
    if (name.length === 0 || entries.has(name)) throw new Error("malformed Git tree object");
    const oid = bytes.subarray(nameEnd + 1, nameEnd + 1 + oidBytes).toString("hex");
    gitObjectId(oid, `tree entry ${name}`);
    entries.set(name, { mode, type: entryType(mode), oid });
    offset = nameEnd + 1 + oidBytes;
  }
  return entries;
}
