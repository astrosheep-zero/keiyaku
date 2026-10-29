import { Square, SquareError, harnessOwner, selectOwnSeat, } from "@astrosheep/square";
import { join } from "node:path";
const DUPLICATE_HINT = "ignore if you have already seen this.";
const NOTICE_METADATA_KEY = "keiyaku";
const TURN_OUTCOME_KIND = "akuma.turn-outcome";
const TURN_HISTORY = /^turn\/[1-9]\d*$/u;
/**
 * One World-local notification participant authors every committed outcome and
 * abnormal Body ending, so a resulting notice never depends on whether the
 * subject worker still stands. Its owner is a logical integration custody
 * coordinate: a stable session of its own, not a native harness session, and
 * therefore no recipient wake route of its own.
 */
const NOTIFIER = "keiyaku-notice";
const NOTIFIER_OWNER = harnessOwner({ channel: "unknown", session: "keiyaku:square-notifier" });
const WAIT_DEFERRAL_TTL_MS = 5 * 60_000;
const WAIT_DEFERRAL_RENEW_MS = 2 * 60_000;
function errorCode(error) {
    return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
const HARNESS_SESSIONS = [
    { variable: "CLAUDE_CODE_SESSION_ID", channel: "claude-code" },
    { variable: "CODEX_THREAD_ID", channel: "codex" },
    { variable: "OPENCODE_SESSION_ID", channel: "opencode" },
    { variable: "PI_SESSION_ID", channel: "pi" },
    { variable: "PASEO_AGENT_ID", channel: "paseo" },
];
function squareIdentity(environment) {
    if (environment.CLAUDE_CODE_CHILD_SESSION === "1")
        return undefined;
    const coordinates = HARNESS_SESSIONS.flatMap(({ variable, channel }) => {
        const session = environment[variable]?.trim();
        return session === undefined || session === "" ? [] : [{ channel, session }];
    });
    const native = coordinates.filter(({ channel }) => channel !== "paseo");
    if (native.length > 1)
        return undefined;
    const paseo = coordinates.find(({ channel }) => channel === "paseo");
    const coordinate = native[0] ?? paseo;
    if (coordinate === undefined)
        return undefined;
    const wakeAddress = coordinate.channel === "codex"
        ? { kind: "codex-queue", address: { threadId: coordinate.session } }
        : paseo === undefined ? undefined : { kind: "paseo", address: { agentId: paseo.session } };
    return { owner: harnessOwner(coordinate), ...(wakeAddress === undefined ? {} : { wakeAddress }) };
}
/** The one attached standing seat this owner holds, by declared name or uniquely. */
async function attachedSeat(square, owner, declared) {
    if (declared === undefined)
        return await selectOwnSeat(square, owner, undefined, { optional: true });
    const attached = (await square.seatsOf(owner)).filter(({ attachment }) => attachment === "attached");
    return attached.some(({ name }) => name === declared) ? await square.participant(declared, { owner }) : undefined;
}
async function openSquare(path, environment, cancellation) {
    const control = cancellation === undefined ? {} : { signal: cancellation };
    cancellation?.throwIfAborted();
    try {
        return await Square.at({ path, env: environment }, control);
    }
    catch (error) {
        cancellation?.throwIfAborted();
        if (errorCode(error) !== "ENOENT" && errorCode(error) !== "unavailable")
            throw error;
        try {
            return await Square.build({ path, markdown: "", env: environment }, control);
        }
        catch (buildError) {
            cancellation?.throwIfAborted();
            try {
                return await Square.at({ path, env: environment }, control);
            }
            catch {
                throw buildError;
            }
        }
    }
}
function turnOutcomeBody(signal) {
    const context = [
        `turn/${signal.turnSequence}${signal.outcome.kind === "failed" ? " failed" : ""}`,
        signal.initiator === undefined ? undefined : `· requested by @${signal.initiator}`,
        signal.contractId === undefined ? undefined : `· ${signal.contractId}`,
    ]
        .filter((value) => value !== undefined)
        .join(" ");
    const result = signal.outcome.kind === "failed" ? signal.outcome.reason : signal.outcome.text;
    const marker = signal.outcome.kind === "failed" ? "×" : "✓";
    return `${marker} ${signal.akumaId} came back\n${context}\n\n---\n\n${result}`;
}
function turnOutcomeMetadata(signal) {
    return {
        [NOTICE_METADATA_KEY]: {
            kind: TURN_OUTCOME_KIND,
            akumaId: signal.akumaId,
            historyId: `turn/${signal.turnSequence}`,
        },
    };
}
function metadataRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isCurrentTurnNotice(activity, signal) {
    if (activity.kind !== "say" || activity.actor !== NOTIFIER || !TURN_HISTORY.test(signal.historyId))
        return false;
    const metadata = activity.metadata;
    if (!metadataRecord(metadata))
        return false;
    const identity = metadata[NOTICE_METADATA_KEY];
    if (!metadataRecord(identity))
        return false;
    return (Object.keys(identity).length === 3 &&
        identity.kind === TURN_OUTCOME_KIND &&
        identity.akumaId === signal.akumaId &&
        identity.historyId === signal.historyId);
}
function isLegacyTurnNotice(activity, signal) {
    if (activity.metadata !== undefined ||
        activity.kind !== "say" ||
        activity.body === undefined ||
        !TURN_HISTORY.test(signal.historyId) ||
        (activity.actor !== NOTIFIER && activity.actor !== signal.akumaId))
        return false;
    const [header, ...lines] = activity.body.split("\n");
    const identity = `${signal.akumaId} ${signal.historyId}`;
    if (header !== identity && !header?.startsWith(`${identity} `))
        return false;
    const suffix = header.slice(identity.length);
    if (!/^(?: \(@[^\n]+\))?(?: kei\/\S+)?$/u.test(suffix))
        return false;
    return lines.at(-1) === DUPLICATE_HINT;
}
function birthExpression(signal) {
    const caller = signal.caller.kind === "akuma" ? ` (caller: ${signal.caller.akuId})` : "";
    return `${signal.initiator} called ${signal.akumaId}${caller}\n${DUPLICATE_HINT}`;
}
function bodyNotificationKey(signal) {
    return JSON.stringify([signal.akumaId, signal.bodySequence]);
}
function bodyEndExpression(signal) {
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
function serializeBodyNotification(notifications, signal, operation) {
    const key = bodyNotificationKey(signal);
    let state = notifications.get(key);
    if (state === undefined) {
        state = { tail: Promise.resolve(), failedRecipients: new Set() };
        notifications.set(key, state);
    }
    const result = state.tail.then(() => operation(state));
    state.tail = result.then(() => undefined, () => undefined);
    return result;
}
const plugin = {
    manifest: {
        id: "square",
        apiVersion: 1,
        writablePaths: [{ name: "square", path: ".square" }],
    },
    async activate(context) {
        const path = join(context.writablePath("square"), "KEIYAKU.square");
        const environment = { ...process.env };
        const declaredParticipant = environment.SQUARE_PARTICIPANT_NAME?.trim();
        const bodyNotifications = new Map();
        const expressAsNotifier = async (expression, participants, cancellation) => {
            cancellation?.throwIfAborted();
            const control = cancellation === undefined ? {} : { signal: cancellation };
            const square = await openSquare(path, environment, cancellation);
            try {
                cancellation?.throwIfAborted();
                const joined = await square.join(NOTIFIER, { owner: NOTIFIER_OWNER }, control);
                cancellation?.throwIfAborted();
                const notice = typeof expression === "string" ? { body: expression } : expression;
                await joined.participant.express({
                    body: notice.body,
                    ...(notice.metadata === undefined ? {} : { metadata: notice.metadata }),
                    noWait: true,
                    noMention: true,
                    force: true,
                    ...(participants?.length ? { mentions: [...participants] } : {}),
                }, control);
                return true;
            }
            finally {
                await square.close();
            }
        };
        const expressTurnOutcome = (signal, cancellation) => expressAsNotifier({ body: turnOutcomeBody(signal), metadata: turnOutcomeMetadata(signal) }, signal.participants, cancellation);
        const expressBodyEnd = (signal, participants, cancellation) => expressAsNotifier(bodyEndExpression(signal), participants, cancellation);
        const waitDeferral = async (input, cancellation) => {
            cancellation?.throwIfAborted();
            if (input.akumaIds.length === 0)
                return undefined;
            const identity = squareIdentity(environment);
            if (identity === undefined)
                return undefined;
            let square;
            try {
                // The resource outlives acquisition. Do not capture its expiring signal
                // in Square's connection; individual lease operations carry it instead.
                square = await Square.at({ path, env: environment });
            }
            catch (error) {
                cancellation?.throwIfAborted();
                if (errorCode(error) === "ENOENT" || errorCode(error) === "unavailable")
                    return undefined;
                throw error;
            }
            const acquired = [];
            const expired = new Set();
            let closing;
            let renewalTimer;
            let renewalWork;
            let renewalDiagnostic;
            let seat;
            const renewalController = new AbortController();
            // Partial acquisition also closes here, before the runtime has a scope.
            // Cancellation must still reach Square.close if a lease operation stalls.
            const cleanup = (cleanupSignal = AbortSignal.timeout(5_000)) => {
                if (closing !== undefined)
                    return closing;
                renewalController.abort();
                if (renewalTimer !== undefined)
                    clearTimeout(renewalTimer);
                closing = (async () => {
                    let abort;
                    const cancelled = new Promise((resolve) => {
                        abort = resolve;
                        if (cleanupSignal.aborted)
                            resolve();
                        else
                            cleanupSignal.addEventListener("abort", abort, { once: true });
                    });
                    const releases = (async () => {
                        await renewalWork;
                        if (seat === undefined)
                            return;
                        const results = await Promise.allSettled(acquired.map(async (id) => await seat.releaseDeliveryDeferral(id, { signal: cleanupSignal })));
                        const failure = results.find((result) => result.status === "rejected");
                        if (failure !== undefined)
                            throw failure.reason;
                    })();
                    try {
                        await Promise.race([releases, cancelled]);
                        cleanupSignal.throwIfAborted();
                        if (renewalDiagnostic !== undefined)
                            throw new Error(renewalDiagnostic);
                    }
                    finally {
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
                const leases = await Promise.allSettled(input.akumaIds.map(async (akumaId) => {
                    cancellation?.throwIfAborted();
                    const lease = await seat.deferDelivery({
                        match: {
                            fields: [
                                { path: ["keiyaku", "kind"], equals: "akuma.turn-outcome" },
                                { path: ["keiyaku", "akumaId"], equals: akumaId },
                            ],
                        },
                        durationMs: WAIT_DEFERRAL_TTL_MS,
                    }, cancellation === undefined ? {} : { signal: cancellation });
                    acquired.push(lease.id);
                }));
                const failure = leases.find((lease) => lease.status === "rejected");
                if (failure !== undefined)
                    throw failure.reason;
                cancellation?.throwIfAborted();
                const renew = () => {
                    if (renewalController.signal.aborted)
                        return;
                    const signal = AbortSignal.any([renewalController.signal, AbortSignal.timeout(5_000)]);
                    renewalWork = Promise.allSettled(acquired.filter(id => !expired.has(id)).map(async (id) => {
                        const renewed = await seat.renewDeliveryDeferral(id, WAIT_DEFERRAL_TTL_MS, { signal });
                        if (renewed === null) {
                            expired.add(id);
                            throw new Error(`Square wait deferral ${id} expired before renewal`);
                        }
                    })).then((results) => {
                        const failed = results.find((result) => result.status === "rejected");
                        if (failed === undefined && expired.size === 0)
                            renewalDiagnostic = undefined;
                        if (!renewalController.signal.aborted && failed !== undefined)
                            renewalDiagnostic ??= `Square wait deferral renewal failed: ${String(failed.reason)}`;
                    }).finally(() => {
                        if (!renewalController.signal.aborted && expired.size < acquired.length)
                            renewalTimer = setTimeout(renew, WAIT_DEFERRAL_RENEW_MS);
                    });
                };
                renewalTimer = setTimeout(renew, WAIT_DEFERRAL_RENEW_MS);
                return { close: cleanup };
            }
            catch (error) {
                await cleanup().catch(() => { });
                throw error;
            }
        };
        return {
            waitDeferral,
            signals: {
                async "akuma.initiating"(signal, cancellation) {
                    const control = cancellation === undefined ? {} : { signal: cancellation };
                    const identity = squareIdentity(environment);
                    if (identity === undefined)
                        return;
                    const square = await openSquare(path, environment, cancellation);
                    try {
                        cancellation?.throwIfAborted();
                        const retired = (await square.participants({}, control)).participants.some(({ name, presence }) => name === signal.initiator && presence === "done");
                        if (!retired)
                            await square.join(signal.initiator, identity, control);
                    }
                    finally {
                        await square.close();
                    }
                },
                async "akuma.born"(signal, cancellation) {
                    cancellation?.throwIfAborted();
                    if (signal.initiator === undefined)
                        return;
                    await expressAsNotifier(birthExpression(signal), undefined, cancellation);
                },
                async "akuma.outcome-observed"(signal, cancellation) {
                    cancellation?.throwIfAborted();
                    const identity = squareIdentity(environment);
                    if (identity === undefined)
                        return;
                    const control = cancellation === undefined ? {} : { signal: cancellation };
                    let square;
                    try {
                        square = await Square.at({ path, env: environment }, control);
                    }
                    catch (error) {
                        if (errorCode(error) === "ENOENT" || errorCode(error) === "unavailable")
                            return;
                        throw error;
                    }
                    try {
                        cancellation?.throwIfAborted();
                        const observer = await attachedSeat(square, identity.owner, signal.observer ?? declaredParticipant);
                        if (observer === undefined)
                            return;
                        const { participants } = await square.participants({}, control);
                        const authored = (name) => participants.some((item) => item.name === name);
                        const notices = [];
                        if (authored(NOTIFIER)) {
                            notices.push(...(await square.history({ from: [NOTIFIER], limit: null }, control)).activities);
                        }
                        if (authored(signal.akumaId)) {
                            notices.push(...(await square.history({
                                from: [signal.akumaId],
                                fixed: `${signal.akumaId} ${signal.historyId}`,
                                limit: null,
                            }, control)).activities);
                        }
                        for (const notice of notices) {
                            if (!isCurrentTurnNotice(notice, signal) && !isLegacyTurnNotice(notice, signal))
                                continue;
                            cancellation?.throwIfAborted();
                            try {
                                await observer.catch({ id: notice.id }, control);
                            }
                            catch (error) {
                                // A notice can disappear or lose availability to this participant after history lookup.
                                if (!(error instanceof SquareError && error.code === "invalid_args" && error.facts?.reason === "not_addressed")) {
                                    throw error;
                                }
                            }
                        }
                    }
                    finally {
                        await square.close();
                    }
                },
                async "akuma.turn-outcome"(signal, cancellation) {
                    await serializeBodyNotification(bodyNotifications, signal, async (state) => {
                        const expressed = await expressTurnOutcome(signal, cancellation);
                        if (signal.outcome.kind !== "failed" || !expressed)
                            return;
                        // A late express may resolve after this handler lost authority; without a
                        // revalidation it would suppress an authorized Body-end notice it never owned.
                        cancellation?.throwIfAborted();
                        for (const participant of signal.participants ?? [])
                            state.failedRecipients.add(participant);
                    });
                },
                async "akuma.body-ended"(signal, cancellation) {
                    const key = bodyNotificationKey(signal);
                    await serializeBodyNotification(bodyNotifications, signal, async (state) => {
                        try {
                            if (signal.end === "exited" || signal.end === "put-down")
                                return;
                            const remaining = (signal.participants ?? []).filter((participant) => !state.failedRecipients.has(participant));
                            if ((signal.participants?.length ?? 0) > 0 && remaining.length === 0)
                                return;
                            await expressBodyEnd(signal, remaining, cancellation);
                        }
                        finally {
                            if (bodyNotifications.get(key) === state)
                                bodyNotifications.delete(key);
                        }
                    });
                },
            },
        };
    },
};
export default plugin;
