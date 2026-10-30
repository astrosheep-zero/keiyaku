import {
  Square,
  SquareError,
  harnessOwner,
  selectOwnSeat,
  type Activity,
  type ActivityMetadata,
  type Owner,
  type Participant,
  type WakeAddress,
} from "@astrosheep/square";
import { join } from "node:path";
import type { KeiyakuPlugin, PluginInstance, PluginSignalMap } from "@astrosheep/keiyaku/plugin";

const DUPLICATE_HINT = "ignore if you have already seen this.";
const NOTICE_METADATA_KEY = "keiyaku";
const TURN_OUTCOME_KIND = "akuma.turn-outcome" satisfies keyof PluginSignalMap;
const TURN_HISTORY = /^turn\/[1-9]\d*$/u;
/**
 * One World-local notification participant authors every committed outcome and
 * abnormal Body ending, so a resulting notice never depends on whether the
 * subject worker still stands. Its owner is a logical integration custody
 * coordinate: a stable session of its own, not a native harness session, and
 * therefore no recipient wake route of its own.
 */
const NOTIFIER = "keiyaku-notice";
const NOTIFIER_OWNER: Owner = harnessOwner({ channel: "unknown", session: "keiyaku:square-notifier" });
const WAIT_DEFERRAL_TTL_MS = 5 * 60_000;
const WAIT_DEFERRAL_RENEW_MS = 2 * 60_000;

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

const HARNESS_SESSIONS = [
  { variable: "CLAUDE_CODE_SESSION_ID", channel: "claude-code" },
  { variable: "CODEX_THREAD_ID", channel: "codex" },
  { variable: "OPENCODE_SESSION_ID", channel: "opencode" },
  { variable: "PI_SESSION_ID", channel: "pi" },
  { variable: "PASEO_AGENT_ID", channel: "paseo" },
] as const;

function squareIdentity(environment: NodeJS.ProcessEnv) {
  if (environment.CLAUDE_CODE_CHILD_SESSION === "1") return undefined;
  const coordinates = HARNESS_SESSIONS.flatMap(({ variable, channel }) => {
    const session = environment[variable]?.trim();
    return session === undefined || session === "" ? [] : [{ channel, session }];
  });
  const native = coordinates.filter(({ channel }) => channel !== "paseo");
  if (native.length > 1) return undefined;
  const paseo = coordinates.find(({ channel }) => channel === "paseo");
  const coordinate = native[0] ?? paseo;
  if (coordinate === undefined) return undefined;
  const wakeAddress: WakeAddress | undefined = coordinate.channel === "codex"
    ? { kind: "codex-queue", address: { threadId: coordinate.session } }
    : paseo === undefined ? undefined : { kind: "paseo", address: { agentId: paseo.session } };
  return { owner: harnessOwner(coordinate), ...(wakeAddress === undefined ? {} : { wakeAddress }) };
}

/** The one attached standing seat this owner holds, by declared name or uniquely. */
async function attachedSeat(
  square: Square,
  owner: Owner,
  declared: string | undefined,
): Promise<Participant | undefined> {
  if (declared === undefined) return await selectOwnSeat(square, owner, undefined, { optional: true });
  const attached = (await square.seatsOf(owner)).filter(({ attachment }) => attachment === "attached");
  return attached.some(({ name }) => name === declared) ? await square.participant(declared, { owner }) : undefined;
}

async function openSquare(path: string, environment: NodeJS.ProcessEnv, cancellation?: AbortSignal) {
  const control = cancellation === undefined ? {} : { signal: cancellation };
  cancellation?.throwIfAborted();
  try {
    return await Square.at({ path, env: environment }, control);
  } catch (error) {
    cancellation?.throwIfAborted();
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "unavailable") throw error;
    try {
      return await Square.build({ path, markdown: "", env: environment }, control);
    } catch (buildError) {
      cancellation?.throwIfAborted();
      try {
        return await Square.at({ path, env: environment }, control);
      } catch {
        throw buildError;
      }
    }
  }
}

