import { createDefaultWakeTransport, createHostLedgerPort, Square, SquareError, squareAssignedParticipantName, } from "@astrosheep/square";
import { join } from "node:path";
const DUPLICATE_HINT = "ignore if you have already seen this.";
function errorCode(error) {
    return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
async function openSquare(path, environment, ledger, wakeTransport, cancellation) {
    const control = cancellation === undefined ? {} : { signal: cancellation };
    cancellation?.throwIfAborted();
    try {
        return await Square.at({ path, env: environment, hostLedger: ledger, wakeTransport }, control);
    }
    catch (error) {
        cancellation?.throwIfAborted();
        if (errorCode(error) !== "ENOENT" && errorCode(error) !== "unavailable")
            throw error;
        try {
            return await Square.build({ path, markdown: "", env: environment, hostLedger: ledger, wakeTransport }, control);
        }
        catch (buildError) {
            cancellation?.throwIfAborted();
            try {
                return await Square.at({ path, env: environment, hostLedger: ledger, wakeTransport }, control);
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
    const outcome = signal.outcome.kind === "answered" ? "✓ came back" : `× ${signal.outcome.reason}`;
    return `${header}\n${outcome}\n${DUPLICATE_HINT}`;
}
function isOutcomeNotice(activity, signal) {
    if (!/^turn\/[1-9]\d*$/u.test(signal.historyId) ||
        activity.kind !== "say" || activity.actor !== signal.akumaId || activity.body === undefined)
        return false;
    const [header, ...lines] = activity.body.split("\n");
    const identity = `${signal.akumaId} ${signal.historyId}`;
    if (header !== identity && !header?.startsWith(`${identity} `))
        return false;
    const suffix = header.slice(identity.length);
    if (!/^(?: \(@[^\n]+\))?(?: kei\/\S+)?$/u.test(suffix))
        return false;
    return lines.at(-1) === DUPLICATE_HINT &&
        (lines.join("\n") === `✓ came back\n${DUPLICATE_HINT}` || lines[0]?.startsWith("× ") === true);
}
function birthExpression(signal) {
    const source = signal.caller.kind === "akuma" ? signal.caller.akuId : undefined;
    return `${[source, "called", signal.akumaId].filter((value) => value !== undefined).join(" ")}\n${DUPLICATE_HINT}`;
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
        const ledger = createHostLedgerPort();
        const wakeTransport = await createDefaultWakeTransport(ledger, Date.now, environment);
        const bodyNotifications = new Map();
        const expressAsAkuma = async (akumaId, expression, participants, cancellation) => {
            cancellation?.throwIfAborted();
            const control = cancellation === undefined ? {} : { signal: cancellation };
            const square = await openSquare(path, environment, ledger, wakeTransport, cancellation);
            try {
                cancellation?.throwIfAborted();
                const joined = await square.implicitJoin(akumaId, control);
                if (joined.state === "done" || joined.participant === undefined)
                    return false;
                cancellation?.throwIfAborted();
                await joined.participant.express(expression, {
                    // Notifications retain immediate refusal while held/throttled, not a queued send.
                    noWait: true,
                    noMention: true,
                    ...(participants?.length ? { mentions: [...participants] } : {}),
                }, control);
                return true;
            }
            finally {
                await square.close();
            }
        };
        const expressTurnOutcome = (signal, cancellation) => expressAsAkuma(signal.akumaId, outcomeExpression(signal), signal.participants, cancellation);
        const expressBodyEnd = (signal, participants, cancellation) => expressAsAkuma(signal.akumaId, bodyEndExpression(signal), participants, cancellation);
        /**
         * A process with no harness session and no explicit name has nothing here to
         * recognize, and settles that without touching Square.
         */
        const hasLocalIdentity = () => {
            try {
                return squareAssignedParticipantName(environment) !== undefined;
            }
            catch {
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
        const localObserver = async (square) => {
            const recognized = await square.recognize(environment);
            if (recognized !== null)
                return recognized.name;
            const declared = environment.SQUARE_PARTICIPANT_NAME?.trim();
            if (declared === undefined || declared === "")
                return undefined;
            try {
                return (await square.participant(declared)).name;
            }
            catch {
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
                    }
                    finally {
                        await square.close();
                    }
                },
                async "akuma.born"(signal, cancellation) {
                    cancellation?.throwIfAborted();
                    if (signal.initiator === undefined)
                        return;
                    const control = cancellation === undefined ? {} : { signal: cancellation };
                    const square = await openSquare(path, {}, ledger, wakeTransport, cancellation);
                    try {
                        cancellation?.throwIfAborted();
                        const joined = await square.implicitJoin(signal.initiator, control);
                        if (joined.state === "done" || joined.participant === undefined)
                            return;
                        cancellation?.throwIfAborted();
                        await joined.participant.express(birthExpression(signal), { noWait: true }, control);
                    }
                    finally {
                        await square.close();
                    }
                },
                async "akuma.outcome-observed"(signal, cancellation) {
                    cancellation?.throwIfAborted();
                    // A local acknowledgment has nothing to recognize without a session
                    // coordinate or an explicit name; settle that before any Square read.
                    if (signal.observer === undefined && !hasLocalIdentity())
                        return;
                    // A forwarded semantic identity must not borrow the serving harness's
                    // session ownership or publish its wake route for the requester.
                    const env = signal.observer === undefined ? environment : {};
                    const control = cancellation === undefined ? {} : { signal: cancellation };
                    let square;
                    try {
                        square = await Square.at({ path, env, hostLedger: ledger }, control);
                    }
                    catch (error) {
                        if (errorCode(error) === "ENOENT" || errorCode(error) === "unavailable")
                            return;
                        throw error;
                    }
                    try {
                        cancellation?.throwIfAborted();
                        const observer = signal.observer ?? await localObserver(square);
                        if (observer === undefined)
                            return;
                        const { participants } = await square.participants({}, control);
                        if (!participants.some((item) => item.name === observer && item.state === "active") ||
                            !participants.some((item) => item.name === signal.akumaId))
                            return;
                        const { activities: notices } = await square.history({
                            from: [signal.akumaId], fixed: `${signal.akumaId} ${signal.historyId}`, limit: null,
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
