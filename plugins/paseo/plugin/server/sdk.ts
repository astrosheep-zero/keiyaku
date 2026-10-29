import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { historySchema, type History } from "./keiyaku.js";
import { tellReceiptSchema } from "./message.js";
import { stopAttempt } from "./stop.js";
import type { AkumaTransport } from "./transport.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const PACKAGE_NAME = "@astrosheep/keiyaku";
const stopEvidence = z.string();

type PublicAkuma = {
  tell(text: string, options: Readonly<{ signal: AbortSignal }>): Promise<unknown>;
  kill(options: Readonly<{ signal: AbortSignal }>): Promise<unknown>;
  status(): Promise<unknown>;
  stream(options: Readonly<{ signal: AbortSignal }>): AsyncIterable<unknown>;
};
type KeiyakuSdk = {
  Akuma: {
    prototype: { stream: unknown };
    select(world: string, akuId: string): PublicAkuma;
  };
};
type PackageManifest = Record<string, unknown> & { name?: unknown; version?: unknown };
type PackageRoot = Readonly<{ root: string; manifest: PackageManifest }>;
type ResolvedEntry = Readonly<{ entry: string; version: string }>;
type ActiveScope = Readonly<{
  signal: AbortSignal;
  closeMessage: string;
  abort(reason: unknown): void;
  dispose(): void;
}>;

export type SdkTransportOptions = Readonly<{
  /** An explicit public-entry file or URL; discovery through PATH is the production path. */
  entry?: string;
  /** One request's bound. A mutation that outlives it is uncertain, never retried. */
  timeoutMs?: number;
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function realFile(candidate: string): Promise<string | undefined> {
  try { return await realpath(candidate); } catch { return undefined; }
}

async function findOnPath(name: string): Promise<string | undefined> {
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory === "") continue;
    for (const extension of extensions) {
      const found = await realFile(path.join(directory, name + extension));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

async function packageRoot(file: string): Promise<PackageRoot | undefined> {
  let directory = path.dirname(file);
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as PackageManifest;
      if (manifest.name === PACKAGE_NAME) return { root: directory, manifest };
    } catch { /* keep walking toward the package root */ }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function declaredEntry(pkg: PackageRoot): string | undefined {
  const rootExport = record(pkg.manifest.exports)?.["."];
  const conditions = record(rootExport);
  const relative = typeof rootExport === "string" ? rootExport
    : typeof conditions?.import === "string" ? conditions.import
      : typeof conditions?.default === "string" ? conditions.default : undefined;
  const chosen = relative ?? (typeof pkg.manifest.main === "string" ? pkg.manifest.main : undefined);
  return chosen === undefined ? undefined : path.join(pkg.root, chosen);
}

async function resolveEntry(explicit?: string): Promise<ResolvedEntry> {
  if (explicit !== undefined && explicit !== "") {
    const entry = explicit.startsWith("file:") ? fileURLToPath(explicit) : path.resolve(explicit);
    const pkg = await packageRoot(entry);
    return { entry, version: typeof pkg?.manifest.version === "string" ? pkg.manifest.version : "unknown" };
  }
  const bin = await findOnPath("keiyaku");
  if (bin === undefined) throw new Error("the keiyaku executable is not on PATH; the Paseo bridge cannot locate its public package");
  const pkg = await packageRoot(bin);
  if (pkg === undefined) throw new Error(`no ${PACKAGE_NAME} package owns ${bin}`);
  const entry = declaredEntry(pkg);
  if (entry === undefined) throw new Error(`the installed ${PACKAGE_NAME} package declares no public entry`);
  return { entry, version: typeof pkg.manifest.version === "string" ? pkg.manifest.version : "unknown" };
}

function assertSdkSurface(sdk: KeiyakuSdk, version: string): void {
  if (typeof sdk.Akuma?.select !== "function")
    throw new Error(`Installed ${PACKAGE_NAME} version ${version} does not expose Akuma.select`);
  if (typeof sdk.Akuma.prototype?.stream !== "function")
    throw new Error(`Installed ${PACKAGE_NAME} version ${version} does not expose Akuma.prototype.stream`);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "Keiyaku SDK request was cancelled"));
}

/** Race an SDK operation with its owning signal even when the operation ignores cancellation. */
function raceAbort<T>(signal: AbortSignal, operation: () => T | PromiseLike<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: Readonly<{ value: T }> | Readonly<{ error: unknown }>): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
    const onAbort = () => finish({ error: abortReason(signal) });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error }),
    );
  });
}

/**
 * Adapt the installed public SDK in this plugin process. Each request owns its
 * cancellation and timeout; a stream owns one signal across its idle frames.
 */
