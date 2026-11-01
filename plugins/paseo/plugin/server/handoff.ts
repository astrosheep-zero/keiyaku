import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookContext, PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

type ObservedSession = Readonly<{ observe(reannounce?: boolean): Promise<void> }>;
type Attempt = {
  agentId: string;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  unsubscribeContext: () => void;
  subscription?: Awaited<ReturnType<PaseoApi["agents"]["list"]>>["subscription"];
  session?: ObservedSession;
  idleObserved: boolean;
  syncing: boolean;
  active: boolean;
  cleanup?: Promise<void>;
};
const ATTEMPT_TIMEOUT_MS = 90_000;

export function registerRegistrationHooks(server: Pick<PluginServerContext, "before" | "on">,
  handoff: ReturnType<typeof createRegistrationHandoff>): () => void {
  const removeBefore = server.before("agent.session_open", ({ request }, context) => handoff.beforeOpen(request, context));
  const removeArchived = server.on("agent.archived", ({ agent }) => handoff.closed(agent.id));
  const removeClosed = server.on("agent.closed", ({ agent }) => handoff.closed(agent.id));
  return () => { removeBefore(); removeArchived(); removeClosed(); };
}

export function createRegistrationHandoff() {
  const attempts = new Map<string, Attempt>();
  const release = (attempt: Attempt): Promise<void> => {
    if (attempt.cleanup) return attempt.cleanup;
    if (!attempt.active) return Promise.resolve();
    attempt.active = false;
    clearTimeout(attempt.timer);
    attempt.controller.abort();
    attempt.unsubscribeContext();
    if (attempts.get(attempt.agentId) === attempt) attempts.delete(attempt.agentId);
    attempt.cleanup = attempt.subscription?.release().catch((error: unknown) => {
      console.warn(`Keiyaku mirror registration subscription cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }) ?? Promise.resolve();
    return attempt.cleanup;
  };
  const synchronize = (attempt: Attempt): void => {
    if (!attempt.active || attempt.syncing || !attempt.idleObserved || !attempt.session) return;
    attempt.syncing = true;
    void attempt.session.observe(true).catch((error: unknown) => {
      console.warn(`Keiyaku mirror registration synchronization failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(async () => { await release(attempt); });
  };
  const update = (attempt: Attempt, message: SessionOutboundMessage): void => {
    if (!attempt.active || !attempt.session || message.type !== "agent_update" || message.payload.kind !== "upsert") return;
    const { agent } = message.payload;
    if (agent.id !== attempt.agentId || agent.provider !== "keiyaku" || agent.status !== "idle" || agent.archivedAt) return;
    attempt.idleObserved = true;
    synchronize(attempt);
  };

  return {
    async beforeOpen(request: PluginSessionOpenRequest, context: PluginHookContext): Promise<void> {
      if (request.provider !== "keiyaku") return;
      const agentId = request.agentId;
      if (!agentId) return;
      const prior = attempts.get(agentId);
      if (prior) await release(prior);
      const controller = new AbortController();
      let attempt!: Attempt;
      const abortFromContext = () => { void release(attempt); };
      context.signal.addEventListener("abort", abortFromContext, { once: true });
      attempt = {
        agentId, controller, timer: setTimeout(() => release(attempt), ATTEMPT_TIMEOUT_MS),
        unsubscribeContext: () => context.signal.removeEventListener("abort", abortFromContext),
        idleObserved: false, syncing: false, active: true,
      };
      attempts.set(agentId, attempt);
      if (context.signal.aborted) {
        await release(attempt);
        return;
      }
      try {
        const result = await context.paseo.agents.list({ filter: { includeArchived: true, includeBackground: true },
          page: { limit: 1 }, subscribe: {}, signal: controller.signal });
        const subscription = result.subscription;
        if (!subscription) throw new Error("Paseo did not establish the agent directory subscription");
        attempt.subscription = subscription;
        if (!attempt.active) {
          await subscription.release();
          return;
        }
        subscription.subscribe({ snapshot: () => {}, update: (message) => update(attempt, message) });
      } catch (error) {
        await release(attempt);
        console.warn(`Keiyaku mirror registration observation unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    providerReady(agentId: string | undefined, session: ObservedSession): void {
      if (!agentId) return;
      const attempt = attempts.get(agentId);
      if (!attempt?.active) return;
      attempt.session = session;
      synchronize(attempt);
    },
    providerClosed(agentId: string | undefined, session: ObservedSession): Promise<void> {
      const attempt = agentId ? attempts.get(agentId) : undefined;
      return attempt?.session === session ? release(attempt) : Promise.resolve();
    },
    closed(agentId: string): Promise<void> {
      const attempt = attempts.get(agentId);
      return attempt ? release(attempt) : Promise.resolve();
    },
    async close(): Promise<void> {
      await Promise.all([...attempts.values()].map(release));
    },
  };
}
