import { KeiyakuError } from "./errors.js";
import { z } from "zod";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type SettingsScope = "project" | "user";

export type SettingsScopeState = z.output<typeof settingsScopeStateSchema>;

export type SettingsEntry = z.output<typeof settingsEntrySchema>;
export type SettingsNamespaceFailure = z.output<typeof settingsNamespaceFailureSchema>;
export type SettingsNamespaceView = z.output<typeof settingsNamespaceViewSchema>;

export type Settings = z.output<typeof settingsSchema> & Readonly<{ namespace(name: string): SettingsNamespaceView }>;

export const settingsScopeStateSchema = z.union([
  z.strictObject({ kind: z.literal("absent"), path: z.string().exactOptional() }).readonly(),
  z.strictObject({ kind: z.literal("failed"), path: z.string(), diagnostic: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("read"), path: z.string() }).readonly(),
]);
type SettingsJsonValue = z.output<ReturnType<typeof z.json>>;

/** Zod's ordinary record parser discards __proto__; Settings names are opaque own keys. */
function keyedValues<Value extends z.ZodType>(valueSchema: Value) {
  const record = z.record(z.string(), valueSchema);
  const schema = z.custom<Record<string, z.output<Value>>>(
    (input) =>
      z.core.util.isPlainObject(input) &&
      Object.entries(input).every(([, value]) => valueSchema.safeParse(value).success),
  );
  schema._zod.processJSONSchema = (context, _json, params) => {
    z.core.processSchema(record, context, params);
    const seen = context.seen.get(schema);
    if (seen === undefined) throw new Error("Settings keyed schema was not registered for JSON Schema traversal");
    seen.ref = record;
  };
  return schema.readonly();
}

const settingsJsonValueSchema: z.ZodType<SettingsJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(settingsJsonValueSchema),
    keyedValues(settingsJsonValueSchema),
  ]),
);

export const settingsEntrySchema = z
  .strictObject({
    value: settingsJsonValueSchema,
    source: z.enum(["project", "user"]),
    shadows: z.literal(true).exactOptional(),
  })
  .readonly();
const settingsNamespaceFailureSchema = z
  .strictObject({ scope: z.enum(["project", "user"]), diagnostic: z.string().exactOptional() })
  .readonly();
export const settingsNamespaceViewSchema = z.union([
  z
    .strictObject({
      kind: z.literal("read"),
      entries: keyedValues(settingsEntrySchema).exactOptional(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("failed"),
      entries: keyedValues(settingsEntrySchema).exactOptional(),
      failures: z.array(settingsNamespaceFailureSchema).readonly(),
    })
    .readonly(),
]);
export const settingsSchema = z
  .strictObject({
    scopes: z.strictObject({ project: settingsScopeStateSchema, user: settingsScopeStateSchema }).readonly(),
    namespaces: keyedValues(settingsNamespaceViewSchema).exactOptional(),
  })
  .readonly();

export type SettingsInput = Readonly<{ cwd?: string; home?: string }>;

export class SettingsError extends KeiyakuError {
  readonly kind = "settings";
  constructor(message: string) {
    super("internal", message);
  }
}

type LoadedScope = Readonly<{
  state: SettingsScopeState;
  root?: Readonly<Record<string, SettingsEntry["value"]>>;
}>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function freezeJson<T>(value: T): T {
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
    const decoded: SettingsEntry["value"] = JSON.parse(bytes);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
      throw new TypeError("settings root must be an object");
    const root = freezeJson(decoded);
    return { state: { kind: "read", path }, root };
  } catch (error) {
    return { state: { kind: "failed", path, diagnostic: bounded(error) } };
  }
}

