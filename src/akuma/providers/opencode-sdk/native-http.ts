import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { Agent } from "undici";
import { object } from "../decode.js";

/** The matching native SDK owns the dialect; this attempt owns its HTTP connections. */
export function createNativeClient(
  baseUrl: string,
  password: string,
): Readonly<{
  sdk: OpenCodeClient;
  subscribe(signal: AbortSignal): Promise<Readonly<{ stream: AsyncIterable<unknown> }>>;
  close(): Promise<void>;
}> {
  const dispatcher = new Agent();
  const controller = new AbortController();
  // Node's fetch accepts an Undici dispatcher in addition to standard RequestInit.
  // Keep that native extension at this one SDK seam.
  const ownedFetch: typeof globalThis.fetch = (input, init) => {
    controller.signal.throwIfAborted();
    const options: RequestInit & { dispatcher: Agent } = {
      ...init,
      dispatcher,
      signal: init?.signal == null ? controller.signal : AbortSignal.any([controller.signal, init.signal]),
    };
    return globalThis.fetch(input, options);
  };
  const sdk = OpenCode.make({
    baseUrl,
    fetch: ownedFetch,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  });
  const subscribe = async (signal: AbortSignal): Promise<Readonly<{ stream: AsyncIterable<unknown> }>> => {
    const iterator = sdk.event.subscribe({ signal })[Symbol.asyncIterator]();
    try {
      // The producer subscribes before emitting this frame. Headers alone are
      // not a barrier against losing the opening native admission broadcast.
      const connected = await iterator.next();
      if (connected.done || object(connected.value)?.type !== "server.connected") {
        throw new Error("OpenCode event feed did not confirm subscription");
      }
    } catch (error) {
      await iterator.return?.();
      throw error;
    }
    return {
      stream: {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            const next = await iterator.next();
            // Effect stream-failure frames are not native events. The generated
            // SDK parser can yield their payload; never drop that into narration.
            if (!next.done && typeof object(next.value)?.type !== "string") {
              throw new Error("OpenCode native event feed failed");
            }
            return next;
          },
          return: () => iterator.return?.() ?? Promise.resolve({ done: true as const, value: undefined }),
        }),
      },
    };
  };
  let closing: Promise<void> | undefined;
  return {
    sdk,
    subscribe,
    close: (): Promise<void> => {
      closing ??= (async () => {
        controller.abort();
        // SDK iterator retirement is logical. Dispatcher destruction separately
        // awaits closure of every socket, including requests aborted during setup.
        await dispatcher.destroy();
      })();
      return closing;
    },
  };
}
