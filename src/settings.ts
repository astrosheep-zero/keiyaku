import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { gateWord } from "./core/facts/types.js";

export type SettingsScope = "project" | "user";

export type SettingsScopeState =
  | Readonly<{ kind: "absent"; path?: string }>
  | Readonly<{ kind: "failed"; path: string; diagnostic: string }>
  | Readonly<{ kind: "read"; path: string; namespaces: readonly string[] }>;

export type SettingsEntry = Readonly<{
  name: string;
  value: unknown;
  source: SettingsScope;
  shadows: boolean;
}>;

export type SettingsNamespaceFailure = Readonly<{
  scope: SettingsScope;
  diagnostic: string;
}>;

export type SettingsNamespaceView =
  | Readonly<{ kind: "read"; name: string; entries: readonly SettingsEntry[] }>
  | Readonly<{
      kind: "failed";
      name: string;
      entries: readonly SettingsEntry[];
      failures: readonly SettingsNamespaceFailure[];
    }>;

export type Settings = Readonly<{
  scopes: Readonly<{ project: SettingsScopeState; user: SettingsScopeState }>;
  namespace(name: string): SettingsNamespaceView;
}>;

export type SettingsInput = Readonly<{ root?: string; home?: string }>;

export class SettingsError extends Error {
  readonly kind = "settings";
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

export type Gate = string;
export type GatesFromInput = Readonly<{ settings: Settings; names?: readonly string[] }>;
export type RequireBranchesToBeUpToDateFromInput = Readonly<{ settings: Settings }>;

type LoadedScope = Readonly<{
  state: SettingsScopeState;
  root?: Readonly<Record<string, unknown>>;
}>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
    return Object.freeze(value);
  }
  if (object(value)) {
    for (const item of Object.values(value)) freezeJson(item);
    return Object.freeze(value);
  }
  return value;
}

function bounded(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function readScope(path: string): Promise<LoadedScope> {
  let bytes: string;
  try {
    bytes = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: { kind: "absent", path } };
    return { state: { kind: "failed", path, diagnostic: bounded(error) } };
  }
  try {
    const decoded = JSON.parse(bytes) as unknown;
    if (!object(decoded)) throw new TypeError("settings root must be an object");
    const root = freezeJson(decoded) as Readonly<Record<string, unknown>>;
    return { state: { kind: "read", path, namespaces: Object.freeze(Object.keys(root).sort()) }, root };
  } catch (error) {
    return { state: { kind: "failed", path, diagnostic: bounded(error) } };
  }
}

function namespaceEntries(
  name: string,
  scope: SettingsScope,
  loaded: LoadedScope,
): Readonly<{ entries: readonly SettingsEntry[]; failure?: SettingsNamespaceFailure }> {
  if (loaded.state.kind === "failed") {
    return { entries: [], failure: { scope, diagnostic: loaded.state.diagnostic } };
  }
  if (loaded.root === undefined || !Object.prototype.hasOwnProperty.call(loaded.root, name)) {
    return { entries: [] };
  }
  const value = loaded.root[name];
  if (!object(value)) {
    return { entries: [], failure: { scope, diagnostic: `${name} must be an object of named values` } };
  }
  return {
    entries: Object.keys(value)
      .sort()
      .map((entryName) => ({
        name: entryName,
        value: value[entryName],
        source: scope,
        shadows: false,
      })),
  };
}

function settingsFromScopes(project: LoadedScope, user: LoadedScope): Settings {
  return Object.freeze({
    scopes: Object.freeze({ project: project.state, user: user.state }),
    namespace(name: string): SettingsNamespaceView {
      if (typeof name !== "string" || name.trim().length === 0)
        throw new TypeError("settings namespace must be nonblank");
      const fromUser = namespaceEntries(name, "user", user);
      const fromProject = namespaceEntries(name, "project", project);
      const userByName = new Map(fromUser.entries.map((entry) => [entry.name, entry]));
      const projectByName = new Map(fromProject.entries.map((entry) => [entry.name, entry]));
      const names = [...new Set([...userByName.keys(), ...projectByName.keys()])].sort();
      const entries = Object.freeze(
        names.map((entryName) => {
          const higher = projectByName.get(entryName);
          if (higher !== undefined) return Object.freeze({ ...higher, shadows: userByName.has(entryName) });
          return userByName.get(entryName)!;
        }),
      );
      const failures = Object.freeze(
        [fromUser.failure, fromProject.failure].filter(
          (failure): failure is SettingsNamespaceFailure => failure !== undefined,
        ),
      );
      return failures.length === 0
        ? Object.freeze({ kind: "read" as const, name, entries })
        : Object.freeze({ kind: "failed" as const, name, entries, failures });
    },
  });
}

