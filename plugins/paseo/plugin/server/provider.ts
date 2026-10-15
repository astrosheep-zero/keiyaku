import { realpath } from "node:fs/promises";
import { z } from "zod";
import { negotiateProviderCapabilities, type ProviderConnection, type ProviderEvent, type ProviderPrompt, type ProviderRegistration } from "@getpaseo/plugin/server/provider";
import type { History } from "./keiyaku.js";
import type { AkumaTransport } from "./transport.js";
import { messageText, tellPresentation } from "./message.js";
import { createMirror } from "./mirror.js";
import { modelConfig } from "./model.js";
import type { StopAttempt } from "./stop.js";

const identity = z.object({ world: z.string().min(1), akuId: z.string().regex(/^aku\//u) });
export function createProvider(transport: AkumaTransport) {
  const sessions = new Set<{ world: string; akuId: string; observe(reannounce?: boolean): Promise<void>; stop(): Promise<void> }>();
  const provider: ProviderRegistration = {
    id: "keiyaku", label: "Keiyaku", description: "Akuma runtime mirror",
    async connect(request): Promise<ProviderConnection> {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      const capabilities = negotiateProviderCapabilities(request.capabilities, ["session.persistence", "prompt.message", "prompt.steer"]);
      const listeners = new Set<(event: ProviderEvent) => void>();
      const local = new Map<string, { stop(): Promise<void>; stopExecution(requestId: string): Promise<void>; prompt(prompt: ProviderPrompt): Promise<void> }>();
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
            // The opening window seeds retained state instead of announcing it.
            const skipRetained = input.history === "skip";
            let opening = true;
            let pending = false;
            let pendingReannounce = false;
            let running: Promise<void> | undefined;
            let observed: Readonly<{ cancel(): void; pulling: Promise<void> }> | undefined;
            const submissions = new Set<Promise<void>>();
            let stopping: Promise<StopAttempt> | undefined;
            // Release the live subscription. Its pending frame settles as
            // released and is never published into the next observation.
            const releaseObservation = (): void => {
              const current = observed;
              observed = undefined;
              current?.cancel();
            };
            /**
             * Observe the current window once, then keep pulling its changes.
             * A slow pull only bounds the next frame: no producer queue exists
             * here and no timer retries a failure. A failed or ended
             * subscription keeps the previous display and waits for the next
             * explicit refresh, which opens a fresh observation.
             */
            async function observeWindow(announce: boolean): Promise<void> {
              releaseObservation();
              if (cancellation.signal.aborted) return;
              const controller = new AbortController();
              const relay = () => controller.abort(cancellation.signal.reason);
              cancellation.signal.addEventListener("abort", relay, { once: true });
              const iterator = transport.stream(world, target.akuId, controller.signal)[Symbol.asyncIterator]();
              const entry = { cancel: () => {
                cancellation.signal.removeEventListener("abort", relay);
                controller.abort();
              }, pulling: Promise.resolve() };
              observed = entry;
              const publish = (history: History, reannounce: boolean): void => {
                if (cancellation.signal.aborted || observed !== entry) return;
                if (opening && skipRetained) mirror.seed(history);
                else mirror.publish(history, reannounce);
              };
              try {
                const first = await iterator.next();
                if (first.done) {
                  if (observed === entry) mirror.unreadable();
                  return;
                }
                publish(first.value, announce);
              } catch {
                if (observed === entry && !cancellation.signal.aborted) mirror.unreadable();
                return;
              } finally {
                opening = false;
              }
              entry.pulling = (async () => {
                for (;;) {
                  let frame: IteratorResult<History>;
                  try {
                    frame = await iterator.next();
                  } catch {
                    // A released or failed observation never reports itself over
                    // the one that replaced it.
                    if (observed === entry && !cancellation.signal.aborted) mirror.unreadable();
                    return;
                  }
                  if (observed !== entry) return;
                  if (frame.done) {
                    mirror.unreadable();
                    return;
                  }
                  publish(frame.value, false);
                }
              })();
            }
            // Every explicit refresh, Tell and Stop synchronization reopens the
            // one observation instead of reading beside it, so a late result can
            // never overwrite a newer snapshot, and hints coalesce into one.
            function observe(reannounce = false): Promise<void> {
              if (cancellation.signal.aborted) return Promise.resolve();
              pending = true;
              pendingReannounce ||= reannounce;
              running ??= (async () => {
                while (pending && !cancellation.signal.aborted) {
                  pending = false;
                  const announce = pendingReannounce;
                  pendingReannounce = false;
                  await observeWindow(announce);
                }
              })().finally(() => { running = undefined; });
              return running;
            }
            const session = {
              world, akuId: target.akuId,
              observe,
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
                    const admitted = tellPresentation(await transport.tell(world, target.akuId, cancellation.signal, text), steerTurnId);
                    // Observe once while publication is held. An idle send may have
                    // started real work even when its receipt still says pending.
                    await session.observe();
                    mirror.admit(admitted.row, prompt.clientMessageId);
                    const observed = mirror.refreshedTurnId();
                    respond(admitted.result.type === "completed" && observed !== undefined
                      ? { type: "turn", turnId: observed } : admitted.result);
                  } catch (error) {
                    const failure = new Error(`${error instanceof Error ? error.message : String(error)}. Input may already be recorded; not retried.`);
                    respond({ type: "failed", error: { message: failure.message } });
                    await session.observe();
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
                const closing = observed;
                releaseObservation();
                sessions.delete(session);
                local.delete(input.sessionId);
                await Promise.allSettled([...submissions]);
                await stopping;
                await running;
                await closing?.pulling;
                emit({ type: "session.closed", sessionId: input.sessionId });
              },
              stopExecution,
            };
            async function attemptStop(): Promise<StopAttempt> {
              if (cancellation.signal.aborted)
                return { kind: "uncertain", message: "Keiyaku could not prove the stop: the mirror closed before it was attempted" };
              const observed = mirror.observedTurn();
              let attempt: StopAttempt;
              try {
                attempt = await transport.stop(world, target.akuId, cancellation.signal);
              } catch (error) {
                attempt = { kind: "uncertain", message: `Keiyaku could not prove the stop: ${error instanceof Error ? error.message : String(error)}` };
              }
              await session.observe();
              if (attempt.kind === "stopped")
                observed?.cancel("Akuma execution was stopped from Paseo; the Akuma is preserved for a later Tell");
              return attempt;
            }
            async function stopExecution(requestId: string): Promise<void> {
              stopping ??= attemptStop().finally(() => { stopping = undefined; });
              const attempt = await stopping;
              if (attempt.kind === "stopped") emit({ type: "request.completed", requestId });
              else emit({ type: "request.failed", requestId, error: { message: attempt.message } });
            }
            sessions.add(session);
            local.set(input.sessionId, session);
            emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId,
              capabilities, restoration: "core", cwd: input.config.cwd,
              persistence: { version: 1, data: { world, akuId: target.akuId } } });
            {
              try {
                const observed = await transport.status(world, target.akuId, cancellation.signal);
                if (!cancellation.signal.aborted) emit({ type: "session.config", sessionId: input.sessionId, config: modelConfig(observed) });
              } catch (error) {
                if (!cancellation.signal.aborted) emit({ type: "session.notice", sessionId: input.sessionId, notice: {
                  id: "keiyaku:model", severity: "warning", title: "Akuma model unavailable",
                  description: error instanceof Error ? error.message : String(error),
                } });
              }
            }
            // Ready names the first observed window, or the explicit report that
            // none could be read. It never waits for the observation to end.
            await session.observe();
            if (!cancellation.signal.aborted) emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
          } else if (input.type === "session.interrupt" || input.type === "session.close") {
            const session = local.get(input.sessionId);
            if (input.type === "session.close") {
              await session?.stop();
              emit({ type: "request.completed", requestId: input.requestId });
            } else if (session === undefined) {
              emit({ type: "request.failed", requestId: input.requestId,
                error: { message: "Keiyaku mirror session is not open" } });
            } else await session.stopExecution(input.requestId);
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
        void session.observe();
        woken++;
      }
      return { woken };
    },
    async sync(input: { world: string; akuId: string }) {
      const world = await realpath(input.world);
      await Promise.all([...sessions].filter((session) => session.world === world && session.akuId === input.akuId)
        .map((session) => session.observe(true)));
    },
    async close() { await Promise.all([...sessions].map((session) => session.stop())); },
  };
}
