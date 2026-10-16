import { realpath } from "node:fs/promises";
import { resolvePaseoHome, waitForDaemonReady, readLocalCredentialForTarget } from "@getpaseo/server/daemon-control";
import { buildDaemonWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import WebSocket from "ws";
import type { KeiyakuPlugin } from "@astrosheep/keiyaku/plugin";
import { observeKanshi, World } from "@astrosheep/keiyaku";

const refreshRpc = defineRpc({ name: "refresh",
  input: z.object({ world: z.string(), akuId: z.string() }),
  output: z.object({ woken: z.number().int().nonnegative() }),
});
const attachRpc = defineRpc({ name: "attach",
  input: z.object({ world: z.string(), akuId: z.string(), caller: z.union([
    z.object({ kind: z.literal("akuma"), world: z.string(), akuId: z.string() }),
    z.object({ kind: z.literal("external"), integration: z.string(), id: z.string() }),
    z.object({ kind: z.literal("unknown") }),
  ]).optional() }),
  output: z.object({ attached: z.boolean() }),
});
type Client = Pick<DaemonClient, "invokePluginRpc" | "fetchAgents" | "updateAgent" | "close">;
const mirrorPersistence = z.object({ version: z.literal(1),
  data: z.object({ world: z.string(), akuId: z.string() }) });

// Rename only: this is also the one-shot backfill path for existing mirrors.
export async function syncMirrorTitles(client: Pick<Client, "fetchAgents" | "updateAgent">,
  path: string, akuId?: string, signal?: AbortSignal): Promise<number> {
  const world = await World.prove(await realpath(path));
  signal?.throwIfAborted();
  const { aliases } = await observeKanshi({ world });
  if (aliases.kind !== "present") throw new Error(`Keiyaku aliases unavailable: ${aliases.kind === "failed" ? aliases.failure.message : "absent"}`);
  const names = new Map<string, string[]>();
  for (const binding of aliases.value) {
    const current = names.get(binding.akuId) ?? [];
    current.push(binding.alias.replace(/^@/u, ""));
    names.set(binding.akuId, current);
  }
  const updates: { id: string; name: string }[] = [];
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const filter = { includeArchived: true };
    const page = await client.fetchAgents({ filter, ...(signal ? { signal } : {}),
      page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const { agent } of page.entries) {
      if (agent.provider !== "keiyaku" || agent.persistence?.provider !== "keiyaku") continue;
      // Paseo exposes our provider's versioned persistence in public snapshot metadata.
      // Do not decode opaque session IDs or inspect the daemon's storage.
      const parsed = mirrorPersistence.safeParse(agent.persistence.metadata?.pluginProviderPersistence);
      if (!parsed.success || (akuId !== undefined && parsed.data.data.akuId !== akuId)) continue;
      const target = parsed.data.data;
      if (target.world !== world) continue;
      const bound = names.get(target.akuId);
      const title = bound?.length ? `${target.akuId} (${bound.join(", ")})` : target.akuId;
      if (agent.title === title) continue;
      updates.push({ id: agent.id, name: title });
    }
    if (!page.pageInfo.hasMore) break;
    const next = page.pageInfo.nextCursor;
    if (!next || next === cursor) throw new Error("Incomplete mirror directory pagination");
    cursor = next;
  } while (cursor);
  // Finish directory pagination before renames can reorder its entries.
  for (const update of updates) {
    signal?.throwIfAborted();
    await client.updateAgent(update.id, { name: update.name });
  }
  return updates.length;
}
async function connect(signal: AbortSignal): Promise<Client> {
  const home = resolvePaseoHome({ PASEO_HOME: process.env.PASEO_HOME });
  const { listen } = await waitForDaemonReady(home, { timeoutMs: 1000, signal });
  if (/^(unix|pipe):\/\//u.test(listen)) throw new Error("Paseo hints require a TCP listen address");
  const token = readLocalCredentialForTarget(home, listen);
  signal.throwIfAborted();
  const client = new DaemonClient({ url: buildDaemonWebSocketUrl(listen, { useTls: false }),
    clientId: "keiyaku-paseo-bridge", clientType: "cli", localCredential: () => token ?? undefined,
    connectTimeoutMs: 1000, reconnect: { enabled: false },
    webSocketFactory: (url, cfg) => new WebSocket(url, cfg?.protocols, { headers: cfg?.headers }) as unknown as WebSocketLike });
  const abort = () => { void client.close(); };
  signal.addEventListener("abort", abort, { once: true });
  try { await client.connect(); signal.throwIfAborted(); return client; }
  catch (error) { await client.close(); throw error; }
  finally { signal.removeEventListener("abort", abort); }
}

// A title attempt owns its short-lived connection, so canceling it cannot retire
// the successful runtime RPC connection. Close and all in-flight work are awaited.
export async function backfillMirrorTitles(path: string, akuId?: string,
  signal: AbortSignal = AbortSignal.timeout(30_000),
  openClient: (signal: AbortSignal) => Promise<Client> = connect): Promise<number> {
  const connected = await openClient(signal);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= connected.close();
  const abort = () => { void close().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    return await syncMirrorTitles(connected, path, akuId, signal);
  } finally {
    signal.removeEventListener("abort", abort);
    await close();
  }
}

export function createForwarder(openClient: (signal: AbortSignal) => Promise<Client> = connect): KeiyakuPlugin {
  return {
    manifest: { id: "paseo", apiVersion: 1 },
    async activate(context) {
      const world = await realpath(context.world);
      let client: Promise<Client> | undefined;
      const hint = async (rpc: typeof refreshRpc | typeof attachRpc, input: z.input<typeof attachRpc.input>, cancellation?: AbortSignal) => {
        const signal = AbortSignal.any([AbortSignal.timeout(1500), ...(cancellation ? [cancellation] : [])]);
        signal.throwIfAborted();
        const pending = client ??= openClient(signal);
        let abort!: () => void;
        try {
          return await Promise.race([
            (async () => {
              const connected = await pending;
              signal.throwIfAborted();
              return rpc.output.parse(await connected.invokePluginRpc("keiyaku-paseo", rpc.name, rpc.input.parse(input)));
            })(),
            new Promise<never>((_, reject) => {
              abort = () => reject(signal.reason);
              signal.addEventListener("abort", abort, { once: true });
            }),
          ]);
        } catch (error) {
          if (client === pending) client = undefined;
          void pending.then((connected) => connected.close()).catch(() => {});
          // The host owns the single diagnostic and non-authoritative silence.
          throw error;
        } finally { signal.removeEventListener("abort", abort); }
      };
      const refresh = async (event: { akumaId: string }, cancellation?: AbortSignal) => {
        await hint(refreshRpc, { world, akuId: event.akumaId }, cancellation);
      };
      return { signals: { "akuma.turn-started": refresh, "akuma.turn-outcome": refresh,
        async "akuma.born"(event, cancellation) {
          const result = await hint(attachRpc, { world, akuId: event.akumaId, caller: event.caller }, cancellation);
          if (!("attached" in result) || !result.attached) return;
          const signal = AbortSignal.any([AbortSignal.timeout(1500), ...(cancellation ? [cancellation] : [])]);
          try { await backfillMirrorTitles(world, event.akumaId, signal, openClient); }
          catch (error) { console.warn(`Keiyaku mirror attached, but title synchronization failed: ${error instanceof Error ? error.message : String(error)}`); }
        },
        async "akuma.body-ended"(event, cancellation) {
          try { await refresh(event, cancellation); }
          finally {
            const previous = client; client = undefined;
            await previous?.then((connected) => connected.close()).catch(() => {});
          }
        },
      } };
    },
  };
}
export default createForwarder();
