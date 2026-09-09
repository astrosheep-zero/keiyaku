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
const PLUGIN_ATTEMPT_TIMEOUT_MS = 5_000;
const PLUGIN_NAMESPACE = "plugins";
const SQUARE_PLUGIN_PACKAGE = "@astrosheep/keiyaku-plugin-square";
const BUILTIN_PLUGINS: readonly SelectedPlugin[] = Object.freeze([
  Object.freeze({ id: "square", package: SQUARE_PLUGIN_PACKAGE, config: undefined }),
]);
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

type Attempt<T> =
  | Readonly<{ kind: "settled"; value: T }>
  | Readonly<{ kind: "failed"; error: unknown }>
  | Readonly<{ kind: "timed-out" }>;

type Activation = Readonly<{
  handlers: readonly RegisteredHandler[];
  timedOut: boolean;
}>;

type ActivationInput = Readonly<{
  selected: SelectedPlugin;
  world: WorldRoot;
  activated: Set<string>;
  report: PluginDiagnostic | undefined;
  cancellation: AbortSignal;
  onStarted: () => void;
}>;

const ABORTED = Symbol("plugin attempt aborted");

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

function timeoutError(): Error {
  return new Error(`timed out after ${PLUGIN_ATTEMPT_TIMEOUT_MS}ms`);
}

async function boundedAttempt<T>(
  attempt: (cancellation: AbortSignal) => Promise<T> | T,
  timeoutMs = PLUGIN_ATTEMPT_TIMEOUT_MS,
): Promise<Attempt<T>> {
  if (timeoutMs <= 0) return { kind: "timed-out" };
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const completed = Promise.resolve()
    .then(() => attempt(controller.signal))
    .then(
      (value): Attempt<T> => ({ kind: "settled", value }),
      (error: unknown): Attempt<T> => ({ kind: "failed", error }),
    );
  const expired = new Promise<Attempt<T>>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError());
      resolve({ kind: "timed-out" });
    }, timeoutMs);
  });
  const result = await Promise.race([completed, expired]);
  if (timeout !== undefined) clearTimeout(timeout);
  return result;
}

async function settleBefore<T>(promise: Promise<T>, cancellation: AbortSignal): Promise<T | typeof ABORTED> {
  if (cancellation.aborted) return ABORTED;
  let releaseAbort!: () => void;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    releaseAbort = () => resolve(ABORTED);
    cancellation.addEventListener("abort", releaseAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    cancellation.removeEventListener("abort", releaseAbort);
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
    return BUILTIN_PLUGINS;
  }
  if (view.entries.length === 0) return BUILTIN_PLUGINS;
  const configured = new Map(
    view.entries
      .map((entry) => [entry.name, selectedEntry(entry, report)] as const)
      .filter((entry): entry is readonly [string, SelectedPlugin] => entry[1] !== null),
  );
  const disabled = new Set(
    view.entries.filter((entry) => object(entry.value) && entry.value.enabled === false).map((entry) => entry.name),
  );
  const selected = [
    ...BUILTIN_PLUGINS.filter((entry) => !configured.has(entry.id) && !disabled.has(entry.id)),
    ...configured.values(),
  ]
    .filter((entry): entry is SelectedPlugin => entry !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze(selected);
}

function manifest(value: unknown): KeiyakuPlugin {
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
  return value as KeiyakuPlugin;
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
    if (kind !== "akuma.called" && kind !== "akuma.turn-outcome" && kind !== "akuma.body-ended") {
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
  if (packageName === SQUARE_PLUGIN_PACKAGE) return (await import(packageName)) as Record<string, unknown>;
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

async function activate(input: ActivationInput): Promise<readonly RegisteredHandler[]> {
  const { selected, world, activated, report, cancellation, onStarted } = input;
  let started = false;
  const markStarted = () => {
    if (started) return;
    started = true;
    onStarted();
  };
  let module: Record<string, unknown>;
  try {
    module = await importFromWorld(world, selected.package);
  } catch (error) {
    markStarted();
    diagnostic(report, selected.id, "import", error);
    return [];
  }
  if (cancellation.aborted) {
    markStarted();
    return [];
  }

  let candidate: KeiyakuPlugin;
  try {
    candidate = manifest(module.default);
    if (candidate.manifest.id !== selected.id) {
      throw new TypeError(`plugin manifest id does not match selected entry: ${candidate.manifest.id}`);
    }
    if (activated.has(candidate.manifest.id)) throw new TypeError(`plugin id is duplicated: ${candidate.manifest.id}`);
  } catch (error) {
    markStarted();
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
    markStarted();
    diagnostic(report, selected.id, "validation", error);
    return [];
  }
  if (cancellation.aborted) {
    markStarted();
    return [];
  }

  markStarted();
  try {
    const instance = await candidate.activate(context, cancellation);
    if (cancellation.aborted) return [];
    const registered = handlers(candidate.manifest.id, instance);
    activated.add(candidate.manifest.id);
    return registered;
  } catch (error) {
    diagnostic(report, selected.id, "activation", error);
    return [];
  }
}

async function deliver(
  entry: RegisteredHandler,
  signal: PluginSignal,
  reportDiagnostic: PluginDiagnostic | undefined,
  timeoutMs: number,
): Promise<void> {
  const result = await boundedAttempt((cancellation) => entry.handler(signal as never, cancellation), timeoutMs);
  if (result.kind === "timed-out") diagnostic(reportDiagnostic, entry.pluginId, "signal", timeoutError());
  if (result.kind === "failed") diagnostic(reportDiagnostic, entry.pluginId, "signal", result.error);
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
  let previousStarted = Promise.resolve();
  const activations = selected.map((entry) => {
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const activation = previousStarted.then(async () => {
      const result = await boundedAttempt((cancellation) =>
        activate({ selected: entry, world: input.world, activated, report, cancellation, onStarted: releaseStarted }),
      );
      releaseStarted();
      if (result.kind === "settled") return { handlers: result.value, timedOut: false } satisfies Activation;
      diagnostic(report, entry.id, "activation", result.kind === "failed" ? result.error : timeoutError());
      return { handlers: [], timedOut: result.kind === "timed-out" } satisfies Activation;
    });
    previousStarted = started;
    return activation;
  });

  return Object.freeze({
    async emit(signal: PluginSignal, reportDiagnostic: PluginDiagnostic | undefined = report): Promise<void> {
      const deadline = performance.now() + PLUGIN_ATTEMPT_TIMEOUT_MS;
      const activated = await boundedAttempt(async (cancellation) => {
        const handlers = await Promise.all(
          activations.map(async (activation, index) => {
            const activatedHandlers = await settleBefore(activation, cancellation);
            if (activatedHandlers !== ABORTED) {
              if (activatedHandlers.timedOut)
                diagnostic(reportDiagnostic, selected[index]!.id, "signal", timeoutError());
              return activatedHandlers.handlers;
            }
            diagnostic(reportDiagnostic, selected[index]!.id, "signal", timeoutError());
            return [];
          }),
        );
        return handlers.flat();
      });
      if (activated.kind === "failed") {
        diagnostic(reportDiagnostic, "runtime", "signal", activated.error);
        return;
      }
      if (activated.kind === "timed-out") return;
      await Promise.all(
        activated.value
          .filter((entry) => entry.kind === signal.kind)
          .map((entry) => deliver(entry, signal, reportDiagnostic, Math.max(0, deadline - performance.now()))),
      );
    },
  });
}
