import {
  createDefaultWakeTransport,
  createHostLedgerPort,
  Square,
  SquareError,
  squareAssignedParticipantName,
  type Activity,
} from "@astrosheep/square";
import { join } from "node:path";
import type { KeiyakuPlugin, PluginSignalMap } from "@astrosheep/keiyaku/plugin";

const DUPLICATE_HINT = "ignore if you have already seen this.";
/**
 * One World-local notification participant authors every committed outcome and
 * abnormal Body ending, so a resulting notice never depends on whether the
 * subject worker still stands. It is a logical integration custody identity:
 * a stable session of its own, no native harness session, and therefore no
 * recipient wake route of its own.
 */
const NOTIFIER = "keiyaku-notice";
const NOTIFIER_SESSION = "keiyaku:square-notifier";

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

async function openSquare(
  path: string,
  environment: NodeJS.ProcessEnv,
  ledger: ReturnType<typeof createHostLedgerPort>,
  wakeTransport: Awaited<ReturnType<typeof createDefaultWakeTransport>>,
  cancellation?: AbortSignal,
) {
  const control = cancellation === undefined ? {} : { signal: cancellation };
  cancellation?.throwIfAborted();
  try {
    return await Square.at({ path, env: environment, hostLedger: ledger, wakeTransport }, control);
  } catch (error) {
    cancellation?.throwIfAborted();
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "unavailable") throw error;
    try {
      return await Square.build({ path, markdown: "", env: environment, hostLedger: ledger, wakeTransport }, control);
    } catch (buildError) {
      cancellation?.throwIfAborted();
      try {
        return await Square.at({ path, env: environment, hostLedger: ledger, wakeTransport }, control);
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
  const outcome = signal.outcome.kind === "answered" ? signal.outcome.text : `× ${signal.outcome.reason}`;
  return `${header}\n${outcome}\n${DUPLICATE_HINT}`;
}

function isOutcomeNotice(activity: Activity, signal: PluginSignalMap["akuma.outcome-observed"]): boolean {
  // The shared notifier and the former per-Akuma author are the only authors a
  // notice may come from; the envelope's own identity below rejects another
  // Akuma, another Turn, a birth, or a Body notice.
  if (!/^turn\/[1-9]\d*$/u.test(signal.historyId) ||
      activity.kind !== "say" ||
      (activity.actor !== NOTIFIER && activity.actor !== signal.akumaId) ||
      activity.body === undefined) return false;
  const [header, ...lines] = activity.body.split("\n");
  const identity = `${signal.akumaId} ${signal.historyId}`;
  if (header !== identity && !header?.startsWith(`${identity} `)) return false;
  const suffix = header.slice(identity.length);
  if (!/^(?: \(@[^\n]+\))?(?: kei\/\S+)?$/u.test(suffix)) return false;
  return lines.at(-1) === DUPLICATE_HINT;
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
    /**
     * The notifier owns its custody through Square's public host-wide ledger:
     * an absent identity is claimed once, an owned identity is reused, another
     * session's claim refuses, and a degraded ledger propagates its own error.
     */
    const claimNotifier = async (cancellation?: AbortSignal): Promise<void> => {
      const claim = await ledger.claimPresence({
        location: path,
        participant: NOTIFIER,
        session: NOTIFIER_SESSION,
        channel: "unknown",
        epoch: 1,
      }, cancellation);
      cancellation?.throwIfAborted();
      if (claim.status === "busy") {
        throw new SquareError("already_joined", `${NOTIFIER} already stands here — another session holds the name`);
      }
      if (claim.status === "degraded") throw claim.error;
    };
    const expressAsNotifier = async (
      expression: string,
      participants: readonly string[] | undefined,
      cancellation?: AbortSignal,
    ): Promise<boolean> => {
      cancellation?.throwIfAborted();
      await claimNotifier(cancellation);
      const control = cancellation === undefined ? {} : { signal: cancellation };
      // The sender is a logical integration identity, never this process's
      // harness session: an empty environment neither claims a native session
      // nor publishes the notifier as a wake route.
      const square = await openSquare(path, {}, ledger, wakeTransport, cancellation);
      try {
        cancellation?.throwIfAborted();
        const joined = await square.join(NOTIFIER, {}, control);
        cancellation?.throwIfAborted();
        await joined.participant.express(expression, {
          // Notifications retain immediate refusal while held/throttled, not a queued send.
          noWait: true,
          noMention: true,
          // The outcome is already committed, so a reader backlog must not hold it
          // back; hold, cap, and throttle refusals below remain effective.
          force: true,
          ...(participants?.length ? { mentions: [...participants] } : {}),
        }, control);
        return true;
      } finally {
        await square.close();
      }
    };
    const expressTurnOutcome = (
      signal: PluginSignalMap["akuma.turn-outcome"],
      cancellation?: AbortSignal,
    ): Promise<boolean> => expressAsNotifier(outcomeExpression(signal), signal.participants, cancellation);
    const expressBodyEnd = (
      signal: PluginSignalMap["akuma.body-ended"],
      participants: readonly string[],
      cancellation?: AbortSignal,
    ): Promise<boolean> => expressAsNotifier(bodyEndExpression(signal), participants, cancellation);
    /**
     * A process with no harness session and no explicit name has nothing here to
     * recognize, and settles that without touching Square.
     */
    const hasLocalIdentity = (): boolean => {
      try {
        return squareAssignedParticipantName(environment) !== undefined;
      } catch {
        return false;
      }
    };
    /**
     * Local outcome acknowledgment names the participant this session speaks as.
     * Recognition is the ownership-safe authority: Square only lets a session
     * acknowledge notices for a name it stands as, so a declared name is the
     * fallback that resolves an ambiguous binding rather than a replacement for a
     * standing one. Nothing is recomputed or joined merely to acknowledge.
     */
    const localObserver = async (square: Square): Promise<string | undefined> => {
      const recognized = await square.recognize(environment);
      if (recognized !== null) return recognized.name;
      const declared = environment.SQUARE_PARTICIPANT_NAME?.trim();
      if (declared === undefined || declared === "") return undefined;
      try {
        return (await square.participant(declared)).name;
      } catch {
        return undefined;
      }
    };
    return {
      signals: {
        async "akuma.initiating"(signal, cancellation) {
          const control = cancellation === undefined ? {} : { signal: cancellation };
          const square = await openSquare(path, environment, ledger, wakeTransport, cancellation);
          try {
            cancellation?.throwIfAborted();
            await square.implicitJoin(signal.initiator, control);
          } finally {
            await square.close();
          }
        },
        async "akuma.born"(signal, cancellation) {
          cancellation?.throwIfAborted();
          if (signal.initiator === undefined) return;
          const control = cancellation === undefined ? {} : { signal: cancellation };
          const square = await openSquare(path, {}, ledger, wakeTransport, cancellation);
          try {
            cancellation?.throwIfAborted();
            const joined = await square.implicitJoin(signal.initiator, control);
            if (joined.state === "done" || joined.participant === undefined) return;
            cancellation?.throwIfAborted();
            await joined.participant.express(birthExpression(signal), { noWait: true }, control);
          } finally {
            await square.close();
          }
        },
        async "akuma.outcome-observed"(signal, cancellation) {
          cancellation?.throwIfAborted();
          // A local acknowledgment has nothing to recognize without a session
          // coordinate or an explicit name; settle that before any Square read.
          if (signal.observer === undefined && !hasLocalIdentity()) return;
          // A forwarded semantic identity must not borrow the serving harness's
          // session ownership or publish its wake route for the requester.
          const env = signal.observer === undefined ? environment : {};
          const control = cancellation === undefined ? {} : { signal: cancellation };
          let square: Square;
          try {
            square = await Square.at({ path, env, hostLedger: ledger }, control);
          } catch (error) {
            if (errorCode(error) === "ENOENT" || errorCode(error) === "unavailable") return;
            throw error;
          }
          try {
            cancellation?.throwIfAborted();
            const observer = signal.observer ?? await localObserver(square);
            if (observer === undefined) return;
            const { participants } = await square.participants({}, control);
            // The observer must still stand; the subject worker need not, because
            // the notice was authored by the shared notifier.
            if (!participants.some((item) => item.name === observer && item.state === "active")) return;
            // Retained notices from the former per-Akuma author stay observable
            // without a second send or a rewrite of the archive. History resolves
            // an author only when it has stood here, and a name with no history to
            // query carries no notice anyway.
            const authors = [NOTIFIER, signal.akumaId].filter((name) =>
              participants.some((item) => item.name === name));
            if (authors.length === 0) return;
            const { activities: notices } = await square.history({
              from: authors, fixed: `${signal.akumaId} ${signal.historyId}`, limit: null,
            }, control);
            const participant = await square.participant(observer);
            for (const notice of notices) {
              if (!isOutcomeNotice(notice, signal)) continue;
              cancellation?.throwIfAborted();
              try {
                await participant.catch({ id: notice.id }, control);
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
