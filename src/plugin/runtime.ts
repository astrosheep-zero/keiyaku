import { lstat, mkdir, realpath } from "node:fs/promises";
import { registerHooks } from "node:module";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { settings, type Settings, type SettingsEntry } from "../settings.js";
import type { WorldRoot } from "../world.js";
import type {
  KeiyakuPlugin,
  PluginContext,
  PluginHooks,
  PluginInstance,
  PluginManifest,
  PluginSignal,
  PluginSignalMap,
} from "./public.js";

const DIAGNOSTIC_LIMIT = 500;
const PLUGIN_NAMESPACE = "plugins";
const PROCESS_RUNTIMES = new Map<WorldRoot, Promise<PluginRuntime>>();

type PluginDiagnostic = (diagnostic: string) => void;

type PluginRuntimeInput = Readonly<{
  world: WorldRoot;
  settings?: Settings;
  reportDiagnostic?: PluginDiagnostic;
}>;

type RegisteredHandler = Readonly<{
  pluginId: string;
  kind: keyof PluginSignalMap;
  handler: NonNullable<PluginHooks[keyof PluginSignalMap]>;
}>;

export type PluginRuntime = Readonly<{
  emit(signal: PluginSignal, reportDiagnostic?: PluginDiagnostic): Promise<void>;
}>;

type SelectedPlugin = Readonly<{
  id: string;
  package: string;
  config: unknown;
}>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, DIAGNOSTIC_LIMIT);
}

function diagnostic(report: PluginDiagnostic | undefined, subject: string, stage: string, error: unknown): void {
  if (report === undefined) return;
  try {
    report(`plugin ${subject} ${stage}: ${message(error)}`.slice(0, DIAGNOSTIC_LIMIT));
  } catch {
    // Diagnostics are optional side effects too.
  }
}

function selectedEntry(entry: SettingsEntry, report: PluginDiagnostic | undefined): SelectedPlugin | null {
  if (entry.name.trim().length === 0) {
    diagnostic(report, "<unnamed>", "selection", new TypeError("plugin setting name must be nonblank"));
    return null;
  }
  if (!object(entry.value)) {
    diagnostic(report, entry.name, "selection", new TypeError("plugin setting must be an object"));
    return null;
  }
  const names = Object.keys(entry.value);
  if (!names.includes("package") || names.some((name) => !["package", "enabled", "config"].includes(name))) {
    diagnostic(report, entry.name, "selection", new TypeError("plugin setting has unknown or missing fields"));
    return null;
  }
  const packageName = entry.value.package;
  if (typeof packageName !== "string" || packageName.trim().length === 0) {
    diagnostic(report, entry.name, "selection", new TypeError("plugin package must be a nonblank string"));
    return null;
  }
  if (packageName !== packageName.trim()) {
    diagnostic(report, entry.name, "selection", new TypeError("plugin package must not have surrounding whitespace"));
    return null;
  }
  const enabled = entry.value.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    diagnostic(report, entry.name, "selection", new TypeError("plugin enabled must be a boolean"));
    return null;
  }
  if (enabled === false) return null;
  return Object.freeze({ id: entry.name, package: packageName, config: entry.value.config });
}

