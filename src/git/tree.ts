import { gitObjectId } from "./identity.js";
import { GitPlumbingError } from "./process.js";

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

export function parseTreeEntries(output: Buffer): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  const records = output.toString("utf8").split("\0");
  if (records.pop() !== "")
    throw new GitPlumbingError({ stderr: output, status: null, message: "unterminated ls-tree output" });
  for (const record of records) {
    const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]+)\t([^\0]+)$/u.exec(record);
    if (match === null || entries.has(match[4]!))
      throw new GitPlumbingError({ stderr: record, status: null, message: `malformed ls-tree record: ${record}` });
    const [, mode, type, oid, path] = match;
    validPath(path!);
    entries.set(path!, { mode: mode!, type: type!, oid: gitObjectId(oid!, `tree entry ${path}`) });
  }
  return entries;
}
