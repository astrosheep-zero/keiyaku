import {
  DeliveryLedger,
  deliveryLedgerLocation,
  harnessOwner,
  requireOwner,
  postAndDispatch,
  dispatchEligibleCards,
  type CardPresentation,
  type HandoffResult,
  type Owner,
} from "@astrosheep/square";
import type { KeiyakuPlugin, PluginInstance, PluginSignalMap } from "@astrosheep/keiyaku/plugin";

const TURN_HISTORY = /^turn\/[1-9]\d*$/u;
const WAIT_TTL_MS = 5 * 60_000;
const WAIT_RENEW_MS = 2 * 60_000;

function localOwner(environment: NodeJS.ProcessEnv): Owner | undefined {
  const explicit = environment.KEIYAKU_INITIATOR?.trim();
  if (explicit) return requireOwner(explicit);
  if (environment.CLAUDE_CODE_CHILD_SESSION === "1") return undefined;
  const coordinates = [
    ["CLAUDE_CODE_SESSION_ID", "claude-code"],
    ["CODEX_THREAD_ID", "codex"],
    ["OPENCODE_SESSION_ID", "opencode"],
    ["PI_SESSION_ID", "pi"],
  ].flatMap(([variable, channel]) => {
    const session = environment[variable!]?.trim();
    return session ? [{ channel: channel!, session }] : [];
  });
  if (coordinates.length > 1) return undefined;
  const paseo = environment.PASEO_AGENT_ID?.trim();
  const coordinate = coordinates[0] ?? (paseo ? { channel: "paseo", session: paseo } : undefined);
  return coordinate === undefined ? undefined : harnessOwner(coordinate);
}

/** Bound an operation without abandoning the connection its late work still owns. */
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** An invoked external effect may settle after the bounded handler has retired. */
function ledgerLifetime(ledger: DeliveryLedger) {
  const pending = new Set<Promise<unknown>>();
  let retired = false;
  let closing: Promise<void> | undefined;
  const closeOnce = () => (closing ??= ledger.close());
  const own = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    const settled = () => {
      pending.delete(work);
      if (retired && pending.size === 0) void closeOnce().catch(console.error);
    };
    void work.then(settled, settled);
    return work;
  };
  return {
    own,
    track(result: HandoffResult) {
      if (result.lateSettlement !== undefined) own(result.lateSettlement);
    },
    async close() {
      retired = true;
      if (pending.size === 0) await closeOnce();
    },
  };
}

function turnOutcomeBody(signal: PluginSignalMap["akuma.turn-outcome"], label: string): string {
  const { kind } = signal.outcome;
  const verdict = kind === "failed" ? "× failed" : kind === "canceled" ? "○ canceled" : "✓ done";
  const result = kind === "failed" ? signal.outcome.reason : kind === "answered" ? signal.outcome.text : "";
  const footer = [
    label === signal.akumaId ? undefined : `\`${signal.akumaId}\``,
    `\`turn/${signal.turnSequence}\``,
    signal.contractId === undefined ? undefined : `\`${signal.contractId}\``,
  ]
    .filter((value) => value !== undefined)
    .join(" · ");
  const head = `\`${label}\` ${verdict}`;
  return result.trim() === "" ? `${head}\n\n---\n\n${footer}` : `${head}\n${result}\n\n---\n\n${footer}`;
}

function bodyEndExpression(signal: PluginSignalMap["akuma.body-ended"], label: string): string {
  const diagnostic = signal.diagnostic === undefined ? "" : `: ${signal.diagnostic}`;
  const footer = [
    label === signal.akumaId ? undefined : `\`${signal.akumaId}\``,
    `\`body/${signal.bodySequence}\``,
    signal.initiator === undefined ? undefined : `requested by ${signal.initiator}`,
    signal.contractId === undefined ? undefined : `\`${signal.contractId}\``,
    "ignore if you have already seen this.",
  ]
    .filter((value) => value !== undefined)
    .join(" · ");
  return `\`${label}\` × interrupted\n${signal.end}${diagnostic}\n\n---\n\n${footer}`;
}

