/**
 * The dedicated Keiyaku worker the Paseo bridge spawns.
 *
 * Paseo compiles a directory-source plugin into one evaluated bundle, so the
 * plugin directory has no worker module to point at once it is loaded, and a
 * static or literal dynamic import of the package root is rejected by Paseo's
 * own module boundary (the repository self-link resolves outside the plugin
 * directory). The worker therefore travels as source text and is started with
 * `node --input-type=module -e`. It locates the installed public package
 * portably: the `keiyaku` executable on PATH, then the package root that owns
 * it, then that package's own declared public entry. An explicit entry
 * argument overrides discovery for tests and embedding.
 *
 * The worker is deliberately the thinnest possible host: it imports the public
 * package root, serves one JSON request per line, and answers with the public
 * operations' own values. It never formats CLI arguments, never renders text,
 * and never decides a lifecycle outcome. Identity is stripped by the spawning
 * transport's environment; this module never touches `process.env`.
 *
 * `tests/paseo-sdk-transport.test.ts` type-checks this text against the public
 * TypeScript surface and runs it as a real process, so keep it valid JavaScript
 * with JSDoc types and free of backticks and template substitutions.
 */
export const WORKER_SOURCE = String.raw`import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const EXPLICIT_ENTRY = process.argv[1];

/** @param {string} candidate @returns {Promise<string | undefined>} */
async function realFile(candidate) {
  try { return await realpath(candidate); } catch { return undefined; }
}

/** @param {string} name @returns {Promise<string | undefined>} */
async function findOnPath(name) {
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (directory === "") continue;
    for (const extension of extensions) {
      const found = await realFile(path.join(directory, name + extension));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** @param {string} bin @returns {Promise<{ root: string, manifest: any } | undefined>} */
async function packageRoot(bin) {
  let directory = path.dirname(bin);
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      if (manifest.name === "@astrosheep/keiyaku") return { root: directory, manifest };
    } catch {}
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** @param {string} root @param {any} manifest @returns {string | undefined} */
function declaredEntry(root, manifest) {
  const main = manifest.exports === undefined ? undefined : manifest.exports["."];
  const relative = typeof main === "string" ? main : main === undefined ? undefined : main.import || main.default;
  const chosen = relative === undefined ? manifest.main : relative;
  return typeof chosen === "string" ? pathToFileURL(path.join(root, chosen)).href : undefined;
}

/** @returns {Promise<string>} */
async function resolveEntry() {
  if (EXPLICIT_ENTRY !== undefined && EXPLICIT_ENTRY !== "") {
    return EXPLICIT_ENTRY.startsWith("file:") ? EXPLICIT_ENTRY : pathToFileURL(path.resolve(EXPLICIT_ENTRY)).href;
  }
  const bin = await findOnPath("keiyaku");
  if (bin === undefined) throw new Error("the keiyaku executable is not on PATH; the Paseo bridge cannot locate its public package");
  const found = await packageRoot(bin);
  if (found === undefined) throw new Error("no @astrosheep/keiyaku package owns " + bin);
  const entry = declaredEntry(found.root, found.manifest);
  if (entry === undefined) throw new Error("the installed @astrosheep/keiyaku package declares no public entry");
  return entry;
}

/** @returns {Promise<typeof import("@astrosheep/keiyaku")>} */
async function loadSdk() {
  const entry = await resolveEntry();
  /** @type {typeof import("@astrosheep/keiyaku")} */
  const sdk = await import(entry);
  if (typeof sdk.Akuma?.select !== "function") {
    throw new Error("the public @astrosheep/keiyaku entry does not expose Akuma.select");
  }
  return sdk;
}

const boot = loadSdk();
// A boot that fails before the first request still belongs to those requests;
// keep the rejection handled until one of them observes it.
boot.catch(() => {});

/** @type {Map<number, AbortController>} */
const controllers = new Map();

/**
 * One live observation of an Akuma's current window. The iterator is undefined
 * only while the opening request is still resolving the public package.
 * @typedef {{ controller: AbortController, iterator: AsyncIterator<unknown> | undefined }} Subscription
 */
/** @type {Map<number, Subscription>} */
const subscriptions = new Map();

/**
 * The installed public package may predate the streaming surface, so probe the
 * capability at runtime instead of assuming this bridge's own vintage.
 * @param {unknown} value @returns {value is { stream(options: { signal: AbortSignal }): AsyncIterable<unknown> }}
 */
function exposesStream(value) {
  return typeof value === "object" && value !== null &&
    typeof (/** @type {{ stream?: unknown }} */ (value)).stream === "function";
}

/**
 * The model configuration a public status reports, when it reports one. An
 * installed package that carries no model in status stays unknown here; the
 * bridge never invents a configuration from its own defaults.
 * @param {unknown} status @returns {{ provider?: string, model?: string }}
 */
function modelConfiguration(status) {
  if (typeof status !== "object" || status === null) return {};
  const fields = /** @type {Record<string, unknown>} */ (status);
  return {
    ...(typeof fields.provider === "string" ? { provider: fields.provider } : {}),
    ...(typeof fields.model === "string" ? { model: fields.model } : {}),
  };
}

/** @param {any} message */
function respond(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One request through the public operations only. Every value is the
 * producer's own admission, evidence, page, or status projection.
 * @param {any} request @param {typeof import("@astrosheep/keiyaku")} sdk @param {AbortController} controller @returns {Promise<any>}
 */
async function operate(request, sdk, controller) {
  const akuma = sdk.Akuma.select(request.world, request.aku);
  if (request.op === "history") {
    const limit = typeof request.limit === "number" ? request.limit : 200;
    return await akuma.history(request.before === undefined ? { limit } : { limit, before: request.before });
  }
  if (request.op === "tell") return await akuma.tell(request.text, { signal: controller.signal });
  if (request.op === "stop") return { evidence: await akuma.kill({ signal: controller.signal }) };
  if (request.op === "status") return modelConfiguration(await akuma.status());
  throw new Error("unsupported Keiyaku SDK operation: " + String(request.op));
}

/** @param {string} line */
async function dispatch(line) {
  /** @type {any} */
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request === null || typeof request !== "object" || typeof request.id !== "number") return;
  if (request.op === "cancel") {
    const cancelled = controllers.get(request.target);
    if (cancelled !== undefined) cancelled.abort();
    return;
  }
  // A stream subscription outlives its opening request: the pull requests that
  // follow carry the subscription's own identity, so ordinary requests keep
  // their own lifetime and cancellation never reaches an unrelated observation.
  if (request.op === "stream") {
    const controller = new AbortController();
    subscriptions.set(request.id, { controller, iterator: undefined });
    try {
      const sdk = await boot;
      const akuma = sdk.Akuma.select(request.world, request.aku);
      if (!exposesStream(akuma)) {
        throw new Error("the installed @astrosheep/keiyaku package does not expose Akuma.stream; " +
          "the Paseo bridge cannot observe this Akuma continuously");
      }
      if (controller.signal.aborted) throw new Error("Keiyaku SDK stream was cancelled before it opened");
      const observed = akuma.stream({ signal: controller.signal })[Symbol.asyncIterator]();
      subscriptions.set(request.id, { controller, iterator: observed });
      respond({ id: request.id, ok: true, value: { subscription: request.id } });
    } catch (error) {
      subscriptions.delete(request.id);
      controller.abort();
      respond({ id: request.id, ok: false, error: { message: messageOf(error) } });
    }
    return;
  }
  if (request.op === "stream-pull") {
    const subscription = subscriptions.get(request.target);
    if (subscription === undefined || subscription.iterator === undefined) {
      respond({ id: request.id, ok: false, error: { message: "Keiyaku SDK stream subscription is not open" } });
      return;
    }
    try {
      const frame = await subscription.iterator.next();
      // A released subscription discards its late frame instead of publishing it
      // into whatever observation the caller opened next.
      if (subscriptions.get(request.target) !== subscription) throw new Error("Keiyaku SDK stream subscription was released");
      respond({ id: request.id, ok: true, value: frame.done === true ? { done: true } : { done: false, history: frame.value } });
    } catch (error) {
      respond({ id: request.id, ok: false, error: { message: messageOf(error) } });
    }
    return;
  }
  if (request.op === "stream-cancel") {
    const subscription = subscriptions.get(request.target);
    if (subscription !== undefined) {
      subscriptions.delete(request.target);
      subscription.controller.abort();
    }
    respond({ id: request.id, ok: true, value: null });
    return;
  }
  const controller = new AbortController();
  controllers.set(request.id, controller);
  try {
    const sdk = await boot;
    if (controller.signal.aborted) throw new Error("Keiyaku SDK request was cancelled before it started");
    respond({ id: request.id, ok: true, value: await operate(request, sdk, controller) });
  } catch (error) {
    respond({ id: request.id, ok: false, error: { message: messageOf(error) } });
  } finally {
    controllers.delete(request.id);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => { void dispatch(line); });
lines.on("close", () => { process.exit(0); });
`;