export async function settings(input: SettingsInput = {}): Promise<Settings> {
  if (!object(input)) throw new TypeError("settings input must be an object");
  if (input.root !== undefined && (typeof input.root !== "string" || input.root.trim().length === 0)) {
    throw new TypeError("settings root must be a nonblank string");
  }
  if (input.home !== undefined && (typeof input.home !== "string" || input.home.trim().length === 0)) {
    throw new TypeError("settings home must be a nonblank string");
  }
  const project =
    input.root === undefined
      ? { state: { kind: "absent" as const } }
      : await readScope(join(resolve(input.root), ".keiyaku", "settings.json"));
  const user = await readScope(join(resolve(input.home ?? join(homedir(), ".keiyaku")), "settings.json"));
  return settingsFromScopes(project, user);
}

/** Read only the project scope owned by a materialized candidate snapshot. */
export async function projectSettings(root: string): Promise<Settings> {
  if (typeof root !== "string" || root.trim().length === 0)
    throw new TypeError("settings root must be a nonblank string");
  return settingsFromScopes(await readScope(join(resolve(root), ".keiyaku", "settings.json")), {
    state: { kind: "absent" },
  });
}

function namespaceFailure(view: ReturnType<Settings["namespace"]>): never {
  if (view.kind !== "failed") throw new Error("settings namespace failure expected");
  throw new SettingsError(view.failures.map((failure) => `${failure.scope}: ${failure.diagnostic}`).join("; "));
}

function bundleGates(name: string, value: unknown): readonly Gate[] {
  if (!object(value)) throw new SettingsError(`gate bundle '${name}' must be an object`);
  if (value.kind !== "bundle") {
    throw new SettingsError(`gate bundle '${name}' has unsupported kind: ${String(value.kind)}`);
  }
  for (const field of Object.keys(value)) {
    if (field !== "kind" && field !== "gates") {
      throw new SettingsError(`gate bundle '${name}' has unknown field: ${field}`);
    }
  }
  if (!Array.isArray(value.gates)) {
    throw new SettingsError(`gate bundle '${name}'.gates must be an array`);
  }
  return value.gates.map((gate) => {
    if (!gateWord(gate)) {
      throw new SettingsError(`gate bundle '${name}' contains an invalid gate word`);
    }
    if (gate !== "reviewed" && gate !== "verified") {
      throw new SettingsError(`gate bundle '${name}' contains a gate without a producer: ${gate}`);
    }
    return gate;
  });
}

export function gatesFrom(input: GatesFromInput): readonly Gate[] {
  if (!object(input)) throw new TypeError("gatesFrom input must be an object");
  if (input.names !== undefined && !Array.isArray(input.names)) {
    throw new TypeError("gatesFrom names must be an array");
  }
  const names = input.names ?? ["default"];
  for (const name of names) {
    if (!gateWord(name)) throw new SettingsError("gate bundle name must match ^[a-z][a-z0-9-]{0,63}$");
  }
  const view = input.settings.namespace("gates");
  if (view.kind === "failed") namespaceFailure(view);
  const expanded: Gate[] = [];
  const seen = new Set<Gate>();
  for (const name of names) {
    const selected = view.entries.find((entry) => entry.name === name);
    if (selected === undefined) {
      if (input.names === undefined) {
        if (!seen.has("reviewed")) expanded.push("reviewed");
        seen.add("reviewed");
        continue;
      }
      throw new SettingsError(`unknown gate bundle: ${name}`);
    }
    for (const gate of bundleGates(name, selected.value)) {
      if (seen.has(gate)) continue;
      seen.add(gate);
      expanded.push(gate);
    }
  }
  return Object.freeze(expanded);
}

export function requireBranchesToBeUpToDateFrom(input: RequireBranchesToBeUpToDateFromInput): boolean {
  if (!object(input)) throw new TypeError("requireBranchesToBeUpToDateFrom input must be an object");
  const view = input.settings.namespace("git");
  if (view.kind === "failed") namespaceFailure(view);
  for (const entry of view.entries) {
    if (entry.name !== "requireBranchesToBeUpToDate") {
      throw new SettingsError(`git has unknown entry: ${entry.name}`);
    }
  }
  const selected = view.entries.find((entry) => entry.name === "requireBranchesToBeUpToDate");
  if (selected === undefined) return false;
  if (typeof selected.value !== "boolean") {
    throw new SettingsError("git.requireBranchesToBeUpToDate must be a boolean");
  }
  return selected.value;
}
