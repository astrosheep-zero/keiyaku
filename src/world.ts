import { mkdir, realpath, stat } from "node:fs/promises";
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
  candidate: WorldRoot | null;
  establish: () => Promise<WorldRoot>;
}>;

export const KEIYAKU_SQUARE_FILE = "KEIYAKU.square";

export function keiyakuSquarePath(worldRoot: string): string {
  return join(worldRoot, ".square", KEIYAKU_SQUARE_FILE);
}

export class WorldError extends Error {
  readonly kind: "invalid-world" | "home-world" | "root-world";

  constructor(kind: "invalid-world" | "home-world" | "root-world", message: string) {
    super(message);
    this.name = "WorldError";
    this.kind = kind;
  }
}

async function homeRoot(): Promise<string> {
  try {
    return await realpath(resolve(homedir()));
  } catch {
    return resolve(homedir());
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
    throw new WorldError("invalid-world", `world path is not an existing directory: ${path}`);
  }
  try {
    if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new WorldError("invalid-world", `world path is not a directory: ${real}`);
  }
  return real;
}

function brand(path: string): WorldRoot {
  return path as string & { readonly [WORLD_BRAND]: true };
}

function marker(root: string): string {
  return join(root, ".keiyaku");
}

async function rejectReservedRoot(root: string): Promise<void> {
  if (root === (await homeRoot())) {
    throw new WorldError("home-world", "the user home directory cannot be a Keiyaku world");
  }
  if (root === parse(root).root) {
    throw new WorldError("root-world", "the filesystem root cannot be a Keiyaku world");
  }
}

async function ensureMarker(root: string): Promise<void> {
  const path = marker(root);
  try {
    if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new WorldError("invalid-world", `world marker is not a directory: ${path}`);
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
  const home = await homeRoot();
  for (;;) {
    const filesystemRoot = parse(candidate).root;
    if (candidate !== home && candidate !== filesystemRoot) {
      try {
        if (!(await stat(marker(candidate))).isDirectory()) {
          throw new WorldError("invalid-world", `world marker is not a directory: ${marker(candidate)}`);
        }
        return brand(candidate);
      } catch (error) {
        if (error instanceof WorldError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new WorldError("invalid-world", `world marker is not a directory: ${marker(candidate)}`);
        }
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate || candidate === filesystemRoot) return null;
    candidate = parent;
  }
}

async function exact(input: string): Promise<WorldRoot> {
  const root = await directory(input, "world");
  await rejectReservedRoot(root);
  await ensureMarker(root);
  return brand(root);
}

async function proved(input: string): Promise<WorldRoot> {
  const resolution = await resolved({ cwd: input, repositoryRoot: input });
  const root = resolution.root;
  if (root === null || input !== root) {
    throw new WorldError("invalid-world", "world path must be its canonical physical directory coordinate");
  }
  return root;
}

async function resolved(input: WorldInput): Promise<WorldResolution> {
  const values = await inputValues(input, "world location");
  const root = values.repositoryRoot === undefined ? await locateMarker(values.cwd) : brand(values.repositoryRoot);
  const selected = root ?? brand(values.cwd);
  let candidate: WorldRoot | null = selected;
  try {
    await rejectReservedRoot(selected);
  } catch (error) {
    if (root !== null || !(error instanceof WorldError)) throw error;
    candidate = null;
  }
  return Object.freeze({
    root,
    candidate,
    async establish(): Promise<WorldRoot> {
      const established = candidate ?? brand(values.cwd);
      await rejectReservedRoot(established);
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
