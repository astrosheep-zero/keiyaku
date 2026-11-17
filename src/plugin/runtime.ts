import { lstat, mkdir, realpath } from "node:fs/promises";
import { registerHooks } from "node:module";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Settings, type SettingsEntry } from "../settings.js";
import type { WorldRoot } from "../world.js";
import type {
  KeiyakuPlugin,
  PluginContext,
  PluginHooks,
  PluginInstance,
  PluginSignal,
  PluginSignalMap,
  PluginWaitDeferral,
  PluginWaitDeferralInput,
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

export type PluginRuntime = Readonly<{
  emit(signal: PluginSignal, reportDiagnostic?: PluginDiagnostic): Promise<void>;
  withWaitDeferrals<T>(
    input: PluginWaitDeferralInput,
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
    reportDiagnostic?: PluginDiagnostic,
  ): Promise<T>;
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
  pluginId: string;
  instance: z.infer<typeof instanceSchema> | undefined;
  timedOut: boolean;
}>;

type ActivationInput = Readonly<{
  selected: SelectedPlugin;
  world: WorldRoot;
  cancellation: AbortSignal;
}>;

const ABORTED = Symbol("plugin attempt aborted");

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, DIAGNOSTIC_LIMIT);
}

export function reportPluginDiagnostic(
  report: PluginDiagnostic | undefined,
  subject: string,
  stage: string,
  error: unknown,
): void {
  if (report === undefined) return;
  try {
    void Promise.resolve(report(`plugin ${subject} ${stage}: ${message(error)}`.slice(0, DIAGNOSTIC_LIMIT))).catch(
      () => {},
    );
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

function selectedEntry(
  name: string,
  entry: SettingsEntry,
  report: PluginDiagnostic | undefined,
): SelectedPlugin | null {
  if (name.trim().length === 0) {
    reportPluginDiagnostic(report, "<unnamed>", "selection", new TypeError("plugin setting name must be nonblank"));
    return null;
  }
  if (!object(entry.value)) {
    reportPluginDiagnostic(report, name, "selection", new TypeError("plugin setting must be an object"));
    return null;
  }
  const names = Object.keys(entry.value);
  if (!names.includes("package") || names.some((name) => !["package", "enabled", "config"].includes(name))) {
    reportPluginDiagnostic(report, name, "selection", new TypeError("plugin setting has unknown or missing fields"));
    return null;
  }
  const packageName = entry.value.package;
  if (typeof packageName !== "string" || packageName.trim().length === 0) {
    reportPluginDiagnostic(report, name, "selection", new TypeError("plugin package must be a nonblank string"));
    return null;
  }
  if (packageName !== packageName.trim()) {
    reportPluginDiagnostic(
      report,
      name,
      "selection",
      new TypeError("plugin package must not have surrounding whitespace"),
    );
    return null;
  }
  const enabled = entry.value.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    reportPluginDiagnostic(report, name, "selection", new TypeError("plugin enabled must be a boolean"));
    return null;
  }
  if (enabled === false) return null;
  return Object.freeze({ id: name, package: packageName, config: entry.value.config });
}

function selectedPlugins(input: Settings, report: PluginDiagnostic | undefined): readonly SelectedPlugin[] {
  const view = input.namespace(PLUGIN_NAMESPACE);
  if (view.kind === "failed") {
    for (const failure of view.failures) {
      const scope = input.scopes[failure.scope];
      reportPluginDiagnostic(
        report,
        "settings",
        failure.scope,
        failure.diagnostic ?? (scope.kind === "failed" ? scope.diagnostic : "namespace unavailable"),
      );
    }
    return BUILTIN_PLUGINS;
  }
  const entries = Object.entries(view.entries ?? {});
  if (entries.length === 0) return BUILTIN_PLUGINS;
  const configured = new Map(
    entries
      .map(([name, entry]) => [name, selectedEntry(name, entry, report)] as const)
      .filter((entry): entry is readonly [string, SelectedPlugin] => entry[1] !== null),
  );
  const disabled = new Set(
    entries.filter(([, entry]) => object(entry.value) && entry.value.enabled === false).map(([name]) => name),
  );
  const selected = [
    ...BUILTIN_PLUGINS.filter((entry) => !configured.has(entry.id) && !disabled.has(entry.id)),
    ...configured.values(),
  ]
    .filter((entry): entry is SelectedPlugin => entry !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze(selected);
}

const writablePathSchema = z.strictObject({
  name: z.string().refine((value) => value.trim().length > 0),
  path: z.string().min(1),
});
const pluginSchema = z.object({
  manifest: z.strictObject({
    id: z.string().refine((value) => value.trim().length > 0),
    apiVersion: z.literal(1),
    writablePaths: z.array(writablePathSchema).optional(),
  }),
  activate: z.custom<KeiyakuPlugin["activate"]>((value) => typeof value === "function"),
});

function writablePathDeclaration(
  value: z.infer<typeof writablePathSchema>,
  names: Set<string>,
): Readonly<{ name: string; parts: readonly string[] }> {
  if (names.has(value.name)) throw new TypeError(`plugin writable path name is duplicated: ${value.name}`);
  if (value.path.includes("\\")) {
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
  declarations: z.infer<typeof pluginSchema>["manifest"]["writablePaths"],
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

// Exhaustive over the public payload map: a new signal must be admitted here too.
const SIGNAL_KINDS: { readonly [K in keyof PluginSignalMap]: K } = {
  "akuma.born": "akuma.born",
  "akuma.outcome-observed": "akuma.outcome-observed",
  "akuma.reported": "akuma.reported",
  "akuma.turn-started": "akuma.turn-started",
  "akuma.turn-outcome": "akuma.turn-outcome",
  "akuma.body-ended": "akuma.body-ended",
};
const instanceSchema = z.strictObject({
  signals: z
    .partialRecord(
      z.enum(SIGNAL_KINDS),
      z.custom<NonNullable<PluginHooks[keyof PluginSignalMap]>>((value) => typeof value === "function"),
    )
    .optional(),
  waitDeferral: z
    .custom<NonNullable<PluginInstance["waitDeferral"]>>((value) => typeof value === "function")
    .optional(),
});

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

async function activate({ selected, world, cancellation }: ActivationInput): Promise<Activation["instance"]> {
  const module = await importFromWorld(world, selected.package);
  pluginSchema.parse(module.default);
  const candidate = module.default as z.infer<typeof pluginSchema>;
  if (candidate.manifest.id !== selected.id) {
    throw new TypeError(`plugin manifest id does not match selected entry: ${candidate.manifest.id}`);
  }
  const declared = await writablePaths(world, candidate.manifest.writablePaths);
  const context: PluginContext = Object.freeze({
    world,
    config: selected.config,
    writablePath(name: string): string {
      const path = declared.get(name);
      if (path === undefined) throw new TypeError(`plugin writable path is undeclared: ${name}`);
      return path;
    },
  });
  if (cancellation.aborted) return undefined;
  const instance = await candidate.activate(context, cancellation);
  if (cancellation.aborted) return undefined;
  instanceSchema.parse(instance);
  return instance;
}

async function deliver(
  { pluginId, instance }: Activation,
  signal: PluginSignal,
  reportDiagnostic: PluginDiagnostic | undefined,
  timeoutMs: number,
): Promise<void> {
  const signals = instance?.signals;
  const handler = signals?.[signal.kind];
  if (handler === undefined) return;
  const result = await boundedAttempt(
    (cancellation) => handler.call(signals, signal as never, cancellation),
    timeoutMs,
  );
  if (result.kind === "timed-out") reportPluginDiagnostic(reportDiagnostic, pluginId, "signal", timeoutError());
  if (result.kind === "failed") reportPluginDiagnostic(reportDiagnostic, pluginId, "signal", result.error);
}

async function closeWaitDeferral(
  pluginId: string,
  scope: PluginWaitDeferral,
  reportDiagnostic: PluginDiagnostic | undefined,
): Promise<void> {
  const result = await boundedAttempt((cancellation) => scope.close(cancellation));
  if (result.kind === "timed-out")
    reportPluginDiagnostic(reportDiagnostic, pluginId, "wait deferral cleanup", timeoutError());
  if (result.kind === "failed")
    reportPluginDiagnostic(reportDiagnostic, pluginId, "wait deferral cleanup", result.error);
}

async function acquireWaitDeferral(
  { pluginId, activation }: Readonly<{ pluginId: string; activation: Promise<Activation> }>,
  input: PluginWaitDeferralInput,
  signal: AbortSignal | undefined,
  deadline: number,
  reportDiagnostic: PluginDiagnostic | undefined,
): Promise<PluginWaitDeferral | undefined> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const cancellation = controller.signal;
  const timer = setTimeout(() => controller.abort(timeoutError()), Math.max(0, deadline - performance.now()));
  const completed = activation
    .then(async (activated) => {
      if (cancellation.aborted) return undefined;
      const value = await activated.instance?.waitDeferral?.(input, cancellation);
      return value === undefined ? undefined : waitDeferralResource(value, pluginId, reportDiagnostic);
    })
    .catch((error: unknown) => {
      if (!cancellation.aborted) reportPluginDiagnostic(reportDiagnostic, pluginId, "wait deferral", error);
      return undefined;
    });
  const result = await settleBefore(completed, cancellation);
  clearTimeout(timer);
  signal?.removeEventListener("abort", abort);
  if (result !== ABORTED) return result;
  if (signal?.aborted !== true) reportPluginDiagnostic(reportDiagnostic, pluginId, "wait deferral", timeoutError());
  void completed.then(async (scope) => {
    if (scope !== undefined) await closeWaitDeferral(pluginId, scope, reportDiagnostic);
  });
  return undefined;
}

function waitDeferralResource(
  value: unknown,
  pluginId: string,
  reportDiagnostic: PluginDiagnostic | undefined,
): PluginWaitDeferral | undefined {
  try {
    const close = object(value) ? value.close : undefined;
    if (typeof close !== "function") throw new TypeError("resource close must be a function");
    // Normal and late acquisition have disjoint cleanup paths; the plugin owns its close lifetime.
    return value as PluginWaitDeferral;
  } catch (error) {
    reportPluginDiagnostic(reportDiagnostic, pluginId, "wait deferral validation", error);
    return undefined;
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
  const selected = selectedPlugins(input.settings ?? (await Settings.load({ cwd: input.world })), report);
  const activations = selected.map((entry) => {
    const activation = boundedAttempt((cancellation) =>
      activate({ selected: entry, world: input.world, cancellation }),
    ).then((result): Activation => {
      if (result.kind === "settled") {
        return { pluginId: entry.id, instance: result.value, timedOut: false };
      }
      reportPluginDiagnostic(report, entry.id, "activation", result.kind === "failed" ? result.error : timeoutError());
      return { pluginId: entry.id, instance: undefined, timedOut: result.kind === "timed-out" };
    });
    return { pluginId: entry.id, activation };
  });

  return Object.freeze({
    async emit(signal: PluginSignal, reportDiagnostic: PluginDiagnostic | undefined = report): Promise<void> {
      const deadline = performance.now() + PLUGIN_ATTEMPT_TIMEOUT_MS;
      const expiry = new AbortController();
      const timer = setTimeout(() => expiry.abort(), PLUGIN_ATTEMPT_TIMEOUT_MS);
      try {
        await Promise.all(
          activations.map(async ({ pluginId, activation }) => {
            const activated = await settleBefore(activation, expiry.signal);
            if (activated === ABORTED || activated.timedOut) {
              reportPluginDiagnostic(reportDiagnostic, pluginId, "signal", timeoutError());
              if (activated === ABORTED) return;
            }
            await deliver(activated, signal, reportDiagnostic, Math.max(0, deadline - performance.now()));
          }),
        );
      } finally {
        clearTimeout(timer);
      }
    },
    async withWaitDeferrals<T>(
      selected: PluginWaitDeferralInput,
      signal: AbortSignal | undefined,
      action: () => Promise<T>,
      reportDiagnostic: PluginDiagnostic | undefined = report,
    ): Promise<T> {
      signal?.throwIfAborted();
      const input = Object.freeze({
        akumaIds: Object.freeze([...selected.akumaIds]),
      });
      const deadline = performance.now() + PLUGIN_ATTEMPT_TIMEOUT_MS;
      const scopes = await Promise.all(
        activations.map((plugin) => acquireWaitDeferral(plugin, input, signal, deadline, reportDiagnostic)),
      );
      try {
        signal?.throwIfAborted();
        return await action();
      } finally {
        await Promise.all(
          scopes.map((scope, index) =>
            scope === undefined ? undefined : closeWaitDeferral(activations[index]!.pluginId, scope, reportDiagnostic),
          ),
        );
      }
    },
  });
}
