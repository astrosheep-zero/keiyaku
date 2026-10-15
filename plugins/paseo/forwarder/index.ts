import { realpath } from "node:fs/promises";
import { resolvePaseoHome, waitForDaemonReady, readLocalCredentialForTarget } from "@getpaseo/server/daemon-control";
import { buildDaemonWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import WebSocket from "ws";
import type { KeiyakuPlugin } from "@astrosheep/keiyaku/plugin";

const refreshRpc = defineRpc({ name: "refresh",
  input: z.object({ world: z.string(), akuId: z.string() }),
  output: z.object({ woken: z.number().int().nonnegative() }),
});
type Client = Pick<DaemonClient, "invokePluginRpc" | "close">;
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

export function createForwarder(openClient: (signal: AbortSignal) => Promise<Client> = connect): KeiyakuPlugin {
  return {
    manifest: { id: "paseo", apiVersion: 1 },
    async activate(context) {
      const world = await realpath(context.world);
      let client: Promise<Client> | undefined;
      const hint = async (event: { akumaId: string }, cancellation?: AbortSignal): Promise<void> => {
        const signal = AbortSignal.any([AbortSignal.timeout(1500), ...(cancellation ? [cancellation] : [])]);
        signal.throwIfAborted();
        const pending = client ??= openClient(signal);
        let abort!: () => void;
        try {
          await Promise.race([
            (async () => {
              const connected = await pending;
              signal.throwIfAborted();
              refreshRpc.output.parse(await connected.invokePluginRpc("keiyaku-paseo", refreshRpc.name,
                refreshRpc.input.parse({ world, akuId: event.akumaId })));
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
      return { signals: { "akuma.turn-started": hint, "akuma.turn-outcome": hint,
        async "akuma.body-ended"(event, cancellation) {
          try { await hint(event, cancellation); }
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
