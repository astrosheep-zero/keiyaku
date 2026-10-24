import type { SessionCreateInput, SessionSwitchModelInput } from "@opencode/client";
import { SessionMessage } from "@opencode/schema/session-message";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { abortable } from "../../abort.js";
import { akumaExecutionEnvironment } from "../execution-environment.js";
import { spawnDetachedProcess } from "../../../runtime/proc/run.js";
import type { ResumeCoordinate } from "../../heart/index.js";
import type { ProviderExecution } from "../../provider-recipe.js";
import { object } from "../decode.js";
import { createNativeClient } from "./native-http.js";

export type OpencodeSdkSession = Readonly<{
  create(input: { body: SessionCreateInput }): Promise<unknown>;
  get(input: { id: string }): Promise<unknown>;
  switchModel(input: { id: string; model: SessionSwitchModelInput["model"] }): Promise<unknown>;
  instructions(input: { id: string; text: string }): Promise<unknown>;
  active(): Promise<unknown>;
  fork(input: { id: string; before: string }): Promise<unknown>;
  interrupt(input: { id: string }): Promise<unknown>;
  prompt(input: { id: string; body: { id: string; text: string } }): Promise<unknown>;
  message(input: { id: string; messageID: string }): Promise<unknown>;
}>;
export type OpencodeEventSubscriptionRequest = Readonly<{ directory: string; signal: AbortSignal }>;
export type OpencodeSdkEvent = Readonly<{
  subscribe(request: OpencodeEventSubscriptionRequest): Promise<Readonly<{ stream: AsyncIterable<unknown> }>>;
}>;
export type OpencodeSdkLoader = (
  cwd: string,
  execution: ProviderExecution,
  signal: AbortSignal,
) => Promise<
  Readonly<{
    client: { session: OpencodeSdkSession; event: OpencodeSdkEvent };
    close?: () => Promise<void> | void;
    ready?: Promise<void>;
  }>
>;
export const OPENCODE_SDK_PROVIDER = "opencode-sdk" as const;

export function messageId(): string {
  return SessionMessage.ID.create();
}
export function parseModel(model: string): Readonly<{ providerID: string; id: string }> {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) throw new Error("OpenCode model must be <provider>/<model>");
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

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
export type OpencodeRuntime = Readonly<{
  client: { session: OpencodeSdkSession; event: OpencodeSdkEvent };
  close: () => Promise<void>;
}>;

/** A successful HTML fallback, or a JSON response from another API, is not readiness. */
export async function waitReady(json: (path: string) => Promise<unknown>, signal: AbortSignal): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    signal.throwIfAborted();
    try {
      const info = object(await abortable(json("/api/info"), signal));
      if (
        typeof info?.version !== "string" ||
        !info.version.startsWith("2.") ||
        typeof info.pid !== "number" ||
        !Array.isArray(info.urls) ||
        typeof object(info.paths)?.tmp !== "string"
      ) {
        throw new Error("OpenCode readiness requires native v2 server identity");
      }
      return;
    } catch (error) {
      last = error;
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`OpenCode server did not become ready within 10000ms: ${String(last)}`);
}
async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("OpenCode port unavailable"));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}
type LoadOpencodeInput = Readonly<{
  execution: ProviderExecution;
  cwd: string;
  signal: AbortSignal;
  loader?: OpencodeSdkLoader;
  onRuntime?: (runtime: OpencodeRuntime) => void;
  requests?: string;
}>;
export async function loadOpencode(input: LoadOpencodeInput): Promise<OpencodeRuntime> {
  const { loader } = input;
  return loader === undefined ? loadNativeOpencode(input) : loadInjectedOpencode(input, loader);
}
async function loadInjectedOpencode(input: LoadOpencodeInput, loader: OpencodeSdkLoader): Promise<OpencodeRuntime> {
  const { execution, cwd, signal, onRuntime, requests } = input;
  const loaded = await abortable(
    loader(
      cwd,
      {
        ...execution,
        env: akumaExecutionEnvironment(process.env, execution.env, requests),
      },
      signal,
    ),
    signal,
  );
  let closing: Promise<void> | undefined;
  const runtime = {
    client: loaded.client,
    close: () =>
      (closing ??= Promise.resolve()
        .then(() => loaded.close?.())
        .then(() => undefined)),
  };
  onRuntime?.(runtime);
  try {
    if (loaded.ready !== undefined) await abortable(loaded.ready, signal);
    signal.throwIfAborted();
    return runtime;
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
async function loadNativeOpencode(input: LoadOpencodeInput): Promise<OpencodeRuntime> {
  const { execution, cwd, signal, onRuntime, requests } = input;
  const port = await availablePort();
  signal.throwIfAborted();
  const password =
    execution.env?.OPENCODE_PASSWORD ??
    execution.env?.OPENCODE_SERVER_PASSWORD ??
    randomBytes(32).toString("base64url");
  const config = composeHeadlessPermissionConfig(execution.config);
  const owned = await spawnDetachedProcess({
    argv: [execution.executable ?? "opencode", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
    cwd,
    env: akumaExecutionEnvironment(
      process.env,
      {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        ...execution.env,
        OPENCODE_PASSWORD: password,
        OPENCODE_SERVER_PASSWORD: password,
      },
      requests,
    ),
    log: `${cwd}/.opencode.log`,
  });
  const native = createNativeClient(`http://127.0.0.1:${port}`, password);
  let closing: Promise<void> | undefined;
  const options = { signal };
  const runtime: OpencodeRuntime = {
    client: {
      session: {
        create: async ({ body }) => ({ data: await native.sdk.session.create(body, options) }),
        get: async ({ id }) => ({ data: await native.sdk.session.get({ sessionID: id }, options) }),
        switchModel: ({ id, model }) => native.sdk.session.switchModel({ sessionID: id, model }, options),
        instructions: ({ id, text }) =>
          native.sdk.session.instructions.entry.put({ sessionID: id, key: "keiyaku.system", value: text }, options),
        active: async () => ({ data: await native.sdk.session.active(options) }),
        fork: async ({ id, before }) => ({ data: await native.sdk.session.fork({ sessionID: id, before }, options) }),
        interrupt: ({ id }) => native.sdk.session.interrupt({ sessionID: id, resume: false }),
        prompt: async ({ id, body }) => ({
          data: await native.sdk.session.prompt({ sessionID: id, ...body }, options),
        }),
        message: async ({ id, messageID }) => ({
          data: await native.sdk.session.message.get({ sessionID: id, messageID }, options),
        }),
      },
      event: { subscribe: ({ signal }) => native.subscribe(signal) },
    },
    close: () => (closing ??= Promise.all([native.close(), owned.terminate()]).then(() => undefined)),
  };
  onRuntime?.(runtime);
  try {
    await waitReady(() => native.sdk.server.info({ signal }), signal);
    signal.throwIfAborted();
    return runtime;
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
export function coordinate(sessionId: string): ResumeCoordinate {
  return { sessionId };
}
