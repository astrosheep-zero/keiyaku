import { realpath } from "node:fs/promises";
import { z } from "zod";
import { negotiateProviderCapabilities, type ProviderConnection, type ProviderEvent, type ProviderPrompt, type ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { readKeiyaku, runKeiyaku, type CommandRunner, type Reader } from "./keiyaku.js";
import { messageText, sendMessage } from "./message.js";
import { createMirror } from "./mirror.js";

const identity = z.object({ world: z.string().min(1), akuId: z.string().regex(/^aku\//u) });
export function createProvider(reader: Reader = readKeiyaku, command: CommandRunner = runKeiyaku) {
  const sessions = new Set<{ world: string; akuId: string; wake(): Promise<void>; stop(): Promise<void> }>();
  const provider: ProviderRegistration = {
    id: "keiyaku", label: "Keiyaku", description: "Akuma runtime mirror",
    async connect(request): Promise<ProviderConnection> {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      const capabilities = negotiateProviderCapabilities(request.capabilities, ["session.persistence", "prompt.message", "prompt.steer"]);
      const listeners = new Set<(event: ProviderEvent) => void>();
      const local = new Map<string, { stop(): Promise<void>; cancel(reason: string): void; prompt(prompt: ProviderPrompt): Promise<void> }>();
      let closed = false;
      const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
      return {
        version: 1, capabilities,
        onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        async send(input) {
          if (closed) throw new Error("Provider connection is closed");
          if (input.type === "catalog") {
            emit({ type: "catalog", requestId: input.requestId, catalog: {
              models: [{ id: "mirror", label: "Akuma mirror" }], defaultModel: "mirror", modes: [],
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
            const submissions = new Set<Promise<void>>();
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
              async prompt(prompt: ProviderPrompt) {
                const respond = (result: Extract<ProviderEvent, { type: "session.prompt_result" }>["result"]) => emit({
                  type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: prompt.clientMessageId, result,
                });
                let text: string;
                try {
                  cancellation.signal.throwIfAborted();
                  text = messageText(prompt);
                } catch (error) {
                  const failure = error instanceof Error ? error : new Error(String(error));
                  respond({ type: "failed", error: { message: failure.message } });
                  throw failure;
                }
                const steerTurnId = prompt.delivery === "steer" ? mirror.currentTurnId() : undefined;
                if (prompt.delivery === "steer" && steerTurnId === undefined) {
                  const failure = new Error("No observed Paseo Turn for steering; Tell was not submitted");
                  respond({ type: "failed", error: { message: failure.message } });
                  throw failure;
                }
                const release = mirror.hold();
                const submission = (async () => {
                  try {
                    const admitted = await sendMessage(command, world, target.akuId, cancellation.signal, text, steerTurnId);
                    // Read once while publication is held. An idle send may have
                    // started real work even when its receipt still says pending.
                    await session.wake();
                    mirror.admit(admitted.row, prompt.clientMessageId);
                    const observed = mirror.refreshedTurnId();
                    respond(admitted.result.type === "completed" && observed !== undefined
                      ? { type: "turn", turnId: observed } : admitted.result);
                  } catch (error) {
                    const failure = new Error(`${error instanceof Error ? error.message : String(error)}. Input may already be recorded; not retried.`);
                    respond({ type: "failed", error: { message: failure.message } });
                    await session.wake();
                    // Do not let the host treat an uncertain write as "unavailable"
                    // and replace execution before resubmitting the same text.
                    throw failure;
                  } finally {
                    release(!cancellation.signal.aborted);
                  }
                })();
                submissions.add(submission);
                try { await submission; } finally { submissions.delete(submission); }
              },
              async stop() {
                mirror.cancel("Observation closed; Akuma was not interrupted");
                cancellation.abort();
                sessions.delete(session);
                local.delete(input.sessionId);
                await Promise.allSettled([...submissions]);
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
            const session = local.get(input.sessionId);
            if (session) await session.prompt(input.prompt);
            else emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId,
              result: { type: "failed", error: { message: "Keiyaku mirror session is not open" } } });
          } else if ("requestId" in input) {
            emit({ type: "request.failed", requestId: input.requestId, error: { message: "Unsupported Keiyaku mirror operation" } });
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