function turnOutcomeBody(signal: PluginSignalMap["akuma.turn-outcome"]): string {
  const context = [
    `turn/${signal.turnSequence}${signal.outcome.kind === "answered" ? "" : ` ${signal.outcome.kind}`}`,
    signal.initiator === undefined ? undefined : `· requested by @${signal.initiator}`,
    signal.contractId === undefined ? undefined : `· ${signal.contractId}`,
  ]
    .filter((value) => value !== undefined)
    .join(" ");
  const result = signal.outcome.kind === "failed" ? signal.outcome.reason
    : signal.outcome.kind === "answered" ? signal.outcome.text : "";
  const marker = signal.outcome.kind === "failed" ? "×" : signal.outcome.kind === "canceled" ? "○" : "✓";
  return `${marker} ${signal.akumaId} came back\n${context}${signal.outcome.kind === "canceled" ? "" : `\n\n---\n\n${result}`}`;
}

function turnOutcomeMetadata(signal: PluginSignalMap["akuma.turn-outcome"]): ActivityMetadata {
  return {
    [NOTICE_METADATA_KEY]: {
      kind: TURN_OUTCOME_KIND,
      akumaId: signal.akumaId,
      historyId: `turn/${signal.turnSequence}`,
    },
  };
}

function metadataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCurrentTurnNotice(activity: Activity, signal: PluginSignalMap["akuma.outcome-observed"]): boolean {
  if (activity.kind !== "say" || activity.actor !== NOTIFIER || !TURN_HISTORY.test(signal.historyId)) return false;
  const metadata = activity.metadata;
  if (!metadataRecord(metadata)) return false;
  const identity = metadata[NOTICE_METADATA_KEY];
  if (!metadataRecord(identity)) return false;
  return (
    Object.keys(identity).length === 3 &&
    identity.kind === TURN_OUTCOME_KIND &&
    identity.akumaId === signal.akumaId &&
    identity.historyId === signal.historyId
  );
}

function isLegacyTurnNotice(activity: Activity, signal: PluginSignalMap["akuma.outcome-observed"]): boolean {
  if (
    activity.metadata !== undefined ||
    activity.kind !== "say" ||
    activity.body === undefined ||
    !TURN_HISTORY.test(signal.historyId) ||
    (activity.actor !== NOTIFIER && activity.actor !== signal.akumaId)
  )
    return false;
  const [header, ...lines] = activity.body.split("\n");
  const identity = `${signal.akumaId} ${signal.historyId}`;
  if (header !== identity && !header?.startsWith(`${identity} `)) return false;
  const suffix = header.slice(identity.length);
  if (!/^(?: \(@[^\n]+\))?(?: kei\/\S+)?$/u.test(suffix)) return false;
  return lines.at(-1) === DUPLICATE_HINT;
}

function birthExpression(signal: PluginSignalMap["akuma.born"]): string {
  const caller = signal.caller.kind === "akuma" ? ` (caller: ${signal.caller.akuId})` : "";
  return `${signal.initiator} called ${signal.akumaId}${caller}\n${DUPLICATE_HINT}`;
}

