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
  emit(signal: PluginSignal, reportDiagnostic?: PluginDiagnostic, caller?: AbortSignal): Promise<void>;
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
  | Readonly<{ kind: "completed"; value: T }>
  | Readonly<{ kind: "failed"; error: unknown }>
  | Readonly<{ kind: "expired" | "canceled" }>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function reportPluginDiagnostic(
  report: PluginDiagnostic | undefined,
  subject: string,
  stage: string,
  error: unknown,
): void {
  if (report === undefined) return;
  try {
    const detail = error instanceof Error ? error.message : String(error);
    void Promise.resolve(report(`plugin ${subject} ${stage}: ${detail}`.slice(0, DIAGNOSTIC_LIMIT))).catch(() => {});
  } catch {
    // Diagnostics are optional side effects too.
  }
}

function timeoutError(): Error {
  return new Error(`timed out after ${PLUGIN_ATTEMPT_TIMEOUT_MS}ms`);
}

function runBounded<T>(
  operation: (signal: AbortSignal) => Promise<T> | T,
  deadline: number,
  caller?: AbortSignal,
  onLateValue?: (value: T) => Promise<void>,
): Promise<Attempt<T>> {
  if (caller?.aborted) return Promise.resolve({ kind: "canceled" });
  if (deadline <= performance.now()) return Promise.resolve({ kind: "expired" });
  const controller = new AbortController();
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: Attempt<T>): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      caller?.removeEventListener("abort", cancel);
      resolve(result);
      return true;
    };
    const cancel = () => {
      if (settle({ kind: "canceled" })) controller.abort(caller?.reason);
    };
    const timer = setTimeout(() => {
      if (settle({ kind: "expired" })) controller.abort(timeoutError());
    }, deadline - performance.now());
    caller?.addEventListener("abort", cancel, { once: true });
    void Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      })
      .then(
        (value) => {
          if (!settle({ kind: "completed", value })) return onLateValue?.(value);
          return undefined;
        },
        (error: unknown) => settle({ kind: "failed", error }),
      )
      .catch(() => {});
  });
}

function attemptValue<T>(
  result: Attempt<T>,
  report: PluginDiagnostic | undefined,
  pluginId: string,
  stage: string,
): T | undefined {
  if (result.kind === "completed") return result.value;
  if (result.kind !== "canceled") {
    reportPluginDiagnostic(report, pluginId, stage, result.kind === "failed" ? result.error : timeoutError());
  }
  return undefined;
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
  ].sort((left, right) => left.id.localeCompare(right.id));
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
  "akuma.retired": "akuma.retired",
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

async function activate(
  selected: SelectedPlugin,
  world: WorldRoot,
  cancellation: AbortSignal,
): Promise<z.infer<typeof instanceSchema>> {
  const module = await importFromWorld(world, selected.package);
  cancellation.throwIfAborted();
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
  cancellation.throwIfAborted();
  const instance = await candidate.activate(context, cancellation);
  cancellation.throwIfAborted();
  instanceSchema.parse(instance);
  return instance;
}

async function closeWaitDeferral(
  pluginId: string,
  scope: PluginWaitDeferral | undefined,
  reportDiagnostic: PluginDiagnostic | undefined,
): Promise<void> {
  if (scope === undefined) return;
  attemptValue(
    await runBounded((cancellation) => scope.close(cancellation), performance.now() + PLUGIN_ATTEMPT_TIMEOUT_MS),
    reportDiagnostic,
    pluginId,
    "wait deferral cleanup",
  );
}

type PluginActivation = Readonly<{ pluginId: string; activation: Promise<Attempt<z.infer<typeof instanceSchema>>> }>;

async function emitToPlugin(
  { pluginId, activation }: PluginActivation,
  signal: PluginSignal,
  deadline: number,
  report: PluginDiagnostic | undefined,
  caller: AbortSignal | undefined,
): Promise<void> {
  const result = await runBounded(
    async (cancellation) => {
      const activated = await activation;
      cancellation.throwIfAborted();
      if (activated.kind === "expired") throw timeoutError();
      if (activated.kind === "completed") {
        await activated.value.signals?.[signal.kind]?.(signal as never, cancellation);
      }
    },
    deadline,
    caller,
  );
  if (result.kind === "canceled")
    reportPluginDiagnostic(report, pluginId, signal.kind, "dropped on producer control cancellation");
  else attemptValue(result, report, pluginId, "signal");
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
    const activation = runBounded(
      (cancellation) => activate(entry, input.world, cancellation),
      performance.now() + PLUGIN_ATTEMPT_TIMEOUT_MS,
    ).then((result) => {
      attemptValue(result, report, entry.id, "activation");
      return result;
    });
    return { pluginId: entry.id, activation };
  });

  return Object.freeze({
    async emit(signal: PluginSignal, reportDiagnostic: PluginDiagnostic | undefined = report, caller?: AbortSignal) {
      const deadline = performance.now() + PLUGIN_ATTEMPT_TIMEOUT_MS;
      await Promise.all(
        activations.map((activation) => emitToPlugin(activation, signal, deadline, reportDiagnostic, caller)),
      );
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
        activations.map(async ({ pluginId, activation }) => {
          return attemptValue(
            await runBounded(
              async (cancellation) => {
                const activated = await activation;
                cancellation.throwIfAborted();
                if (activated.kind !== "completed") return undefined;
                const scope = await activated.value.waitDeferral?.(input, cancellation);
                if (scope !== undefined && (!object(scope) || typeof scope.close !== "function")) {
                  throw new TypeError("resource close must be a function");
                }
                return scope;
              },
              deadline,
              signal,
              (scope) => closeWaitDeferral(pluginId, scope, reportDiagnostic),
            ),
            reportDiagnostic,
            pluginId,
            "wait deferral",
          );
        }),
      );
      try {
        signal?.throwIfAborted();
        return await action();
      } finally {
        await Promise.all(
          scopes.map((scope, index) => closeWaitDeferral(activations[index]!.pluginId, scope, reportDiagnostic)),
        );
      }
    },
  });
}
