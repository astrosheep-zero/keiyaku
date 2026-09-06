import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

const WORLD_BRAND: unique symbol = Symbol("keiyaku.world");

export type WorldRoot = string & { readonly [WORLD_BRAND]: true };
export type WorldResolutionInput = Readonly<{
  cwd: string;
  repositoryRoot?: string;
}>;
export type WorldResolution = Readonly<{
  root: WorldRoot | null;
  candidate: WorldRoot | null;
  establish: () => Promise<WorldRoot>;
}>;

export class WorldError extends Error {
  readonly kind = "invalid-world" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorldError";
    this.kind = "invalid-world";
  }
}

async function directory(input: string, label: string): Promise<string> {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new TypeError(`${label} must be a nonblank path`);
  }
  const path = resolve(input);
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    throw new WorldError(`world path is not an existing directory: ${path}`);
  }
  try {
    if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new WorldError(`world path is not a directory: ${real}`);
  }
  return real;
}

function brand(path: string): WorldRoot {
  return path as string & { readonly [WORLD_BRAND]: true };
}

function marker(root: string): string {
  return join(root, ".keiyaku");
}

async function ensureMarker(root: string): Promise<void> {
  const path = marker(root);
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error("not a directory");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new WorldError(`world marker is not a directory: ${path}`);
    }
  }
  await mkdir(path, { recursive: true });
}

type WorldInput = string | WorldResolutionInput;

async function inputValues(
  input: WorldInput,
  label: string,
): Promise<Readonly<{ cwd: string; repositoryRoot?: string }>> {
  if (typeof input === "string") return { cwd: await directory(input, label) };
  if (input === null || typeof input !== "object") throw new TypeError(`${label} must be a path or resolution input`);
  const cwd = await directory(input.cwd, `${label} cwd`);
  if (input.repositoryRoot === undefined) return { cwd };
  return { cwd, repositoryRoot: await directory(input.repositoryRoot, `${label} repository root`) };
}

async function locateMarker(input: string): Promise<WorldRoot | null> {
  let candidate = input;
  for (;;) {
    const filesystemRoot = parse(candidate).root;
    try {
      if (!(await lstat(marker(candidate))).isDirectory()) {
        throw new WorldError(`world marker is not a directory: ${marker(candidate)}`);
      }
      return brand(candidate);
    } catch (error) {
      if (error instanceof WorldError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new WorldError(`world marker is not a directory: ${marker(candidate)}`);
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate || candidate === filesystemRoot) return null;
    candidate = parent;
  }
}

async function exact(input: string): Promise<WorldRoot> {
  const root = await directory(input, "world");
  await ensureMarker(root);
  return brand(root);
}

async function proved(input: string): Promise<WorldRoot> {
  const resolution = await resolved({ cwd: input, repositoryRoot: input });
  const root = resolution.root;
  if (root === null || input !== root) {
    throw new WorldError("world path must be its canonical physical directory coordinate");
  }
  return root;
}

async function resolved(input: WorldInput): Promise<WorldResolution> {
  const values = await inputValues(input, "world location");
  const root = values.repositoryRoot === undefined ? await locateMarker(values.cwd) : brand(values.repositoryRoot);
  const selected = root ?? brand(values.cwd);
  return Object.freeze({
    root,
    candidate: selected,
    establish: async (): Promise<WorldRoot> => {
      const established = selected;
      await ensureMarker(established);
      return established;
    },
  });
}

export const World = Object.freeze({
  resolve(input: WorldInput): Promise<WorldResolution> {
    return resolved(input);
  },
  async locate(input: WorldInput): Promise<WorldRoot | null> {
    return (await resolved(input)).root;
  },
  at(input: string): Promise<WorldRoot> {
    return exact(input);
  },
  prove(input: string): Promise<WorldRoot> {
    return proved(input);
  },
});
