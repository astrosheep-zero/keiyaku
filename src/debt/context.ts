import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  const path = currentPath(root);
  let bytes: string;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "malformed", path };
    bytes = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (!bytes.endsWith("\n") || bytes.slice(0, -1).includes("\n")) return { kind: "malformed", path };
  const content = bytes.slice(0, -1);
  const segments = content === "" ? [] : content.split("/");
  return validNamespaceSegments(segments) ? segments : { kind: "malformed", path };
}

/** One ancestor walk: the nearest context at or below the boundary, and the directory that answers it. */
async function walkNamespaceContext(
  coordinates: NamespaceContextInput,
): Promise<Readonly<{ read: NamespaceContextRead; root: string }>> {
  const boundary = resolve(coordinates.boundary);
  let current = resolve(coordinates.directory);
  for (;;) {
    const read = await readAt(current);
    if (read !== "absent" || current === boundary) return { read, root: current };
    const parent = dirname(current);
    if (parent === current || !descendsFrom(parent, boundary)) return { read, root: current };
    current = parent;
  }
}

/** Whether `candidate` is the boundary or lies beneath it; a sibling or ancestor never does. */
function descendsFrom(candidate: string, boundary: string): boolean {
  const step = relative(boundary, candidate);
  return step === "" || (!isAbsolute(step) && step !== ".." && !step.startsWith(`..${sep}`));
}

export async function readNamespaceContext(coordinates: NamespaceContextInput): Promise<NamespaceContextRead> {
  return (await walkNamespaceContext(coordinates)).read;
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
  if (Array.isArray(await readAt(root))) {
    await installIgnore(root);
    return "kept";
  }
  await installNamespaceContext(root, segments);
  return "installed";
}

export async function resolveDebtNamespaceContext(
  input: NamespaceContextInput,
): Promise<ResolvedNamespaceContext | Readonly<{ kind: "invalid-namespace-context"; path: string }>> {
  const { read, root } = await walkNamespaceContext(input);
  if (read === "absent") return { namespace: [], source: "default-root" };
  if (typeof read === "object" && "kind" in read) return { kind: "invalid-namespace-context", path: read.path };
  return {
    namespace: read,
    source: root === resolve(input.boundary) && input.managed === true ? "contract-installed" : "local-override",
  };
}