function selectedPlugins(input: Settings, report: PluginDiagnostic | undefined): readonly SelectedPlugin[] {
  const view = input.namespace(PLUGIN_NAMESPACE);
  if (view.kind === "failed") {
    for (const failure of view.failures) diagnostic(report, "settings", failure.scope, failure.diagnostic);
    return [];
  }
  return Object.freeze(
    view.entries
      .map((entry) => selectedEntry(entry, report))
      .filter((entry): entry is SelectedPlugin => entry !== null)
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

function manifest(value: unknown): PluginManifest {
  if (!object(value)) throw new TypeError("plugin default export must be an object");
  if (!object(value.manifest)) throw new TypeError("plugin manifest must be an object");
  const candidate = value.manifest;
  const names = Object.keys(candidate);
  if (names.some((name) => !["id", "apiVersion", "writablePaths"].includes(name))) {
    throw new TypeError("plugin manifest has unknown fields");
  }
  if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
    throw new TypeError("plugin manifest id must be nonblank");
  }
  if (candidate.apiVersion !== 1) throw new TypeError("plugin apiVersion must equal 1");
  if (candidate.writablePaths !== undefined && !Array.isArray(candidate.writablePaths)) {
    throw new TypeError("plugin writablePaths must be an array");
  }
  if (typeof value.activate !== "function") throw new TypeError("plugin activate must be a function");
  return value as KeiyakuPlugin as unknown as PluginManifest;
}

function plugin(value: unknown): KeiyakuPlugin {
  const validated = manifest(value);
  return value as KeiyakuPlugin & Readonly<{ manifest: typeof validated }>;
}

function writablePathDeclaration(
  value: unknown,
  names: Set<string>,
): Readonly<{ name: string; parts: readonly string[] }> {
  if (!object(value)) throw new TypeError("plugin writable path must be an object");
  if (Object.keys(value).some((name) => name !== "name" && name !== "path")) {
    throw new TypeError("plugin writable path has unknown fields");
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new TypeError("plugin writable path name must be nonblank");
  }
  if (names.has(value.name)) throw new TypeError(`plugin writable path name is duplicated: ${value.name}`);
  if (typeof value.path !== "string" || value.path.length === 0 || value.path.includes("\\")) {
    throw new TypeError("plugin writable path must be a nonblank POSIX path");
  }
  if (posix.isAbsolute(value.path)) throw new TypeError("plugin writable path must be relative to the World");
  const parts = value.path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === ".." || part.toLowerCase() === ".keiyaku")) {
    throw new TypeError("plugin writable path contains a reserved or traversal component");
  }
  names.add(value.name);
  return Object.freeze({ name: value.name, parts: Object.freeze(parts) });
}

async function createTrustedPath(
  world: WorldRoot,
  managementPath: string,
  declaration: Readonly<{ parts: readonly string[] }>,
): Promise<string> {
  let current = world as string;
  for (const part of declaration.parts) {
    current = join(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new TypeError(`plugin writable path resolves through a symlink: ${current}`);
    if (!entry.isDirectory()) throw new TypeError(`plugin writable path component is not a directory: ${current}`);
    const resolved = await realpath(current);
    const relation = relative(managementPath, resolved);
    if (relation.length === 0 || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))) {
      throw new TypeError(`plugin writable path resolves into Keiyaku management custody: ${current}`);
    }
  }
  return current;
}

async function writablePaths(
  world: WorldRoot,
  declarations: PluginManifest["writablePaths"],
): Promise<ReadonlyMap<string, string>> {
  const names = new Set<string>();
  const paths = new Map<string, string>();
  const managementPath = await realpath(join(world, ".keiyaku"));
  for (const value of declarations ?? []) {
    const declaration = writablePathDeclaration(value, names);
    paths.set(declaration.name, await createTrustedPath(world, managementPath, declaration));
  }
  return paths;
}

function handlers(pluginId: string, instance: PluginInstance): readonly RegisteredHandler[] {
  if (!object(instance)) throw new TypeError("plugin activation must return an object");
  if (Object.keys(instance).some((name) => name !== "signals"))
    throw new TypeError("plugin instance has unknown fields");
  if (instance.signals === undefined) return [];
  if (!object(instance.signals)) throw new TypeError("plugin signals must be an object");
  const registered: RegisteredHandler[] = [];
  for (const [kind, handler] of Object.entries(instance.signals)) {
    if (kind !== "akuma.called" && kind !== "akuma.turn-outcome") {
      throw new TypeError(`plugin signal is unknown: ${kind}`);
    }
    if (typeof handler !== "function") throw new TypeError(`plugin signal handler is not a function: ${kind}`);
    registered.push({ pluginId, kind, handler });
  }
  return Object.freeze(registered);
}