type BodyNotificationState = {
  tail: Promise<void>;
  terminalRecipients: Set<string>;
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
    state = { tail: Promise.resolve(), terminalRecipients: new Set() };
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
    const declaredParticipant = environment.SQUARE_PARTICIPANT_NAME?.trim();
    const bodyNotifications = new Map<string, BodyNotificationState>();
    const expressAsNotifier = async (
      expression: string | Readonly<{ body: string; metadata?: ActivityMetadata }>,
      participants: readonly string[] | undefined,
      cancellation?: AbortSignal,
    ): Promise<boolean> => {
      cancellation?.throwIfAborted();
      const control = cancellation === undefined ? {} : { signal: cancellation };
      const square = await openSquare(path, environment, cancellation);
      try {
        cancellation?.throwIfAborted();
        const joined = await square.join(NOTIFIER, { owner: NOTIFIER_OWNER }, control);
        cancellation?.throwIfAborted();
        const notice = typeof expression === "string" ? { body: expression } : expression;
        await joined.participant.express(
          {
            body: notice.body,
            ...(notice.metadata === undefined ? {} : { metadata: notice.metadata }),
            noWait: true,
            noMention: true,
            force: true,
            ...(participants?.length ? { mentions: [...participants] } : {}),
          },
          control,
        );
        return true;
      } finally {
        await square.close();
      }
    };
    const expressTurnOutcome = (
      signal: PluginSignalMap["akuma.turn-outcome"],
      cancellation?: AbortSignal,
    ): Promise<boolean> =>
      expressAsNotifier(
        { body: turnOutcomeBody(signal), metadata: turnOutcomeMetadata(signal) },
        signal.participants,
        cancellation,
      );
    const expressBodyEnd = (
      signal: PluginSignalMap["akuma.body-ended"],
      participants: readonly string[],
      cancellation?: AbortSignal,
    ): Promise<boolean> => expressAsNotifier(bodyEndExpression(signal), participants, cancellation);
    const waitDeferral: NonNullable<PluginInstance["waitDeferral"]> = async (input, cancellation) => {
      cancellation?.throwIfAborted();
      if (input.akumaIds.length === 0) return undefined;
      const identity = squareIdentity(environment);
      if (identity === undefined) return undefined;
      let square: Square;
      try {
        // The resource outlives acquisition. Do not capture its expiring signal
        // in Square's connection; individual lease operations carry it instead.
        square = await Square.at({ path, env: environment });
      } catch (error) {
        cancellation?.throwIfAborted();
        if (errorCode(error) === "ENOENT" || errorCode(error) === "unavailable") return undefined;
        throw error;
      }
      const acquired: string[] = [];
      const expired = new Set<string>();
      let closing: Promise<void> | undefined;
      let renewalTimer: NodeJS.Timeout | undefined;
      let renewalWork: Promise<void> | undefined;
      let renewalDiagnostic: string | undefined;
      let seat: Participant | undefined;
      const renewalController = new AbortController();
      // Partial acquisition also closes here, before the runtime has a scope.
      // Cancellation must still reach Square.close if a lease operation stalls.
      const cleanup = (cleanupSignal = AbortSignal.timeout(5_000)): Promise<void> => {
        if (closing !== undefined) return closing;
        renewalController.abort();
        if (renewalTimer !== undefined) clearTimeout(renewalTimer);
        closing = (async () => {
          let abort!: () => void;
          const cancelled = new Promise<void>((resolve) => {
            abort = resolve;
            if (cleanupSignal.aborted) resolve();
            else cleanupSignal.addEventListener("abort", abort, { once: true });
          });
          const releases = (async () => {
            await renewalWork;
            if (seat === undefined) return;
            const results = await Promise.allSettled(
              acquired.map(async (id) => await seat!.releaseDeliveryDeferral(id, { signal: cleanupSignal })),
            );
            const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
            if (failure !== undefined) throw failure.reason;
          })();
          try {
            await Promise.race([releases, cancelled]);
            cleanupSignal.throwIfAborted();
            if (renewalDiagnostic !== undefined) throw new Error(renewalDiagnostic);
          } finally {
            cleanupSignal.removeEventListener("abort", abort);
            await square.close();
          }
        })();
        return closing;
      };
      try {
        cancellation?.throwIfAborted();
        seat = await attachedSeat(square, identity.owner, declaredParticipant);
        if (seat === undefined) {
          await cleanup();
          return undefined;
        }
        const leases = await Promise.allSettled(
          input.akumaIds.map(async (akumaId) => {
            cancellation?.throwIfAborted();
            const lease = await seat!.deferDelivery(
              {
                match: {
                  fields: [
                    { path: ["keiyaku", "kind"], equals: "akuma.turn-outcome" },
                    { path: ["keiyaku", "akumaId"], equals: akumaId },
                  ],
                },
                durationMs: WAIT_DEFERRAL_TTL_MS,
              },
              cancellation === undefined ? {} : { signal: cancellation },
            );
            acquired.push(lease.id);
          }),
        );
        const failure = leases.find((lease): lease is PromiseRejectedResult => lease.status === "rejected");
        if (failure !== undefined) throw failure.reason;
        cancellation?.throwIfAborted();
        const renew = () => {
          if (renewalController.signal.aborted) return;
          const signal = AbortSignal.any([renewalController.signal, AbortSignal.timeout(5_000)]);
          renewalWork = Promise.allSettled(
            acquired.filter(id => !expired.has(id)).map(async (id) => {
              const renewed = await seat!.renewDeliveryDeferral(id, WAIT_DEFERRAL_TTL_MS, { signal });
              if (renewed === null) {
                expired.add(id);
                throw new Error(`Square wait deferral ${id} expired before renewal`);
              }
            }),
          ).then((results) => {
            const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
            if (failed === undefined && expired.size === 0) renewalDiagnostic = undefined;
            if (!renewalController.signal.aborted && failed !== undefined)
              renewalDiagnostic ??= `Square wait deferral renewal failed: ${String(failed.reason)}`;
          }).finally(() => {
            if (!renewalController.signal.aborted && expired.size < acquired.length)
              renewalTimer = setTimeout(renew, WAIT_DEFERRAL_RENEW_MS);
          });
        };
        renewalTimer = setTimeout(renew, WAIT_DEFERRAL_RENEW_MS);
        return { close: cleanup };
      } catch (error) {
        await cleanup().catch(() => {});
        throw error;
      }
    };
    return {
      waitDeferral,
      signals: {
        async "akuma.initiating"(signal, cancellation) {
          const control = cancellation === undefined ? {} : { signal: cancellation };
          const identity = squareIdentity(environment);
          if (identity === undefined) return;
          const square = await openSquare(path, environment, cancellation);
          try {
            cancellation?.throwIfAborted();
            const retired = (await square.participants({}, control)).participants.some(
              ({ name, presence }) => name === signal.initiator && presence === "done",
            );
            if (!retired) await square.join(signal.initiator, identity, control);
          } finally {
            await square.close();
          }
        },
        async "akuma.born"(signal, cancellation) {
          cancellation?.throwIfAborted();
          if (signal.initiator === undefined) return;
          await expressAsNotifier(birthExpression(signal), undefined, cancellation);
        },
        async "akuma.reported"(signal, cancellation) {
          cancellation?.throwIfAborted();
          if (signal.initiator === undefined) return;
          await expressAsNotifier({
            body: `${signal.akumaId} report/${signal.reportSequence} (body/${signal.bodySequence}, turn/${signal.turnSequence})\n\n${signal.text}`,
            metadata: { keiyaku: {
              kind: signal.kind,
              akumaId: signal.akumaId,
              bodySequence: signal.bodySequence,
              turnSequence: signal.turnSequence,
              reportSequence: signal.reportSequence,
              at: signal.at,
            } },
          }, [signal.initiator], cancellation);
        },
        async "akuma.outcome-observed"(signal, cancellation) {
          cancellation?.throwIfAborted();
          const identity = squareIdentity(environment);
          if (identity === undefined) return;
          const control = cancellation === undefined ? {} : { signal: cancellation };
          let square: Square;
          try {
            square = await Square.at({ path, env: environment }, control);
          } catch (error) {
            if (errorCode(error) === "ENOENT" || errorCode(error) === "unavailable") return;
            throw error;
          }
          try {
            cancellation?.throwIfAborted();
            const observer = await attachedSeat(square, identity.owner, signal.observer ?? declaredParticipant);
            if (observer === undefined) return;
            const { participants } = await square.participants({}, control);
            const authored = (name: string): boolean => participants.some((item) => item.name === name);
            const notices: Activity[] = [];
            if (authored(NOTIFIER)) {
              notices.push(...(await square.history({ from: [NOTIFIER], limit: null }, control)).activities);
            }
            if (authored(signal.akumaId)) {
              notices.push(
                ...(
                  await square.history(
                    {
                      from: [signal.akumaId],
                      fixed: `${signal.akumaId} ${signal.historyId}`,
                      limit: null,
                    },
                    control,
                  )
                ).activities,
              );
            }
            for (const notice of notices) {
              if (!isCurrentTurnNotice(notice, signal) && !isLegacyTurnNotice(notice, signal)) continue;
              cancellation?.throwIfAborted();
              try {
                await observer.catch({ id: notice.id }, control);
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
            if (signal.outcome.kind === "answered" || !expressed) return;
            // A late express may resolve after this handler lost authority; without a
            // revalidation it would suppress an authorized Body-end notice it never owned.
            cancellation?.throwIfAborted();
            for (const participant of signal.participants ?? []) state.terminalRecipients.add(participant);
          });
        },
        async "akuma.body-ended"(signal, cancellation) {
          const key = bodyNotificationKey(signal);
          await serializeBodyNotification(bodyNotifications, signal, async (state) => {
            try {
              if (signal.end === "exited" || signal.end === "put-down") return;
              const remaining = (signal.participants ?? []).filter((participant) => !state.terminalRecipients.has(participant));
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
