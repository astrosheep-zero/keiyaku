import { realpath } from "node:fs/promises";
import { z } from "zod";
import { negotiateProviderCapabilities, type ProviderConnection, type ProviderEvent, type ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { readKeiyaku, type Reader } from "./keiyaku.js";
import { createMirror } from "./mirror.js";

const identity = z.object({ world: z.string().min(1), akuId: z.string().regex(/^aku\//u) });
export function createProvider(reader: Reader = readKeiyaku) {
  const sessions = new Set<{ world: string; akuId: string; wake(): Promise<void>; stop(): Promise<void> }>();
  const provider: ProviderRegistration = {
    id: "keiyaku", label: "Keiyaku", description: "Read-only Akuma mirror",
    async connect(request): Promise<ProviderConnection> {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      const capabilities = negotiateProviderCapabilities(request.capabilities, ["session.persistence"]);
      const listeners = new Set<(event: ProviderEvent) => void>();
      const local = new Map<string, { stop(): Promise<void>; cancel(reason: string): void }>();
      let closed = false;
      const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
      return {
        version: 1, capabilities,
        onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        async send(input) {
          if (closed) throw new Error("Provider connection is closed");
          if (input.type === "catalog") {
            emit({ type: "catalog", requestId: input.requestId, catalog: {
              models: [{ id: "mirror", label: "Akuma mirror（只读）" }], defaultModel: "mirror", modes: [],
            } });
          } else if (input.type === "session.open") {
            if (local.has(input.sessionId)) throw new Error("Session already open");
            if (input.persistence && input.persistence.version !== 1) throw new Error("Unsupported persistence version");
            const target = identity.parse(input.persistence?.data ?? input.config.providerOptions);
            const world = await realpath(target.world);
            const mirror = createMirror(input.sessionId, emit);
            const cancellation = new AbortController();
            let pending = false;
            let running: Promise<void> | undefined;
            const session = {
              world, akuId: target.akuId,
              wake(): Promise<void> {
                if (cancellation.signal.aborted) return Promise.resolve();
                pending = true;
                running ??= (async () => {
                  while (pending && !cancellation.signal.aborted) {
                    pending = false;
                    try {
                      const rows = await reader(world, target.akuId, cancellation.signal);
                      if (!cancellation.signal.aborted) mirror.publish(rows);
                    } catch {
                      if (!cancellation.signal.aborted) mirror.unreadable();
                    }
                  }
                })().finally(() => { running = undefined; });
                return running;
              },
              async stop() {
                mirror.cancel("Observation closed; Akuma was not interrupted");
                cancellation.abort();
                sessions.delete(session);
                local.delete(input.sessionId);
                await running;
                emit({ type: "session.closed", sessionId: input.sessionId });
              },
              cancel: mirror.cancel,
            };
            sessions.add(session);
            local.set(input.sessionId, session);
            emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId,
              capabilities, restoration: "core", cwd: input.config.cwd,
              persistence: { version: 1, data: { world, akuId: target.akuId } } });
            await session.wake();
            if (!cancellation.signal.aborted) emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
          } else if (input.type === "session.interrupt" || input.type === "session.close") {
            const session = local.get(input.sessionId);
            if (input.type === "session.close") await session?.stop();
            else session?.cancel("Observation canceled; Akuma was not interrupted");
            emit({ type: "request.completed", requestId: input.requestId });
          } else if (input.type === "session.prompt") {
            emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId,
              result: { type: "failed", error: { message: "Keiyaku mirrors are read-only" } } });
          } else if ("requestId" in input) {
            emit({ type: "request.failed", requestId: input.requestId, error: { message: "Keiyaku mirrors are read-only" } });
          }
        },
        async close() {
          await Promise.all([...local.values()].map((session) => session.stop()));
          closed = true;
          listeners.clear();
        },
      };
    },
  };
  return {
    provider,
    async refresh(input: { world: string; akuId: string }) {
      const world = await realpath(input.world);
      let woken = 0;
      for (const session of sessions) if (session.world === world && session.akuId === input.akuId) {
        void session.wake();
        woken++;
      }
      return { woken };
    },
    async close() { await Promise.all([...sessions].map((session) => session.stop())); },
  };
}
