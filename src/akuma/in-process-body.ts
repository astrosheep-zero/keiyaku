import type { ProviderAdapter } from "./provider.js";
import { driveAkumaBody, type BodyRuntime } from "./body.js";
import { abortable } from "./abort.js";
import type { BodyLaunch, LiveBodyLaunch } from "./body-launch.js";

/** One owned Body in this Node runtime; preparation starts only after custody is returned. */
export async function launchInProcessBody(
  launch: BodyLaunch,
  prepare: (
    signal: AbortSignal,
  ) => Promise<Pick<BodyRuntime, "world" | "externalCommands" | "spawn" | "requestSpawn" | "executionAssociation">>,
  adapter?: ProviderAdapter,
  scopeSignal?: AbortSignal,
): Promise<LiveBodyLaunch> {
  const controller = new AbortController();
  const forced = new AbortController();
  // Scope custody is independent of the publication holder's release below.
  const closeScope = (): void => {
    forced.abort();
    controller.abort(scopeSignal?.reason);
  };
  scopeSignal?.addEventListener("abort", closeScope, { once: true });
  if (scopeSignal?.aborted) closeScope();
  let released = false;
  // A pending SDK/setup Promise alone does not keep Node alive. Release is not
  // detachment: this Body retains the calling runtime until its drive finishes.
  const lifetime = setInterval(() => {}, 1_073_741_824);
  const completed = Promise.resolve()
    .then(async () => {
      controller.signal.throwIfAborted();
      const runtime = await abortable(prepare(controller.signal), controller.signal);
      controller.signal.throwIfAborted();
      const result = await driveAkumaBody(launch, adapter, {
        ...runtime,
        signal: controller.signal,
        forceSignal: forced.signal,
      });
      if (result === "hung")
        throw new Error("in-process Body ended with hung provider custody; native work may still be running");
      return { diagnostic: "in-process Body completed", ...(result === "held" ? { held: true } : {}) };
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted && error === controller.signal.reason)
        return { diagnostic: "in-process Body launch canceled" };
      throw error;
    })
    .finally(() => {
      scopeSignal?.removeEventListener("abort", closeScope);
      clearInterval(lifetime);
    });
  void completed.catch(() => undefined);
  return {
    completed,
    async cancel(force = false) {
      if (released) return;
      if (force) forced.abort();
      controller.abort(new Error("in-process Body launch canceled"));
      await completed;
    },
    release() {
      released = true;
    },
  };
}
