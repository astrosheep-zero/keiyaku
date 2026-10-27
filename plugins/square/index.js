import { Square, SquareError } from "@astrosheep/square";
import { join } from "node:path";
const DUPLICATE_HINT = "ignore if you have already seen this.";
/**
 * One World-local notification participant authors every committed outcome and
 * abnormal Body ending, so a resulting notice never depends on whether the
 * subject worker still stands. It is a logical integration custody identity:
 * a stable session of its own, no native harness session, and therefore no
 * recipient wake route of its own.
 */
const NOTIFIER = "keiyaku-notice";
const NOTIFIER_BODY = { channel: "unknown", session: "keiyaku:square-notifier" };
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
        return {};
    const coordinates = HARNESS_SESSIONS.flatMap(({ variable, channel }) => {
        const session = environment[variable]?.trim();
        return session === undefined || session === "" ? [] : [{ channel, session }];
    });
    const native = coordinates.filter(({ channel }) => channel !== "paseo");
    if (native.length > 1)
        return {};
    const paseo = coordinates.find(({ channel }) => channel === "paseo");
    const body = native[0] ?? paseo;
    if (body === undefined)
        return {};
    const wakeAddress = body.channel === "codex"
        ? { kind: "codex-queue", address: { threadId: body.session } }
        : paseo === undefined ? undefined : { kind: "paseo", address: { agentId: paseo.session } };
    return { body, ...(wakeAddress === undefined ? {} : { wakeAddress }) };
}
async function openSquare(path, environment, identity, cancellation) {
    const control = cancellation === undefined ? {} : { signal: cancellation };
    cancellation?.throwIfAborted();
    try {
        return await Square.at({ path, env: environment, ...identity }, control);
    }
    catch (error) {
        cancellation?.throwIfAborted();
        if (errorCode(error) !== "ENOENT" && errorCode(error) !== "unavailable")
            throw error;
        try {
            return await Square.build({ path, markdown: "", env: environment, ...identity }, control);
        }
        catch (buildError) {
            cancellation?.throwIfAborted();
            try {
                return await Square.at({ path, env: environment, ...identity }, control);
            }
            catch {
                throw buildError;
            }
        }
    }
}
function outcomeExpression(signal) {
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
function isOutcomeNotice(activity, signal) {
    // The shared notifier and the former per-Akuma author are the only authors a
    // notice may come from; the envelope's own identity below rejects another
    // Akuma, another Turn, a birth, or a Body notice.
    if (!/^turn\/[1-9]\d*$/u.test(signal.historyId) ||
        activity.kind !== "say" ||
        (activity.actor !== NOTIFIER && activity.actor !== signal.akumaId) ||
        activity.body === undefined)
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
        const bodyNotifications = new Map();
        const expressAsNotifier = async (expression, participants, cancellation) => {
            cancellation?.throwIfAborted();
            const control = cancellation === undefined ? {} : { signal: cancellation };
            const square = await openSquare(path, environment, { body: NOTIFIER_BODY }, cancellation);
            try {
                cancellation?.throwIfAborted();
                const joined = await square.join(NOTIFIER, {}, control);
                cancellation?.throwIfAborted();
                await joined.participant.express(expression, {
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
        const expressTurnOutcome = (signal, cancellation) => expressAsNotifier(outcomeExpression(signal), signal.participants, cancellation);
        const expressBodyEnd = (signal, participants, cancellation) => expressAsNotifier(bodyEndExpression(signal), participants, cancellation);
        const localObserver = async (square) => {
            const recognized = await square.recognize();
            if (recognized.length === 1)
                return recognized[0].name;
            const declared = environment.SQUARE_PARTICIPANT_NAME?.trim();
            return recognized.find(({ name }) => name === declared)?.name;
        };
        return {
            signals: {
                async "akuma.initiating"(signal, cancellation) {
                    const control = cancellation === undefined ? {} : { signal: cancellation };
                    const identity = squareIdentity(environment);
                    if (identity.body === undefined)
                        return;
                    const square = await openSquare(path, environment, identity, cancellation);
                    try {
                        cancellation?.throwIfAborted();
                        await square.implicitJoin(signal.initiator, control);
                    }
                    finally {
                        await square.close();
                    }
                },
                async "akuma.born"(signal, cancellation) {
                    cancellation?.throwIfAborted();
                    if (signal.initiator === undefined)
                        return;
                    await expressAsNotifier(birthExpression(signal), [signal.initiator], cancellation);
                },
                async "akuma.outcome-observed"(signal, cancellation) {
                    cancellation?.throwIfAborted();
                    const identity = squareIdentity(environment);
                    if (identity.body === undefined)
                        return;
                    const control = cancellation === undefined ? {} : { signal: cancellation };
                    let square;
                    try {
                        square = await Square.at({ path, env: environment, ...identity }, control);
                    }
                    catch (error) {
                        if (errorCode(error) === "ENOENT" || errorCode(error) === "unavailable")
                            return;
                        throw error;
                    }
                    try {
                        cancellation?.throwIfAborted();
                        const observer = signal.observer === undefined
                            ? await localObserver(square)
                            : (await square.recognize()).find(({ name }) => name === signal.observer)?.name;
                        if (observer === undefined)
                            return;
                        const { participants } = await square.participants({}, control);
                        const authors = [NOTIFIER, signal.akumaId].filter((name) => participants.some((item) => item.name === name));
                        if (authors.length === 0)
                            return;
                        const { activities: notices } = await square.history({
                            from: authors, fixed: `${signal.akumaId} ${signal.historyId}`, limit: null,
                        }, control);
                        const participant = await square.participant(observer);
                        for (const notice of notices) {
                            if (!isOutcomeNotice(notice, signal))
                                continue;
                            cancellation?.throwIfAborted();
                            try {
                                await participant.catch({ id: notice.id }, control);
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
