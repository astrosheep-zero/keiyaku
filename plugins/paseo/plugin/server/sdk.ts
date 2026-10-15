import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { historySchema, identityKeys, pagedReader, type History } from "./keiyaku.js";
import { tellReceiptSchema } from "./message.js";
import { WORKER_SOURCE } from "./sdk-worker.js";
import { stopAttempt } from "./stop.js";
import type { AkumaTransport } from "./transport.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_LIMIT = 8 * 1024;

/**
 * How one request behaves when it is abandoned or when its worker retires. A
 * bounded ordinary request carries its own id and its own outcome; an unbounded
 * stream frame carries the subscription it belongs to, so releasing it cancels
 * that observation alone and says what became of the frame.
 */
type RequestMode = Readonly<{ timeout: boolean; subscription: boolean; tail: string }>;
const ORDINARY_REQUEST: RequestMode = {
  timeout: true, subscription: false, tail: "its outcome is uncertain",
};
/** Opening a subscription is one bounded handshake naming the observation to serve. */
const OPEN_STREAM: RequestMode = { timeout: true, subscription: true, tail: "the observation was released" };
/** An idle frame has no bound: waiting for the next change is the stream's whole job. */
const STREAM_FRAME: RequestMode = { timeout: false, subscription: true, tail: "the observation was released" };

const workerResponse = z.union([
  z.object({ id: z.number().int().positive(), ok: z.literal(true), value: z.unknown() }),
  z.object({ id: z.number().int().positive(), ok: z.literal(false), error: z.object({ message: z.string() }) }),
]);
const statusObservation = z.object({ provider: z.string().optional(), model: z.string().optional() });
const stopEvidence = z.object({ evidence: z.string() });

export type SdkTransportOptions = Readonly<{
  /** An explicit public-entry file or URL; discovery through PATH is the production path. */
  entry?: string;
  /** One request's bound. A mutation that outlives it is uncertain, never retried. */
  timeoutMs?: number;
}>;

/**
 * The identity-free environment the worker inherits. The worker runs the
 * public operations in its own process, so inherited harness, Square, and
 * Keiyaku caller identities are removed rather than inherited or replaced. The
 * shared process environment is never mutated.
 */
export function cleanEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of identityKeys) delete env[key];
  return env;
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Pending = {
  /** The worker that owns this request; another worker's exit never settles it. */
  worker: ChildProcessWithoutNullStreams;
  resolve(value: unknown): void;
  reject(error: Error): void;
  /** Drop every listener and timer this request added, once it has settled. */
  release(): void;
  timer: NodeJS.Timeout | undefined;
  /** How this request's disappearance is spoken about when it never settles itself. */
  tail: string;
};

/**
 * The dedicated public-SDK transport. One worker process serves every request
 * over a typed line protocol; requests carry their own cancellation and never
 * terminate one another. A worker that exits or fails to start settles only the
 * requests it owned, and the next request starts a fresh one.
 */
