import net from "node:net";
import { abortable } from "../../abort.js";
import { spawnDetachedProcess } from "../../../runtime/proc/run.js";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import type { ResumeCoordinate } from "../../heart/index.js";
import { providerLaunchEnv, type ProviderExecution } from "../../provider-recipe.js";

export type OpencodeSdkSession = Pick<OpencodeClient["session"],
  "create" | "get" | "fork" | "abort" | "promptAsync" | "messages">;
export type OpencodeSdkEvent = Pick<OpencodeClient["event"], "subscribe">;
export type OpencodeSdkLoader = (cwd: string) => Promise<Readonly<{
  client: { session: OpencodeSdkSession; event: OpencodeSdkEvent };
  close?: () => Promise<void> | void;
}>>;

export const OPENCODE_SDK_PROVIDER = "opencode-sdk" as const;

export function parseModel(model: string): Readonly<{ providerID: string; modelID: string }> {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) throw new Error("OpenCode model must be <provider>/<model>");
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
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
      server.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}

export async function loadOpencode(
  execution: ProviderExecution,
  cwd: string,
  signal: AbortSignal,
  loader?: OpencodeSdkLoader,
): Promise<OpencodeRuntime> {
  if (loader) {
    const loaded = await loader(cwd);
    return { client: loaded.client, close: async () => { await loaded.close?.(); } };
  }
  const port = await availablePort();
  const owned = await spawnDetachedProcess({
    argv: [execution.executable ?? "opencode", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
    cwd,
    env: providerLaunchEnv(process.env, execution.env),
    log: `${cwd}/.opencode.log`,
  });
  const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}`, directory: cwd });
  try {
    await waitReady(client, cwd, signal);
  } catch (error) {
    await owned.terminate();
    throw error;
  }
  return { client, close: async () => { await owned.terminate(); } };
}

export function coordinate(sessionId: string): ResumeCoordinate { return { sessionId }; }
