import { OpenCode, type OpenCodeClient, type SessionInterruptResponse, type V2Event } from "@opencode/client";
import { Agent, fetch as undiciFetch } from "undici";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { abortable, abortableDelay } from "../../abort.js";
import { akumaExecutionEnvironment, type ExecutionCoordinate } from "../execution-environment.js";
import { spawnDetachedProcess, type OwnedProcess } from "../../../runtime/proc/run.js";
import type { AttemptCustody } from "../../provider.js";
import type { ProviderExecution } from "../../provider-recipe.js";
import { object } from "../decode.js";

// v2.0.20 Agent.Info.default asks only for external_directory and env reads;
// question separately requests permission before awaiting its form reply.
const HEADLESS_PERMISSION_BASE = [
  { action: "external_directory", resource: "*", effect: "allow" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "question", resource: "*", effect: "deny" },
] as const;
export function composeHeadlessPermissionConfig(config?: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const permissions = config?.permissions;
  if (permissions !== undefined && !Array.isArray(permissions))
    throw new Error("OpenCode v2 permissions must be a ruleset");
  const actions = new Set((permissions ?? []).map((rule: unknown) => object(rule)?.action));
  return {
    ...config,
    permissions: [...HEADLESS_PERMISSION_BASE.filter((rule) => !actions.has(rule.action)), ...(permissions ?? [])],
  };
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        server.close(() => reject(new Error("OpenCode port unavailable")));
      else server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}

type RuntimeInput = Readonly<{
  execution: ProviderExecution;
  cwd: string;
  signal: AbortSignal;
  custody: AttemptCustody;
  executionCoordinate?: ExecutionCoordinate;
}>;
type Endpoint = Readonly<{ baseUrl: string; password: string }>;
export type RuntimeOpener = (input: RuntimeInput) => Promise<NativeOpencodeRuntime>;
const matchedFetch = undiciFetch as unknown as typeof globalThis.fetch;

