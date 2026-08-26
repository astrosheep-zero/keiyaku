import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { repairDerivedFile, replaceFileDurably } from "../coordination/durable-file.js";
import { normalizeIdentityStem } from "../identity/normalize.js";

export type NamespaceContextRead =
  | readonly string[]
  | "absent"
  | Readonly<{
      kind: "malformed";
      path: string;
    }>;
export type NamespaceContextInput = Readonly<{
  directory: string;
  boundary: string;
  managed?: boolean;
}>;
export type NamespaceContextSource = "default-root" | "contract-installed" | "local-override";
export type ResolvedNamespaceContext = Readonly<{
  namespace: readonly string[];
  source: NamespaceContextSource;
}>;

function directory(root: string): string {
  return join(root, ".keiyaku", "namespace");
}
function currentPath(root: string): string {
  return join(directory(root), "current");
}
function ignorePath(root: string): string {
  return join(directory(root), ".gitignore");
}

function validNamespaceSegments(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (segment) =>
        typeof segment === "string" &&
        segment.length > 0 &&
        normalizeIdentityStem({ source: segment }) === segment &&
        !segment.includes("/") &&
        segment !== "." &&
        segment !== "..",
    )
  );
}

async function readAt(root: string): Promise<NamespaceContextRead> {
  let bytes: string;
  try {
    const path = currentPath(root),
      stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "malformed", path };
    bytes = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (!bytes.endsWith("\n") || bytes.slice(0, -1).includes("\n")) {
    return { kind: "malformed", path: currentPath(root) };
  }
  const content = bytes.slice(0, -1);
  const segments = content === "" ? [] : content.split("/");
  return validNamespaceSegments(segments) ? segments : { kind: "malformed", path: currentPath(root) };
}

async function readAtWithPath(
  root: string,
): Promise<NamespaceContextRead | Readonly<{ value: readonly string[]; path: string }>> {
  const selected = await readAt(root);
  if (selected === "absent" || (typeof selected === "object" && "kind" in selected)) return selected;
  return { value: selected, path: currentPath(root) };
}

export async function readNamespaceContext(coordinates: NamespaceContextInput): Promise<NamespaceContextRead> {
  let current = coordinates.directory;
  for (;;) {
    const selected = await readAt(current);
    if (selected !== "absent") return selected;
    if (current === coordinates.boundary) return "absent";
    const resolvedParent = dirname(resolve(current));
    if (resolvedParent === current || !resolvedParent.startsWith(`${coordinates.boundary}/`)) return "absent";
    current = resolvedParent;
  }
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
  const current = await readNamespaceContext({ directory: root, boundary: root });
  if (Array.isArray(current)) {
    await installIgnore(root);
    return "kept";
  }
  await installNamespaceContext(root, segments);
  return "installed";
}

export async function resolveTaskNamespaceContext(
  input: NamespaceContextInput,
): Promise<ResolvedNamespaceContext | Readonly<{ kind: "invalid-namespace-context"; path: string }>> {
  let current = input.directory;
  for (;;) {
    const selected = await readAtWithPath(current);
    if (selected !== "absent") {
      if (typeof selected === "object" && "kind" in selected)
        return { kind: "invalid-namespace-context", path: selected.path };
      return {
        namespace: "value" in selected ? selected.value : selected,
        source: current === input.boundary && input.managed === true ? "contract-installed" : "local-override",
      };
    }
    if (current === input.boundary) return { namespace: [], source: "default-root" };
    const resolvedParent = dirname(resolve(current));
    if (resolvedParent === current || !resolvedParent.startsWith(`${input.boundary}/`)) {
      return { namespace: [], source: "default-root" };
    }
    current = resolvedParent;
  }
}

export async function writeTaskNamespaceContext(directory: string, value: readonly string[]): Promise<void> {
  await installNamespaceContext(directory, value);
}
