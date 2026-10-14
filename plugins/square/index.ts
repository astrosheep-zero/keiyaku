import {
  createDefaultWakeTransport,
  createHostLedgerPort,
  createSquareApplication,
  Square,
  SquareError,
  type Activity,
  squareAssignedParticipantName,
} from "@astrosheep/square";
import { join } from "node:path";
import type { KeiyakuPlugin, PluginSignalMap } from "@astrosheep/keiyaku/plugin";

const DUPLICATE_HINT = "ignore if you have already seen this.";

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

async function openSquare(
  path: string,
  environment: NodeJS.ProcessEnv,
  ledger: ReturnType<typeof createHostLedgerPort>,
  wakeTransport: Awaited<ReturnType<typeof createDefaultWakeTransport>>,
) {
  try {
    return await Square.at({ path, env: environment, hostLedger: ledger, wakeTransport });
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "unavailable") throw error;
    try {
      return await Square.build({ path, markdown: "", env: environment, hostLedger: ledger, wakeTransport });
    } catch (buildError) {
      try {
        return await Square.at({ path, env: environment, hostLedger: ledger, wakeTransport });
      } catch {
        throw buildError;
      }
    }
  }
}

function outcomeExpression(signal: PluginSignalMap["akuma.turn-outcome"]): string {
  const header = [
    signal.akumaId,
    `turn/${signal.turnSequence}`,
    signal.initiator === undefined ? undefined : `(@${signal.initiator})`,
    signal.contractId,
  ]
    .filter((value) => value !== undefined)
    .join(" ");
  const outcome = signal.outcome.kind === "answered" ? "✓ came back" : `× ${signal.outcome.reason}`;
  return `${header}\n${outcome}\n${DUPLICATE_HINT}`;
}

function isOutcomeNotice(activity: Activity, signal: PluginSignalMap["akuma.outcome-observed"]): boolean {
  if (!/^turn\/[1-9]\d*$/u.test(signal.historyId) ||
      activity.kind !== "say" || activity.actor !== signal.akumaId || activity.body === undefined) return false;
  const [header, ...lines] = activity.body.split("\n");
  const identity = `${signal.akumaId} ${signal.historyId}`;
  if (header !== identity && !header?.startsWith(`${identity} `)) return false;
  const suffix = header.slice(identity.length);
  if (!/^(?: \(@[^\n]+\))?(?: kei\/\S+)?$/u.test(suffix)) return false;
  return lines.at(-1) === DUPLICATE_HINT &&
    (lines.join("\n") === `✓ came back\n${DUPLICATE_HINT}` || lines[0]?.startsWith("× ") === true);
}

function birthExpression(signal: PluginSignalMap["akuma.born"]): string {
  const source = signal.caller.kind === "akuma" ? signal.caller.akuId : undefined;
  return `${[source, "called", signal.akumaId].filter((value) => value !== undefined).join(" ")}\n${DUPLICATE_HINT}`;
}

type BodyNotificationState = {
  tail: Promise<void>;
  failedRecipients: Set<string>;
};

function bodyNotificationKey(signal: Pick<PluginSignalMap["akuma.body-ended"], "akumaId" | "bodySequence">): string {
  return JSON.stringify([signal.akumaId, signal.bodySequence]);
}

function bodyEndExpression(signal: PluginSignalMap["akuma.body-ended"]): string {
  const header = [
    signal.akumaId,
    `body/${signal.bodySequence}`,
    signal.initiator === undefined ? undefined : `(@${signal.initiator})`,
    signal.contractId,
  ]
    .filter((value) => value !== undefined)
    .join(" ");
  const diagnostic = signal.diagnostic === undefined ? "" : `: ${signal.diagnostic}`;
  return `${header}\n× interrupted: ${signal.end}${diagnostic}\n${DUPLICATE_HINT}`;
}

