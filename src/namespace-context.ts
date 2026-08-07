import { randomBytes } from "node:crypto";
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { normalizeIdentityStem } from "./identity/normalize.js";

export type NamespaceContextRead = readonly string[] | "absent" | "malformed";

function directory(root: string): string { return join(root, ".keiyaku", "namespace"); }
function currentPath(root: string): string { return join(directory(root), "current"); }
function ignorePath(root: string): string { return join(directory(root), ".gitignore"); }

function validNamespaceSegments(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((segment) => typeof segment === "string"
    && segment.length > 0 && normalizeIdentityStem({ source: segment }) === segment
    && !segment.includes("/") && segment !== "." && segment !== "..");
}

export function readNamespaceContext(root: string): NamespaceContextRead {
  let bytes: string;
  try {
    const path = currentPath(root), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return "malformed";
    bytes = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (!bytes.endsWith("\n") || bytes.slice(0, -1).includes("\n")) return "malformed";
  const content = bytes.slice(0, -1);
  const segments = content === "" ? [] : content.split("/");
  return validNamespaceSegments(segments) ? segments : "malformed";
}

function replaceFile(path: string, bytes: string): void {
  const parent = dirname(path);
  for (;;) {
    const temporary = join(parent, `.tmp-${randomBytes(8).toString("hex")}`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, bytes); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
      renameSync(temporary, path);
      const directoryDescriptor = openSync(parent, "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
      return;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch { /* best effort */ }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export function installNamespaceContext(root: string, segments: readonly string[]): void {
  if (!validNamespaceSegments(segments)) throw new TypeError("namespace must contain normalized segments");
  const parent = directory(root); mkdirSync(parent, { recursive: true });
  installIgnore(root);
  replaceFile(currentPath(root), `${segments.join("/")}\n`);
}

function installIgnore(root: string): void {
  const ignore = ignorePath(root);
  const stat = lstatSync(ignore, { throwIfNoEntry: false });
  if (stat !== undefined && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`namespace ignore is not a regular file: ${ignore}`);
  if (stat === undefined || readFileSync(ignore, "utf8") !== "*\n") replaceFile(ignore, "*\n");
}

export function repairNamespaceContext(root: string, segments: readonly string[]): "kept" | "installed" {
  const current = readNamespaceContext(root);
  if (Array.isArray(current)) {
    installIgnore(root);
    return "kept";
  }
  installNamespaceContext(root, segments);
  return "installed";
}