export function createSdkTransport(options: SdkTransportOptions = {}): AkumaTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let child: ChildProcessWithoutNullStreams | undefined;
  let nextId = 1;
  let buffered = "";
  let stderr = "";
  let closed = false;
  const pending = new Map<number, Pending>();

  function settle(id: number, entry: Pending, outcome: Readonly<{ value: unknown }> | Readonly<{ error: Error }>): void {
    if (pending.get(id) !== entry) return;
    pending.delete(id);
    entry.release();
    if ("error" in outcome) entry.reject(outcome.error);
    else entry.resolve(outcome.value);
  }

  function retire(worker: ChildProcessWithoutNullStreams, diagnostic: (entry: Pending) => string): void {
    if (child === worker) child = undefined;
    for (const [id, entry] of [...pending]) if (entry.worker === worker) settle(id, entry, { error: new Error(diagnostic(entry)) });
  }

  function ensure(): ChildProcessWithoutNullStreams {
    if (child !== undefined) return child;
    const args = ["--input-type=module", "-e", WORKER_SOURCE];
    if (options.entry !== undefined) args.push(options.entry);
    const spawned = spawn(process.execPath, args, { env: cleanEnvironment(), stdio: "pipe" });
    child = spawned;
    buffered = "";
    stderr = "";
    spawned.stdout.setEncoding("utf8");
    spawned.stderr.setEncoding("utf8");
    spawned.stdout.on("data", (chunk: string) => { buffered += chunk; read(); });
    spawned.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
      process.stderr.write(chunk);
    });
    // EPIPE can race a worker that is already retiring; the exit event owns its diagnostic.
    spawned.stdin.on("error", () => {});
    spawned.on("error", (error) => retire(spawned,
      (entry) => `Keiyaku SDK worker failed to start: ${diagnostic(error)}; ${entry.tail}`));
    spawned.on("exit", (code, signal) => retire(spawned, (entry) =>
      `Keiyaku SDK worker exited (${signal === null ? String(code) : signal})` +
      `${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}; ${entry.tail}`));
    return spawned;
  }

  function read(): void {
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim() === "") continue;
      const decoded = workerResponse.safeParse((() => { try { return JSON.parse(line); } catch { return undefined; } })());
      if (!decoded.success) {
        process.stderr.write("Keiyaku SDK worker wrote an unrecognized response line\n");
        continue;
      }
      const entry = pending.get(decoded.data.id);
      if (entry === undefined) continue;
      settle(decoded.data.id, entry, decoded.data.ok ? { value: decoded.data.value } : { error: new Error(decoded.data.error.message) });
    }
  }

  function request(op: string, payload: Record<string, unknown>, signal: AbortSignal, mode: RequestMode = ORDINARY_REQUEST): Promise<unknown> {
    signal.throwIfAborted();
    if (closed) return Promise.reject(new Error("Keiyaku SDK transport is closed"));
    const worker = ensure();
    const id = nextId++;
    // A stream request names the subscription it serves; every other request is
    // its own subject.
    const target = mode.subscription && typeof payload.target === "number" ? payload.target : id;
    return new Promise<unknown>((resolve, reject) => {
      const cancel = () => {
        if (!worker.stdin.writable) return;
        worker.stdin.write(JSON.stringify(mode.subscription
          ? { id, op: "stream-cancel", target }
          : { id, op: "cancel", target: id }) + "\n");
      };
      const entry: Pending = {
        worker, resolve, reject, tail: mode.tail,
        release: () => { clearTimeout(entry.timer); signal.removeEventListener("abort", abandon); },
        timer: undefined,
      };
      // A cancelled request tells the worker to stop observing it. The worker
      // keeps serving every other request, and an observation of its own is
      // released without reaching any unrelated one.
      const abandon = () => {
        cancel();
        settle(id, entry, { error: signal.reason instanceof Error ? signal.reason : new Error("Keiyaku SDK request was cancelled") });
      };
      if (mode.timeout) entry.timer = setTimeout(() => {
        cancel();
        settle(id, entry, { error: new Error(`Keiyaku SDK request timed out after ${timeoutMs}ms; any admitted work's outcome is uncertain`) });
      }, timeoutMs);
      pending.set(id, entry);
      signal.addEventListener("abort", abandon, { once: true });
      worker.stdin.write(JSON.stringify({ id, op, ...payload }) + "\n", (error) => {
        if (error) settle(id, entry, { error: new Error(`Keiyaku SDK worker is not writable: ${diagnostic(error)}`) });
      });
    });
  }

  /**
   * Release one subscription without owning its response: the observation's
   * frames are already worthless to the caller that gave it up, and the worker
   * answers the cancel itself.
   */
  function releaseSubscription(target: number): void {
    if (closed) return;
    const worker = child;
    if (worker === undefined || !worker.stdin.writable) return;
    worker.stdin.write(JSON.stringify({ id: nextId++, op: "stream-cancel", target }) + "\n", () => {});
  }

  const history: AkumaTransport["history"] = pagedReader(async (world, akuId, signal, before) => {
    const value = await request("history", { world, aku: akuId, limit: 200, ...(before === undefined ? {} : { before }) }, signal);
    return historySchema.parse(value);
  });

  const tell: AkumaTransport["tell"] = async (world, akuId, signal, text) => {
    const value = await request("tell", { world, aku: akuId, text }, signal);
    const decoded = tellReceiptSchema.parse(value);
    if (decoded.akuma !== akuId || decoded.tell.admission.tellId !== decoded.tell.row.tellId || decoded.tell.row.text !== text)
      throw new Error("Keiyaku Tell outcome is uncertain: the admission receipt did not name the submitted Tell");
    return decoded.tell;
  };

  const stop: AkumaTransport["stop"] = async (world, akuId, signal) => {
    const value = await request("stop", { world, aku: akuId }, signal);
    return stopAttempt(stopEvidence.parse(value).evidence, akuId);
  };

  const status: AkumaTransport["status"] = async (world, akuId, signal) => {
    const decoded = statusObservation.parse(await request("status", { world, aku: akuId }, signal));
    return {
      ...(decoded.provider === undefined ? {} : { provider: decoded.provider }),
      ...(decoded.model === undefined ? {} : { model: decoded.model }),
    };
  };

  /**
   * One pull-backed observation. The subscription is established by the first
   * pull, each pull has at most one outstanding frame, and abandoning the
   * caller's signal or the iterator releases exactly this subscription.
   */
  const stream: AkumaTransport["stream"] = (world, akuId, signal) => ({
    [Symbol.asyncIterator](): AsyncIterator<History> {
      let subscription: number | undefined;
      let released = false;
      let finished = false;
      let pulling = false;
      const release = (): void => {
        const target = subscription;
        subscription = undefined;
        if (target !== undefined) releaseSubscription(target);
      };
      // Abort releases the observation even while the caller is not pulling.
      const abandon = () => { released = true; release(); };
      signal.addEventListener("abort", abandon, { once: true });
      const unwind = (): void => { signal.removeEventListener("abort", abandon); release(); };
      return {
        async next(): Promise<IteratorResult<History>> {
          // One frame at a time is the transport's own contract, not a habit of
          // its caller: a second pull here would put two frames in flight.
          if (pulling)
            throw new Error("Keiyaku SDK stream subscription already has a frame in flight; pull one frame at a time");
          pulling = true;
          try {
            if (finished || released || signal.aborted) { unwind(); return { done: true, value: undefined }; }
            if (subscription === undefined) {
              const opened = z.object({ subscription: z.number().int().positive() })
                .parse(await request("stream", { world, aku: akuId }, signal, OPEN_STREAM));
              subscription = opened.subscription;
            }
            const frame = z.union([z.object({ done: z.literal(true) }),
              z.object({ done: z.literal(false), history: z.unknown() })])
              .parse(await request("stream-pull", { target: subscription }, signal, STREAM_FRAME));
            if (frame.done) { unwind(); return { done: true, value: undefined }; }
            return { done: false, value: historySchema.parse(frame.history) };
          } catch (error) {
            // A failed or released observation is over: it never silently reopens
            // a subscription the caller did not ask for again.
            finished = true;
            unwind();
            throw error;
          } finally {
            pulling = false;
          }
        },
        async return(): Promise<IteratorResult<History>> {
          finished = true;
          unwind();
          return { done: true, value: undefined };
        },
        async throw(error?: unknown): Promise<IteratorResult<History>> { finished = true; unwind(); throw error; },
      };
    },
  });

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    const worker = child;
    child = undefined;
    for (const [id, entry] of [...pending])
      settle(id, entry, { error: new Error(`Keiyaku SDK transport closed while the request was in flight; ${entry.tail}`) });
    if (worker === undefined) return;
    if (worker.exitCode !== null || worker.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => worker.kill("SIGKILL"), 2_000);
      worker.once("close", () => { clearTimeout(force); resolve(); });
      try { worker.stdin.end(); } catch { /* the worker may already be gone */ }
      worker.kill("SIGTERM");
    });
  }

  return Object.freeze({ history, stream, tell, stop, status, close });
}
