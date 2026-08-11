import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

const WORLD_BRAND: unique symbol = Symbol("keiyaku.world");

export type WorldRoot = string & { readonly [WORLD_BRAND]: true };

export class WorldError extends Error {
  readonly kind: "invalid-world" | "home-world";

  constructor(kind: "invalid-world" | "home-world", message: string) {
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

function rejectHome(root: string): void {
  if (root === homeRoot()) {
    throw new WorldError("home-world", "the user home directory cannot be a Keiyaku world");
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

function exact(input: string): WorldRoot {
  const root = directory(input, "world");
  rejectHome(root);
  ensureMarker(root);
  return brand(root);
}

function locateInput(input: string): string {
  return directory(input, "world location");
}

export const World = Object.freeze({
  locate(input: string): WorldRoot | null {
    let candidate = locateInput(input);
    const home = homeRoot();
    for (;;) {
      if (candidate !== home && existsSync(marker(candidate))) {
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
      if (parent === candidate || candidate === parse(candidate).root) return null;
      candidate = parent;
    }
  },
  at(input: string): WorldRoot {
    return exact(input);
  },
});