export function createSdkTransport(options: SdkTransportOptions = {}): AkumaTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let closed = false;
  let sdk: KeiyakuSdk | undefined;
  let loading: Promise<KeiyakuSdk> | undefined;
  const active = new Set<ActiveScope>();

  async function loadSdk(): Promise<KeiyakuSdk> {
    if (sdk !== undefined) return sdk;
    if (loading !== undefined) return await loading;
    const attempt = (async () => {
      const resolved = await resolveEntry(options.entry);
      const loaded = await import(pathToFileURL(resolved.entry).href) as KeiyakuSdk;
      assertSdkSurface(loaded, resolved.version);
      sdk = loaded;
      return loaded;
    })();
    loading = attempt;
    try {
      return await attempt;
    } finally {
      if (loading === attempt) loading = undefined;
    }
  }

  function createScope(signal: AbortSignal, closeMessage: string): ActiveScope {
    signal.throwIfAborted();
    if (closed) throw new Error("Keiyaku SDK transport is closed");
    const controller = new AbortController();
    const scope: ActiveScope = {
      signal: AbortSignal.any([signal, controller.signal]),
      closeMessage,
      abort(reason) { if (!controller.signal.aborted) controller.abort(reason); },
      dispose() { active.delete(scope); },
    };
    active.add(scope);
    return scope;
  }

  function withTimeout<T>(scope: ActiveScope, tail: string, operation: () => T | PromiseLike<T>): Promise<T> {
    const timer = setTimeout(() => scope.abort(
      new Error(`Keiyaku SDK request timed out after ${timeoutMs}ms; ${tail}`),
    ), timeoutMs);
    return raceAbort(scope.signal, operation).finally(() => clearTimeout(timer));
  }

  async function request<T>(
    world: string, akuId: string, signal: AbortSignal,
    operation: (akuma: PublicAkuma, signal: AbortSignal) => T | PromiseLike<T>,
  ): Promise<T> {
    const scope = createScope(signal,
      "Keiyaku SDK transport closed while the request was in flight; its outcome is uncertain");
    try {
      return await withTimeout(scope, "any admitted work's outcome is uncertain", async () => {
        const installed = await loadSdk();
        scope.signal.throwIfAborted();
        return await operation(installed.Akuma.select(world, akuId), scope.signal);
      });
    } finally {
      scope.dispose();
    }
  }

  const tell: AkumaTransport["tell"] = async (world, akuId, signal, text) => {
    const value = await request(world, akuId, signal, (akuma, requestSignal) => akuma.tell(text, { signal: requestSignal }));
    const decoded = tellReceiptSchema.parse(value);
    if (decoded.akuma !== akuId || decoded.tell.admission.tellId !== decoded.tell.row.tellId || decoded.tell.row.text !== text)
      throw new Error("Keiyaku Tell outcome is uncertain: the admission receipt did not name the submitted Tell");
    return decoded.tell;
  };

  const stop: AkumaTransport["stop"] = async (world, akuId, signal) => {
    const value = await request(world, akuId, signal, (akuma, requestSignal) => akuma.kill({ signal: requestSignal }));
    return stopAttempt(stopEvidence.parse(value), akuId);
  };

  const status: AkumaTransport["status"] = async (world, akuId, signal) => {
    const value = await request(world, akuId, signal, (akuma) => akuma.status());
    const fields = record(value);
    return {
      ...(typeof fields?.provider === "string" ? { provider: fields.provider } : {}),
      ...(typeof fields?.model === "string" ? { model: fields.model } : {}),
    };
  };

  const stream: AkumaTransport["stream"] = (world, akuId, signal) => ({
    [Symbol.asyncIterator](): AsyncIterator<History> {
      let scope: ActiveScope | undefined;
      let iterator: AsyncIterator<unknown> | undefined;
      let finished = false;
      let pulling = false;
      const finish = (reason: unknown = new Error("Keiyaku SDK stream observation was released")): void => {
        if (finished) return;
        finished = true;
        const current = iterator;
        iterator = undefined;
        const currentScope = scope;
        scope = undefined;
        if (currentScope !== undefined) {
          currentScope.signal.removeEventListener("abort", abandon);
          currentScope.abort(reason);
          currentScope.dispose();
        }
        try {
          const closing = current?.return?.();
          if (closing !== undefined) void Promise.resolve(closing).catch(() => {});
        } catch { /* the observation is already released */ }
      };
      const abandon = () => finish(scope?.signal.reason);
      const observation = (): ActiveScope => {
        scope ??= createScope(signal,
          "Keiyaku SDK transport closed while the request was in flight; the observation was released");
        scope.signal.addEventListener("abort", abandon, { once: true });
        return scope;
      };
      return {
        async next(): Promise<IteratorResult<History>> {
          if (pulling)
            throw new Error("Keiyaku SDK stream subscription already has a frame in flight; pull one frame at a time");
          if (finished) return { done: true, value: undefined };
          pulling = true;
          try {
            const currentScope = observation();
            if (iterator === undefined) {
              await withTimeout(currentScope, "the observation was released", async () => {
                const installed = await loadSdk();
                currentScope.signal.throwIfAborted();
                iterator = installed.Akuma.select(world, akuId).stream({ signal: currentScope.signal })[Symbol.asyncIterator]();
              });
            }
            const frame = await raceAbort(currentScope.signal, () => iterator!.next());
            if (frame.done) {
              finish();
              return { done: true, value: undefined };
            }
            return { done: false, value: historySchema.parse(frame.value) };
          } catch (error) {
            finish(error);
            throw error;
          } finally {
            pulling = false;
          }
        },
        async return(): Promise<IteratorResult<History>> {
          finish();
          return { done: true, value: undefined };
        },
        async throw(error?: unknown): Promise<IteratorResult<History>> {
          finish(error);
          throw error;
        },
      };
    },
  });

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const scope of [...active]) scope.abort(new Error(scope.closeMessage));
  }

  return Object.freeze({ stream, tell, stop, status, close });
}
