import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

const WORLD_BRAND: unique symbol = Symbol("keiyaku.world");

export type WorldRoot = string & { readonly [WORLD_BRAND]: true };
export type WorldResolutionInput = Readonly<{
  cwd: string;
  repositoryRoot?: string;
}>;
export type WorldResolution = Readonly<{
  root: WorldRoot | null;
  establish: () => WorldRoot;
}>;

export class WorldError extends Error {
  readonly kind: "invalid-world" | "home-world" | "root-world";

  constructor(kind: "invalid-world" | "home-world" | "root-world", message: string) {
    super(message);
    this.name = "WorldError";
    this.kind = kind;
  }
}

function homeRoot(): string {
  try { return realpathSync(resolve(homedir())); } catch { return resolve(homedir()); }
}

function directory(input: string, label: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new TypeError(`${label} must be a nonblank path`);
  }
  const path = resolve(input);
  let real: string;
  try { real = realpathSync(path); }
  catch (error) { throw new WorldError("invalid-world", `world path is not an existing directory: ${path}`); }
  try {
    if (!statSync(real).isDirectory()) throw new Error("not a directory");
  } catch { throw new WorldError("invalid-world", `world path is not a directory: ${real}`); }
  return real;
}

function brand(path: string): WorldRoot { return path as WorldRoot; }

function marker(root: string): string { return join(root, ".keiyaku"); }

function rejectReservedRoot(root: string): void {
  if (root === homeRoot()) {
    throw new WorldError("home-world", "the user home directory cannot be a Keiyaku world");
  }
  if (root === parse(root).root) {
    throw new WorldError("root-world", "the filesystem root cannot be a Keiyaku world");
  }
}

function ensureMarker(root: string): void {
  const path = marker(root);
  if (existsSync(path)) {
    try {
      if (!statSync(path).isDirectory()) throw new Error("not a directory");
    } catch { throw new WorldError("invalid-world", `world marker is not a directory: ${path}`); }
    return;
  }
  mkdirSync(path, { recursive: true });
}

type WorldInput = string | WorldResolutionInput;

function inputValues(input: WorldInput, label: string): Readonly<{ cwd: string; repositoryRoot?: string }> {
  if (typeof input === "string") return { cwd: directory(input, label) };
  if (input === null || typeof input !== "object") throw new TypeError(`${label} must be a path or resolution input`);
  const cwd = directory(input.cwd, `${label} cwd`);
  if (input.repositoryRoot === undefined) return { cwd };
  return { cwd, repositoryRoot: directory(input.repositoryRoot, `${label} repository root`) };
}

function locateMarker(input: string): WorldRoot | null {
  let candidate = input;
  const home = homeRoot();
  for (;;) {
    const filesystemRoot = parse(candidate).root;
    if (candidate !== home && candidate !== filesystemRoot && existsSync(marker(candidate))) {
      try {
        if (!statSync(marker(candidate)).isDirectory()) {
          throw new WorldError("invalid-world", `world marker is not a directory: ${marker(candidate)}`);
        }
      } catch (error) {
        if (error instanceof WorldError) throw error;
        throw new WorldError("invalid-world", `world marker is not a directory: ${marker(candidate)}`);
      }
      return brand(candidate);
    }
    const parent = dirname(candidate);
    if (parent === candidate || candidate === filesystemRoot) return null;
    candidate = parent;
  }
}

function exact(input: string): WorldRoot {
  const root = directory(input, "world");
  rejectReservedRoot(root);
  ensureMarker(root);
  return brand(root);
}

function resolved(input: WorldInput): WorldResolution {
  const values = inputValues(input, "world location");
  const root = values.repositoryRoot === undefined ? locateMarker(values.cwd) : brand(values.repositoryRoot);
  if (root !== null) rejectReservedRoot(root);
  return Object.freeze({
    root,
    establish(): WorldRoot {
      const established = root ?? brand(values.cwd);
      rejectReservedRoot(established);
      ensureMarker(established);
      return established;
    },
  });
}

export const World = Object.freeze({
  resolve(input: WorldInput): WorldResolution { return resolved(input); },
  locate(input: WorldInput): WorldRoot | null { return resolved(input).root; },
  at(input: string): WorldRoot { return exact(input); },
});