function sourceUrl(world: WorldRoot, packageName: string): string | null {
  if (packageName.startsWith("./")) {
    const parts = packageName.slice(2).split("/");
    if (parts.some((part) => part.length === 0 || part === "." || part === ".." || part.includes("\\"))) {
      throw new TypeError("plugin source must be a World-relative POSIX path");
    }
    return new URL(packageName, pathToFileURL(`${world as string}/`)).href;
  }
  if (packageName.startsWith("/") || packageName.startsWith("file:") || packageName.startsWith("../")) {
    throw new TypeError("plugin source must be a package or World-relative path");
  }
  return null;
}

async function importFromWorld(world: WorldRoot, packageName: string): Promise<Record<string, unknown>> {
  const direct = sourceUrl(world, packageName);
  if (direct !== null) return (await import(direct)) as Record<string, unknown>;
  const parentURL = pathToFileURL(join(world, "package.json")).href;
  const request = `keiyaku-plugin:${encodeURIComponent(world)}:${encodeURIComponent(packageName)}`;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === request
        ? nextResolve(packageName, { ...context, parentURL })
        : nextResolve(specifier, context);
    },
  });
  try {
    return (await import(request)) as Record<string, unknown>;
  } finally {
    hooks.deregister();
  }
}

async function activate(
  selected: SelectedPlugin,
  world: WorldRoot,
  activated: Set<string>,
  report: PluginDiagnostic | undefined,
): Promise<readonly RegisteredHandler[]> {
  let module: Record<string, unknown>;
  try {
    module = await importFromWorld(world, selected.package);
  } catch (error) {
    diagnostic(report, selected.id, "import", error);
    return [];
  }

  let candidate: KeiyakuPlugin;
  try {
    candidate = plugin(module.default);
    if (candidate.manifest.id !== selected.id) {
      throw new TypeError(`plugin manifest id does not match selected entry: ${candidate.manifest.id}`);
    }
    if (activated.has(candidate.manifest.id)) throw new TypeError(`plugin id is duplicated: ${candidate.manifest.id}`);
  } catch (error) {
    diagnostic(report, selected.id, "validation", error);
    return [];
  }

  let context: PluginContext;
  try {
    const declared = await writablePaths(world, candidate.manifest.writablePaths);
    context = Object.freeze({
      world,
      config: selected.config,
      writablePath(name: string): string {
        const path = declared.get(name);
        if (path === undefined) throw new TypeError(`plugin writable path is undeclared: ${name}`);
        return path;
      },
    });
  } catch (error) {
    diagnostic(report, selected.id, "validation", error);
    return [];
  }

  try {
    const instance = await candidate.activate(context);
    const registered = handlers(candidate.manifest.id, instance);
    activated.add(candidate.manifest.id);
    return registered;
  } catch (error) {
    diagnostic(report, selected.id, "activation", error);
    return [];
  }
}

export async function pluginRuntime(input: PluginRuntimeInput): Promise<PluginRuntime> {
  let runtime = PROCESS_RUNTIMES.get(input.world);
  if (runtime === undefined) {
    runtime = createPluginRuntime(input);
    PROCESS_RUNTIMES.set(input.world, runtime);
  }
  return await runtime;
}

async function createPluginRuntime(input: PluginRuntimeInput): Promise<PluginRuntime> {
  const report = input.reportDiagnostic;
  const selected = selectedPlugins(input.settings ?? (await settings({ root: input.world })), report);
  const activated = new Set<string>();
  const registered: RegisteredHandler[] = [];
  for (const entry of selected) registered.push(...(await activate(entry, input.world, activated, report)));

  return Object.freeze({
    async emit(signal: PluginSignal, reportDiagnostic: PluginDiagnostic | undefined = report): Promise<void> {
      const deliveries = registered
        .filter((handler) => handler.kind === signal.kind)
        .map((entry) =>
          Object.freeze({ entry, delivery: Promise.resolve().then(() => entry.handler(signal as never)) }),
        );
      const outcomes = await Promise.allSettled(deliveries.map(({ delivery }) => delivery));
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.status === "rejected")
          diagnostic(reportDiagnostic, deliveries[index]!.entry.pluginId, "signal", outcome.reason);
      }
    },
  });
}