function closure() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export class NativeOpencodeRuntime {
  readonly #io = new AbortController();
  readonly #closed = closure();
  readonly #failures: unknown[] = [];
  #server?: Promise<{ endpoint: Endpoint; server: OwnedProcess }>;
  #dispatcher?: Agent;
  #readerRetired?: Promise<void>;
  #client!: OpenCodeClient;
  #iterator?: AsyncIterator<V2Event>;
  #reading?: Promise<IteratorResult<V2Event>>;
  #retiring?: Promise<void>;
  #interrupt?: Promise<SessionInterruptResponse>;
  #control?: (kind: "abort" | "forceDispose") => void;
  sessionID?: string;

  private constructor(readonly options: { signal: AbortSignal }) {}

  get client(): OpenCodeClient {
    return this.#client;
  }

  static async open(input: RuntimeInput, endpoint?: Endpoint): Promise<NativeOpencodeRuntime> {
    const { execution, cwd, signal, custody, executionCoordinate } = input;
    const runtime = new NativeOpencodeRuntime({ signal });
    custody.own({
      closed: runtime.#closed.promise,
      abort: () => runtime.#abort(),
      forceDispose: () => runtime.#forceDispose(),
    });
    try {
      signal.throwIfAborted();
      if (endpoint === undefined) {
        runtime.#server = availablePort().then(async (port) => {
          signal.throwIfAborted();
          const password =
            execution.env?.OPENCODE_PASSWORD ??
            execution.env?.OPENCODE_SERVER_PASSWORD ??
            randomBytes(32).toString("base64url");
          const server = await spawnDetachedProcess({
            argv: [execution.executable ?? "opencode", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
            cwd,
            // Private serve owns its configured local MCP processes. OpenCode's local
            // stdio spawner extends this environment rather than filtering its keys.
            env: akumaExecutionEnvironment(
              process.env,
              {
                OPENCODE_CONFIG_CONTENT: JSON.stringify(composeHeadlessPermissionConfig(execution.config)),
                ...execution.env,
                OPENCODE_PASSWORD: password,
                OPENCODE_SERVER_PASSWORD: password,
              },
              [],
              executionCoordinate,
            ),
            log: `${cwd}/.opencode.log`,
          });
          return { endpoint: { baseUrl: `http://127.0.0.1:${port}`, password }, server };
        });
        ({ endpoint } = await runtime.#server);
      }
      signal.throwIfAborted();
      runtime.#connect(endpoint);
      await runtime.#ready();
      signal.throwIfAborted();
      runtime.#iterator = runtime.client.event.subscribe({ signal: runtime.#io.signal })[Symbol.asyncIterator]();
      const connected = await abortable(runtime.next(), signal);
      if (connected.done || connected.value.type !== "server.connected")
        throw new Error("OpenCode event feed did not confirm subscription");
      signal.throwIfAborted();
      return runtime;
    } catch (error) {
      await runtime.retire();
      throw error;
    }
  }

  #connect({ baseUrl, password }: Endpoint): void {
    const dispatcher = (this.#dispatcher = new Agent());
    this.#client = OpenCode.make({
      baseUrl,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      fetch: async (input, init) => {
        const signal = init?.signal == null ? this.#io.signal : AbortSignal.any([this.#io.signal, init.signal]);
        signal.throwIfAborted();
        const request = { ...init, signal, dispatcher };
        const response = await matchedFetch(input, request);
        const body = response.body;
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (body !== null && contentType === "text/event-stream") {
          const getReader = body.getReader.bind(body);
          Object.defineProperty(body, "getReader", {
            value: () => {
              signal.throwIfAborted();
              const reader = getReader();
              this.#trackReader(reader);
              return reader;
            },
          });
        }
        return response;
      },
    });
  }

  #trackReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    // The SDK subscriber can detach before its shared reader releases the lock,
    // and the native pump suppresses cancel failures. Observe that same reader.
    const retired = closure();
    this.#readerRetired = retired.promise;
    const cancel = reader.cancel.bind(reader);
    const release = reader.releaseLock.bind(reader);
    let streamError: unknown;
    void reader.closed.catch((error: unknown) => {
      streamError = error;
    });
    reader.cancel = async (reason) => {
      try {
        await cancel(reason);
      } catch (error) {
        // On an already-errored stream cancel merely repeats its read error.
        if (error !== streamError) this.#failures.push(error);
        throw error;
      }
    };
    reader.releaseLock = () => {
      try {
        release();
      } catch (error) {
        this.#failures.push(error);
        throw error;
      } finally {
        retired.resolve();
      }
    };
  }

  async #ready(): Promise<void> {
    const { signal } = this.options;
    let last: unknown;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      signal.throwIfAborted();
      try {
        const info = await abortable(this.client.server.info(this.options), signal);
        if (
          typeof info?.version === "string" &&
          info.version.startsWith("2.") &&
          typeof info.pid === "number" &&
          Array.isArray(info.urls) &&
          typeof info.paths?.tmp === "string"
        )
          return;
        last = new Error("OpenCode readiness requires native v2 server identity");
      } catch (error) {
        last = error;
      }
      await abortableDelay(100, signal);
    }
    throw new Error(`OpenCode server did not become ready within 10000ms: ${String(last)}`);
  }

  async next(): Promise<IteratorResult<V2Event>> {
    this.#io.signal.throwIfAborted();
    const next = await (this.#reading = this.#iterator!.next());
    // Effect stream-failure payloads can be yielded by the generated SDK.
    if (!next.done && typeof next.value?.type !== "string") throw new Error("OpenCode native event feed failed");
    return next;
  }

  /** The attempt's Turn gate settles when explicit native control begins. */
  onControl(observer: (kind: "abort" | "forceDispose") => void): void {
    this.#control = observer;
  }

  async #abort(): Promise<void> {
    this.#control?.("abort");
    // Keep the connection alive for the native response, even if the feed
    // publishes the execution terminal first.
    if (this.#retiring === undefined && this.sessionID !== undefined)
      this.#interrupt ??= this.client.session.interrupt({ sessionID: this.sessionID, resume: false });
    await this.#retireAfterInterrupt();
  }

  #forceDispose(): Promise<void> {
    this.#control?.("forceDispose");
    return this.#retireAfterInterrupt();
  }

  async #retireAfterInterrupt(): Promise<void> {
    const interrupt = this.#interrupt;
    try {
      await this.finish();
    } catch (retirement) {
      // A failed control response stays visible even when retirement also failed.
      if (interrupt === undefined) throw retirement;
      try {
        await interrupt;
      } catch (control) {
        throw new AggregateError([control, retirement], "OpenCode interrupt and runtime retirement failed");
      }
      throw retirement;
    }
    await interrupt;
  }

  async finish(): Promise<string | undefined> {
    const interrupt = this.#interrupt;
    const cancelled = this.options.signal.aborted;
    if (interrupt !== undefined) await interrupt.catch(() => undefined); // Abort reports native control failure.
    await this.retire();
    if (interrupt !== undefined) return "OpenCode session interrupted";
    return cancelled ? "OpenCode session force-disposed" : undefined;
  }

  retire(): Promise<void> {
    if (this.#retiring === undefined) {
      this.#retiring = Promise.resolve().then(async () => {
        this.#io.abort();
        const outcomes = await Promise.allSettled([
          Promise.resolve().then(() => this.#dispatcher?.destroy()),
          this.#server?.then(
            async ({ server }) => {
              await server.terminate();
              await server.exited;
            },
            () => undefined,
          ), // Launch failure already belongs to establishment.
          this.#reading?.catch(() => undefined), // Observation, not cleanup failure.
          Promise.resolve().then(() => this.#iterator?.return?.()),
          this.#readerRetired,
        ]);
        for (const outcome of outcomes) if (outcome.status === "rejected") this.#failures.push(outcome.reason);
        if (this.#failures.length > 0)
          throw new AggregateError(
            this.#failures,
            `OpenCode retirement failed: ${this.#failures.map(String).join("; ")}`,
          );
      });
      void this.#retiring.then(this.#closed.resolve, this.#closed.reject);
    }
    return this.#retiring;
  }
}