type BodyNotificationState = { tail: Promise<void>; terminalRecipients: Set<string> };
const bodyKey = (signal: { akumaId: string; bodySequence: number }) => `${signal.akumaId}/body/${signal.bodySequence}`;

const plugin: KeiyakuPlugin = {
  manifest: { id: "square", apiVersion: 1 },
  async activate(context) {
    const world = context.world;
    const environment = { ...process.env };
    const location = deliveryLedgerLocation(environment);
    const bodyNotifications = new Map<string, BodyNotificationState>();
    const serialize = (
      signal: { akumaId: string; bodySequence: number },
      operation: (state: BodyNotificationState) => Promise<void>,
    ) => {
      const key = bodyKey(signal);
      const state = bodyNotifications.get(key) ?? { tail: Promise.resolve(), terminalRecipients: new Set<string>() };
      bodyNotifications.set(key, state);
      const result = state.tail.then(() => operation(state));
      state.tail = result.catch(() => {});
      return result;
    };
    const sendNotice = async (
      akumaId: string,
      ref: string,
      renderBody: (label: string) => string,
      recipients: readonly string[] | undefined,
      cancellation?: AbortSignal,
      committed?: (recipient: string) => void,
    ) => {
      cancellation?.throwIfAborted();
      if (!recipients?.length) return;
      let label = akumaId;
      try {
        const { Akumas } = await import("@astrosheep/keiyaku");
        const bindings = await Akumas.of(world).aliases({ akumaIds: [akumaId] });
        if (bindings.length) label = bindings.map((binding) => binding.alias).join(", ");
      } catch (error) {
        console.warn(`Keiyaku notice alias lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      cancellation?.throwIfAborted();
      const body = renderBody(label);
      const ledger = await DeliveryLedger.open({ location });
      const lifetime = ledgerLifetime(ledger);
      try {
        const details: CardPresentation = { kind: "presentation", origin: "Keiyaku", author: label, ref, body };
        const results = await Promise.allSettled(
          [...new Set(recipients)].map(async (recipient) => {
            cancellation?.throwIfAborted();
            const result = await postAndDispatch(
              ledger,
              {
                owner: requireOwner(recipient),
                key: `keiyaku/${akumaId}/${ref}`,
                text: body,
                details,
              },
              {
                env: environment,
                ...(cancellation === undefined ? {} : { signal: cancellation }),
                track: lifetime.track,
              },
            );
            cancellation?.throwIfAborted();
            if (["posted", "duplicate", "suppressed"].includes(result.status)) committed?.(recipient);
            else if (result.status === "conflict") throw new Error(`Keiyaku card conflict: ${akumaId}/${ref}`);
          }),
        );
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed) throw failed.reason;
      } finally {
        await lifetime.close();
      }
    };
    const waitDeferral: NonNullable<PluginInstance["waitDeferral"]> = async (input, cancellation) => {
      cancellation?.throwIfAborted();
      const owner = localOwner(environment);
      if (owner === undefined || input.akumaIds.length === 0) return undefined;
      const ledger = await DeliveryLedger.open({ location });
      const lifetime = ledgerLifetime(ledger);
      const acquired: string[] = [];
      const expired = new Set<string>();
      let closing: Promise<void> | undefined;
      let timer: NodeJS.Timeout | undefined;
      let renewal: Promise<void> | undefined;
      let renewalDiagnostic: unknown;
      let stopped = false;
      const cleanup = (signal = AbortSignal.timeout(5_000)): Promise<void> => {
        if (closing !== undefined) return closing;
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
        closing = (async () => {
          let failure: unknown;
          try {
            try {
              await bounded(renewal ?? Promise.resolve(), signal);
            } catch (error) {
              failure = error;
            }
            // Even an expired cleanup budget starts release; late work retains the ledger.
            const releases = acquired.map((id) => lifetime.own(ledger.releaseSuppression({ owner, id })));
            try {
              await bounded(Promise.all(releases), signal);
            } catch (error) {
              failure ??= error;
            }
            if (!signal.aborted) {
              await bounded(
                lifetime.own(
                  dispatchEligibleCards(ledger, owner, {
                    env: environment,
                    signal,
                    track: lifetime.track,
                  }),
                ),
                signal,
              );
            }
            if (failure !== undefined) throw failure;
            if (renewalDiagnostic !== undefined) throw renewalDiagnostic;
          } finally {
            await lifetime.close();
          }
        })();
        return closing;
      };
      try {
        await Promise.all(
          [...new Set(input.akumaIds)].map((id) =>
            lifetime.own(
              (async () => {
                cancellation?.throwIfAborted();
                const result = await ledger.suppress({
                  owner,
                  key: `keiyaku/${id}/turn/`,
                  scope: "prefix",
                  expiresAt: Date.now() + WAIT_TTL_MS,
                });
                if (stopped || cancellation?.aborted) {
                  await ledger.releaseSuppression({ owner, id: result.id });
                  cancellation?.throwIfAborted();
                  return;
                }
                acquired.push(result.id);
              })(),
            ),
          ),
        );
        cancellation?.throwIfAborted();
        const renew = () => {
          if (stopped) return;
          renewal = Promise.allSettled(
            acquired
              .filter((id) => !expired.has(id))
              .map(async (id) => {
                if (
                  !(await bounded(
                    lifetime.own(ledger.renewSuppression({ owner, id, expiresAt: Date.now() + WAIT_TTL_MS })),
                    AbortSignal.timeout(5_000),
                  ))
                ) {
                  expired.add(id);
                  throw new Error(`Keiyaku wait suppression ${id} expired before renewal`);
                }
              }),
          )
            .then((results) => {
              const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
              if (failure) renewalDiagnostic ??= failure.reason;
            })
            .finally(() => {
              if (!stopped && expired.size < acquired.length) timer = setTimeout(renew, WAIT_RENEW_MS);
            });
        };
        timer = setTimeout(renew, WAIT_RENEW_MS);
        return { close: cleanup };
      } catch (error) {
        await cleanup().catch(() => {});
        throw error;
      }
    };
    return {
      waitDeferral,
      signals: {
        async "akuma.reported"(signal, cancellation) {
          if (signal.initiator === undefined) return;
          await sendNotice(
            signal.akumaId,
            `report/${signal.reportSequence}`,
            (label) =>
              `\`${label}\` ▸ update\n${signal.text}\n\n---\n\n${label === signal.akumaId ? "" : `\`${signal.akumaId}\` · `}\`report/${signal.reportSequence}\``,
            [signal.initiator],
            cancellation,
          );
        },
        async "akuma.outcome-observed"(signal, cancellation) {
          cancellation?.throwIfAborted();
          if (!TURN_HISTORY.test(signal.historyId)) return;
          const owner = signal.observer === undefined ? localOwner(environment) : requireOwner(signal.observer);
          if (owner === undefined) return;
          const ledger = await DeliveryLedger.open({ location });
          try {
            cancellation?.throwIfAborted();
            await ledger.suppress({ owner, key: `keiyaku/${signal.akumaId}/${signal.historyId}`, scope: "exact" });
          } finally {
            await ledger.close();
          }
        },
        async "akuma.turn-outcome"(signal, cancellation) {
          await serialize(signal, async (state) => {
            await sendNotice(
              signal.akumaId,
              `turn/${signal.turnSequence}`,
              (label) => turnOutcomeBody(signal, label),
              signal.participants,
              cancellation,
              (recipient) => {
                if (signal.outcome.kind !== "answered") state.terminalRecipients.add(recipient);
              },
            );
          });
        },
        async "akuma.body-ended"(signal, cancellation) {
          await serialize(signal, async (state) => {
            try {
              if (signal.end === "exited" || signal.end === "put-down") return;
              await sendNotice(
                signal.akumaId,
                `body/${signal.bodySequence}`,
                (label) => bodyEndExpression(signal, label),
                signal.participants?.filter((recipient) => !state.terminalRecipients.has(recipient)),
                cancellation,
              );
            } finally {
              if (bodyNotifications.get(bodyKey(signal)) === state) bodyNotifications.delete(bodyKey(signal));
            }
          });
        },
      },
    };
  },
};

export default plugin;