function serializeBodyNotification(
  notifications: Map<string, BodyNotificationState>,
  signal: Pick<PluginSignalMap["akuma.body-ended"], "akumaId" | "bodySequence">,
  operation: (state: BodyNotificationState) => Promise<void>,
): Promise<void> {
  const key = bodyNotificationKey(signal);
  let state = notifications.get(key);
  if (state === undefined) {
    state = { tail: Promise.resolve(), failedRecipients: new Set() };
    notifications.set(key, state);
  }
  const result = state.tail.then(() => operation(state));
  state.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const plugin: KeiyakuPlugin = {
  manifest: {
    id: "square",
    apiVersion: 1,
    writablePaths: [{ name: "square", path: ".square" }],
  },
  async activate(context) {
    const path = join(context.writablePath("square"), "KEIYAKU.square");
    const environment = { ...process.env };
    const ledger = createHostLedgerPort();
    const wakeTransport = await createDefaultWakeTransport(ledger, Date.now, environment);
    const bodyNotifications = new Map<string, BodyNotificationState>();
    const expressAsAkuma = async (
      akumaId: string,
      expression: string,
      participants: readonly string[] | undefined,
      cancellation?: AbortSignal,
    ): Promise<boolean> => {
      cancellation?.throwIfAborted();
      const square = await openSquare(path, environment, ledger, wakeTransport);
      try {
        cancellation?.throwIfAborted();
        const joined = await square.implicitJoin(akumaId);
        if (joined.state === "done" || joined.participant === undefined) return false;
        cancellation?.throwIfAborted();
        await joined.participant.express(expression, {
          noMention: true,
          ...(participants?.length ? { mentions: [...participants] } : {}),
        });
        return true;
      } finally {
        await square.close();
      }
    };
    const expressTurnOutcome = (
      signal: PluginSignalMap["akuma.turn-outcome"],
      cancellation?: AbortSignal,
    ): Promise<boolean> => expressAsAkuma(signal.akumaId, outcomeExpression(signal), signal.participants, cancellation);
    const expressBodyEnd = (
      signal: PluginSignalMap["akuma.body-ended"],
      participants: readonly string[],
      cancellation?: AbortSignal,
    ): Promise<boolean> => expressAsAkuma(signal.akumaId, bodyEndExpression(signal), participants, cancellation);
    let caller: string | undefined;
    try {
      caller = squareAssignedParticipantName(environment);
    } catch {}
    return {
      signals: {
        async "akuma.initiating"(signal) {
          const square = await openSquare(path, environment, ledger, wakeTransport);
          try {
            await square.implicitJoin(signal.initiator);
          } finally {
            await square.close();
          }
        },
        async "akuma.born"(signal, cancellation) {
          cancellation?.throwIfAborted();
          if (signal.initiator === undefined) return;
          const square = await openSquare(path, {}, ledger, wakeTransport);
          try {
            cancellation?.throwIfAborted();
            const joined = await square.implicitJoin(signal.initiator);
            if (joined.state === "done" || joined.participant === undefined) return;
            cancellation?.throwIfAborted();
            await joined.participant.express(birthExpression(signal));
          } finally {
            await square.close();
          }
        },
        async "akuma.outcome-observed"(signal, cancellation) {
          cancellation?.throwIfAborted();
          const observer = signal.observer ?? caller;
          if (observer === undefined) return;
          // A forwarded semantic identity must not borrow the serving harness's
          // session ownership or publish its wake route for the requester.
          const env = signal.observer === undefined ? environment : {};
          let square: Square;
          try {
            square = await Square.at({ path, env, hostLedger: ledger });
          } catch (error) {
            if (errorCode(error) === "ENOENT" || errorCode(error) === "unavailable") return;
            throw error;
          }
          try {
            cancellation?.throwIfAborted();
            const participants = await square.participants();
            if (!participants.some((item) => item.name === observer && item.state === "joined") ||
                !participants.some((item) => item.name === signal.akumaId)) return;
            const control = cancellation === undefined ? {} : { signal: cancellation };
            const notices = await square.history({
              from: [signal.akumaId], fixed: `${signal.akumaId} ${signal.historyId}`,
            }, control);
            const application = createSquareApplication({
              cwd: context.world, squarePath: path, participant: observer, env, hostLedger: ledger,
            });
            for (const notice of notices) {
              if (!isOutcomeNotice(notice, signal)) continue;
              cancellation?.throwIfAborted();
              try {
                await application.catch({ id: notice.id }, control);
              } catch (error) {
                // A notice can disappear or lose availability to this participant after history lookup.
                if (!(error instanceof SquareError && error.code === "invalid_args" && error.facts?.reason === "not_addressed")) {
                  throw error;
                }
              }
            }
          } finally {
            await square.close();
          }
        },
        async "akuma.turn-outcome"(signal, cancellation) {
          await serializeBodyNotification(bodyNotifications, signal, async (state) => {
            const expressed = await expressTurnOutcome(signal, cancellation);
            if (signal.outcome.kind !== "failed" || !expressed) return;
            // A late express may resolve after this handler lost authority; without a
            // revalidation it would suppress an authorized Body-end notice it never owned.
            cancellation?.throwIfAborted();
            for (const participant of signal.participants ?? []) state.failedRecipients.add(participant);
          });
        },
        async "akuma.body-ended"(signal, cancellation) {
          const key = bodyNotificationKey(signal);
          await serializeBodyNotification(bodyNotifications, signal, async (state) => {
            try {
              if (signal.end === "exited" || signal.end === "put-down") return;
              const remaining = (signal.participants ?? []).filter((participant) => !state.failedRecipients.has(participant));
              if ((signal.participants?.length ?? 0) > 0 && remaining.length === 0) return;
              await expressBodyEnd(signal, remaining, cancellation);
            } finally {
              if (bodyNotifications.get(key) === state) bodyNotifications.delete(key);
            }
          });
        },
      },
    };
  },
};

export default plugin;
