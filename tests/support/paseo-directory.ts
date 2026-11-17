import type { OwnedSubscription, PaseoAgentListResult, SubscriptionObserver } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

type Snapshot = PaseoAgentListResult & { subscriptionId: string };
type Options = Parameters<DaemonClient["observeAgents"]>[0];

/** Current owned-directory contract: reconnect replaces the snapshot and ID;
 * ready resolves once, and late listeners receive the current snapshot. */
export function directorySubscriptions(fetch: (options: Options) => Promise<PaseoAgentListResult>) {
  let serial = 0, releases = 0;
  const active = new Set<{
    snapshot: Snapshot | undefined;
    observers: Set<SubscriptionObserver<Snapshot>>;
    disposed: boolean;
  }>();
  function observeAgents(options: Options): OwnedSubscription<PaseoAgentListResult> {
    const state = { snapshot: undefined as Snapshot | undefined, observers: new Set<SubscriptionObserver<Snapshot>>(), disposed: false };
    active.add(state);
    const ready = fetch(options).then((result) => {
      const snapshot = { ...result, subscriptionId: `directory-${++serial}` };
      if (!state.disposed) {
        state.snapshot = snapshot;
        for (const observer of state.observers) observer.snapshot(snapshot);
      }
      return snapshot;
    });
    void ready.catch(() => {});
    const subscription: OwnedSubscription<PaseoAgentListResult> = {
      get subscriptionId() { return state.snapshot?.subscriptionId ?? null; }, ready,
      subscribe(observer) {
        if (state.disposed) throw new Error("Subscription released");
        state.observers.add(observer);
        if (state.snapshot) observer.snapshot(state.snapshot);
        return () => { state.observers.delete(observer); };
      },
      async release() {
        if (state.disposed) return;
        state.disposed = true;
        releases++;
        active.delete(state);
        state.observers.clear();
        state.snapshot = undefined;
        options?.signal?.removeEventListener("abort", abort);
      },
    };
    const abort = () => { void subscription.release(); };
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    return subscription;
  }
  return {
    observeAgents,
    update(payload: Extract<SessionOutboundMessage, { type: "agent_update" }>["payload"]) {
      for (const state of active) {
        if (!state.snapshot) continue;
        for (const observer of state.observers) observer.update({ type: "agent_update", payload: { ...payload, subscriptionId: state.snapshot.subscriptionId } });
      }
    },
    disconnect() { for (const state of active) state.snapshot = undefined; },
    reconnect() {
      for (const state of active) {
        state.snapshot = { requestId: "reconnected", subscriptionId: `directory-${++serial}`, entries: [],
          pageInfo: { hasMore: true, nextCursor: "partial", prevCursor: null } };
        for (const observer of [...state.observers]) observer.snapshot(state.snapshot);
      }
    },
    error(error: unknown) { for (const state of active) for (const observer of state.observers) observer.error?.(error); },
    releases: () => releases,
    listeners: () => [...active].reduce((count, state) => count + state.observers.size, 0),
  };
}