function namespaceEntries(
  name: string,
  scope: SettingsScope,
  loaded: LoadedScope,
): Readonly<{ entries: Readonly<Record<string, SettingsEntry>>; failure?: SettingsNamespaceFailure }> {
  if (loaded.state.kind === "failed") return { entries: {}, failure: { scope } };
  if (loaded.root === undefined || !Object.prototype.hasOwnProperty.call(loaded.root, name)) {
    return { entries: {} };
  }
  const value = loaded.root[name];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { entries: {}, failure: { scope, diagnostic: `${name} must be an object of named values` } };
  }
  return {
    entries: Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((entryName) => [
          entryName,
          Object.freeze({
            value: value[entryName]!,
            source: scope,
          }),
        ]),
    ),
  };
}

function settingsFromScopes(project: LoadedScope, user: LoadedScope): Settings {
  function resolveNamespace(name: string): SettingsNamespaceView {
    const fromUser = namespaceEntries(name, "user", user);
    const fromProject = namespaceEntries(name, "project", project);
    const names = [...new Set([...Object.keys(fromUser.entries), ...Object.keys(fromProject.entries)])].sort();
    const entries = Object.freeze(
      Object.fromEntries(
        names.map((entryName) => {
          const higher = Object.hasOwn(fromProject.entries, entryName) ? fromProject.entries[entryName] : undefined;
          const lower = Object.hasOwn(fromUser.entries, entryName) ? fromUser.entries[entryName] : undefined;
          return [
            entryName,
            higher === undefined
              ? lower!
              : Object.freeze({
                  ...higher,
                  ...(lower === undefined ? {} : { shadows: true as const }),
                }),
          ];
        }),
      ),
    );
    const failures = Object.freeze(
      [fromUser.failure, fromProject.failure].filter(
        (failure): failure is SettingsNamespaceFailure => failure !== undefined,
      ),
    );
    const resolved = Object.keys(entries).length === 0 ? {} : { entries };
    return failures.length === 0
      ? Object.freeze({ kind: "read" as const, ...resolved })
      : Object.freeze({ kind: "failed" as const, ...resolved, failures });
  }
  function namespace(name: string): SettingsNamespaceView {
    if (typeof name !== "string" || name.trim().length === 0)
      throw new TypeError("settings namespace must be nonblank");
    return resolveNamespace(name);
  }
  const names = [...new Set([user, project].flatMap((scope) => Object.keys(scope.root ?? {})))].sort();
  return Object.freeze({
    scopes: Object.freeze({ project: project.state, user: user.state }),
    ...(names.length === 0
      ? {}
      : { namespaces: Object.freeze(Object.fromEntries(names.map((name) => [name, resolveNamespace(name)]))) }),
    namespace,
  });
}

async function canonicalCoordinate(path: string): Promise<string> {
  const resolvedPath = resolve(path);
  try {
    return await realpath(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

async function loadSettings(input: SettingsInput = {}): Promise<Settings> {
  if (!object(input)) throw new TypeError("settings input must be an object");
  for (const key of Object.keys(input))
    if (key !== "cwd" && key !== "home") throw new TypeError(`settings input has unknown field: ${key}`);
  for (const field of ["cwd", "home"] as const) {
    const value = input[field];
    if (value !== undefined && (typeof value !== "string" || value.trim().length === 0))
      throw new TypeError(`settings ${field} must be a nonblank string`);
  }
  const projectDirectory = input.cwd === undefined ? undefined : await canonicalCoordinate(join(input.cwd, ".keiyaku"));
  const userDirectory = await canonicalCoordinate(input.home ?? join(homedir(), ".keiyaku"));
  const project =
    projectDirectory === undefined || projectDirectory === userDirectory
      ? { state: { kind: "absent" as const } }
      : await readScope(join(projectDirectory, "settings.json"));
  const user = await readScope(join(userDirectory, "settings.json"));
  return settingsFromScopes(project, user);
}

export const Settings = Object.freeze({ load: loadSettings });

/** Read only the project scope owned by a materialized candidate snapshot. */
export async function projectSettings(root: string): Promise<Settings> {
  if (typeof root !== "string" || root.trim().length === 0)
    throw new TypeError("settings root must be a nonblank string");
  return settingsFromScopes(await readScope(join(resolve(root), ".keiyaku", "settings.json")), {
    state: { kind: "absent" },
  });
}
