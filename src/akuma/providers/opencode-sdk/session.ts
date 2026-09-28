import net from "node:net";
import { abortable } from "../../abort.js";
import { akumaExecutionEnvironment } from "../execution-environment.js";
import { spawnDetachedProcess } from "../../../runtime/proc/run.js";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { ResumeCoordinate } from "../../heart/index.js";
import type { ProviderExecution } from "../../provider-recipe.js";

export type OpencodeSdkSession = Pick<
  OpencodeClient["session"],
  "create" | "get" | "fork" | "abort" | "promptAsync" | "messages"
>;
export type OpencodeSdkEvent = Pick<OpencodeClient["event"], "subscribe">;
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

export function parseModel(model: string): Readonly<{ providerID: string; modelID: string }> {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) throw new Error("OpenCode model must be <provider>/<model>");
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/**
 * Permission classes whose upstream defaults can await a human reply. A headless
 * server has no reply channel, so such a pending ask never settles.
 *
 * Verified against the installed opencode 1.18.33 agent permission ruleset: the
 * primary agents start from `{"*":"allow"}` with `external_directory` and
 * `doom_loop` set to ask, `read` set to ask for `.env` files, and `question`
 * allowed (the question tool awaits an answer by semantics). Every other class
 * matches the allow-all rule and cannot await.
 */
const HEADLESS_PERMISSION_BASE: Readonly<Record<string, string>> = Object.freeze({
  external_directory: "allow",
  doom_loop: "allow",
  read: "allow",
  question: "deny",
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Compose the config handed to a headless opencode server. The permission base
 * layer fills only the classes the caller leaves unspecified: an explicit caller
 * permission key wins per key and every non-permission key passes through
 * untouched. A caller that supplies a non-object `permission` shorthand states
 * the whole policy and keeps it.
 */
export function composeHeadlessPermissionConfig(config?: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const permission = config?.permission;
  if (permission !== undefined && !isRecord(permission)) return { ...config };
  return { ...config, permission: { ...HEADLESS_PERMISSION_BASE, ...permission } };
}

export type OpencodeRuntime = Readonly<{
  client: { session: OpencodeSdkSession; event: OpencodeSdkEvent };
  close: () => Promise<void>;
}>;

async function waitReady(client: OpencodeClient, cwd: string, signal: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (signal.aborted) throw new Error("OpenCode startup aborted");
    try {
      await abortable(client.session.list({ query: { directory: cwd }, throwOnError: true }), signal);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("OpenCode server did not become ready within 10000ms");
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

export async function loadOpencode(
  input: Readonly<{
    execution: ProviderExecution;
    cwd: string;
    signal: AbortSignal;
    loader?: OpencodeSdkLoader;
    onRuntime?: (runtime: OpencodeRuntime) => void;
    requests?: string;
  }>,
): Promise<OpencodeRuntime> {
  const { execution, cwd, signal, loader, onRuntime, requests } = input;
  if (loader) {
    const loaded = await abortable(
      loader(cwd, { ...execution, env: akumaExecutionEnvironment(process.env, execution.env, requests) }, signal),
      signal,
    );
    let closing: Promise<void> | undefined;
    const runtime = {
      client: loaded.client,
      close: async () => {
        closing ??= Promise.resolve(loaded.close?.()).then(() => undefined);
        await closing;
      },
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
  const port = await availablePort();
  const owned = await spawnDetachedProcess({
    argv: [execution.executable ?? "opencode", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
    cwd,
    env: akumaExecutionEnvironment(
      process.env,
      {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(composeHeadlessPermissionConfig(execution.config)),
        ...execution.env,
      },
      requests,
    ),
    log: `${cwd}/.opencode.log`,
  });
  const { createOpencodeClient } = await import("@opencode-ai/sdk");
  const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}`, directory: cwd });
  let closing: Promise<void> | undefined;
  const runtime = {
    client,
    close: async () => {
      closing ??= owned.terminate();
      await closing;
    },
  };
  onRuntime?.(runtime);
  try {
    await waitReady(client, cwd, signal);
  } catch (error) {
    await runtime.close();
    throw error;
  }
  return runtime;
}

export function coordinate(sessionId: string): ResumeCoordinate {
  return { sessionId };
}
