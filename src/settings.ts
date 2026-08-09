import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

function readScope(path: string): LoadedScope {
  let bytes: string;
  try { bytes = readFileSync(path, "utf8"); }
  catch (error) {
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
  const value = loaded.root?.[name];
  if (value === undefined) return { entries: [] };
  if (!object(value)) {
    return { entries: [], failure: { scope, diagnostic: `${name} must be an object of named values` } };
  }
  return {
    entries: Object.keys(value).sort().map((entryName) => ({
      name: entryName,
      value: value[entryName],
      source: scope,
      shadows: false,
    })),
  };
}

export function settings(input: SettingsInput = {}): Settings {
  if (!object(input)) throw new TypeError("settings input must be an object");
  if (input.root !== undefined && (typeof input.root !== "string" || input.root.trim().length === 0)) {
    throw new TypeError("settings root must be a nonblank string");
  }
  if (input.home !== undefined && (typeof input.home !== "string" || input.home.trim().length === 0)) {
    throw new TypeError("settings home must be a nonblank string");
  }
  const home = resolve(input.home ?? join(homedir(), ".keiyaku"));
  const user = readScope(join(home, "settings.json"));
  const project = input.root === undefined
    ? { state: { kind: "absent" as const } }
    : readScope(join(resolve(input.root), ".keiyaku", "settings.json"));

  return Object.freeze({
    scopes: Object.freeze({ project: project.state, user: user.state }),
    namespace(name: string): SettingsNamespaceView {
      if (typeof name !== "string" || name.trim().length === 0) throw new TypeError("settings namespace must be nonblank");
      const fromUser = namespaceEntries(name, "user", user);
      const fromProject = namespaceEntries(name, "project", project);
      const userByName = new Map(fromUser.entries.map((entry) => [entry.name, entry]));
      const projectByName = new Map(fromProject.entries.map((entry) => [entry.name, entry]));
      const names = [...new Set([...userByName.keys(), ...projectByName.keys()])].sort();
      const entries = Object.freeze(names.map((entryName) => {
        const higher = projectByName.get(entryName);
        if (higher !== undefined) return Object.freeze({ ...higher, shadows: userByName.has(entryName) });
        return userByName.get(entryName)!;
      }));
      const failures = Object.freeze([fromUser.failure, fromProject.failure].filter(
        (failure): failure is SettingsNamespaceFailure => failure !== undefined,
      ));
      return failures.length === 0
        ? Object.freeze({ kind: "read" as const, name, entries })
        : Object.freeze({ kind: "failed" as const, name, entries, failures });
    },
  });
}
