import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { repairDerivedFile, replaceFileDurably } from "../coordination/durable-file.js";
import { normalizeIdentityStem } from "../identity/normalize.js";

export type NamespaceContextRead = readonly string[] | "absent" | "malformed";

function directory(root: string): string { return join(root, ".keiyaku", "namespace"); }
function currentPath(root: string): string { return join(directory(root), "current"); }
function ignorePath(root: string): string { return join(directory(root), ".gitignore"); }

function validNamespaceSegments(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((segment) => typeof segment === "string"
    && segment.length > 0 && normalizeIdentityStem({ source: segment }) === segment
    && !segment.includes("/") && segment !== "." && segment !== "..");
}

export async function readNamespaceContext(root: string): Promise<NamespaceContextRead> {
  let bytes: string;
  try {
    const path = currentPath(root), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return "malformed";
    bytes = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (!bytes.endsWith("\n") || bytes.slice(0, -1).includes("\n")) return "malformed";
  const content = bytes.slice(0, -1);
  const segments = content === "" ? [] : content.split("/");
  return validNamespaceSegments(segments) ? segments : "malformed";
}

export async function installNamespaceContext(root: string, segments: readonly string[]): Promise<void> {
  if (!validNamespaceSegments(segments)) throw new TypeError("namespace must contain normalized segments");
  const parent = directory(root);
  await mkdir(parent, { recursive: true });
  await installIgnore(root);
  await replaceFileDurably(currentPath(root), `${segments.join("/")}\n`);
}

async function installIgnore(root: string): Promise<void> {
  await repairDerivedFile(ignorePath(root), "*\n");
}

export async function repairNamespaceContext(root: string, segments: readonly string[]): Promise<"kept" | "installed"> {
  const current = await readNamespaceContext(root);
  if (Array.isArray(current)) {
    await installIgnore(root);
    return "kept";
  }
  await installNamespaceContext(root, segments);
  return "installed";
}
