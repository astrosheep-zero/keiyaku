import { createDefaultWakeTransport, createHostLedgerPort, Square, squareAssignedParticipantName, } from "@astrosheep/square";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const DUPLICATE_HINT = "ignore if you have already seen this.";
function squareEnvironment(environment) {
    const ledgerRoot = environment.SQUARE_REGISTRY === undefined ? undefined : dirname(environment.SQUARE_REGISTRY);
    return {
        ...environment,
        SQUARE_HOST_LEDGER_USER: environment.SQUARE_HOST_LEDGER_USER ?? ledgerRoot ?? join(homedir(), ".square", "host-ledger"),
        SQUARE_HOST_LEDGER_LOCAL: environment.SQUARE_HOST_LEDGER_LOCAL ??
            ledgerRoot ??
            join(environment.PWD ?? process.cwd(), ".square", "host-ledger"),
    };
}
function hostLedger(environment) {
    return createHostLedgerPort({
        userPath: environment.SQUARE_HOST_LEDGER_USER,
        localPath: environment.SQUARE_HOST_LEDGER_LOCAL,
    });
}
function errorCode(error) {
    return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
async function openSquare(path, environment, ledger, wakeTransport) {
    try {
        return await Square.at({ path, env: environment, hostLedger: ledger, wakeTransport });
    }
    catch (error) {
        if (errorCode(error) !== "ENOENT" && errorCode(error) !== "unavailable")
            throw error;
        try {
            return await Square.build({ path, markdown: "", env: environment, hostLedger: ledger, wakeTransport });
        }
        catch (buildError) {
            try {
                return await Square.at({ path, env: environment, hostLedger: ledger, wakeTransport });
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
function calledExpression(signal) {
    const source = signal.callerAkumaId;
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
        const environment = squareEnvironment(process.env);
        const ledger = hostLedger(environment);
        const wakeTransport = await createDefaultWakeTransport(ledger, Date.now, environment);
        const bodyNotifications = new Map();
        const expressTurnOutcome = async (signal, cancellation) => {
            cancellation?.throwIfAborted();
            const square = await openSquare(path, environment, ledger, wakeTransport);
            try {
                cancellation?.throwIfAborted();
                const joined = await square.implicitJoin(signal.akumaId);
                if (joined.state === "done" || joined.participant === undefined)
                    return false;
                cancellation?.throwIfAborted();
                await joined.participant.express(outcomeExpression(signal), signal.initiator === undefined ? {} : { mentions: [signal.initiator] });
                return true;
            }
            finally {
                await square.close();
            }
        };
        const expressBodyEnd = async (signal, cancellation) => {
            cancellation?.throwIfAborted();
            const square = await openSquare(path, environment, ledger, wakeTransport);
            try {
                cancellation?.throwIfAborted();
                const joined = await square.implicitJoin(signal.akumaId);
                if (joined.state === "done" || joined.participant === undefined)
                    return false;
                cancellation?.throwIfAborted();
                await joined.participant.express(bodyEndExpression(signal), signal.initiator === undefined ? {} : { mentions: [signal.initiator] });
                return true;
            }
            finally {
                await square.close();
            }
        };
        let caller;
        try {
            caller = squareAssignedParticipantName(environment);
        }
        catch { }
        return {
            signals: {
                async "akuma.initiating"(signal) {
                    const square = await openSquare(path, environment, ledger, wakeTransport);
                    try {
                        await square.implicitJoin(signal.initiator);
                    }
                    finally {
                        await square.close();
                    }
                },
                async "akuma.called"(signal) {
                    if (caller === undefined)
                        return;
                    const square = await openSquare(path, environment, ledger, wakeTransport);
                    try {
                        const joined = await square.implicitJoin(caller);
                        if (joined.state === "done" || joined.participant === undefined)
                            return;
                        await joined.participant.express(calledExpression(signal));
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
                        state.failedRecipients.add(signal.initiator);
                    });
                },
                async "akuma.body-ended"(signal, cancellation) {
                    const key = bodyNotificationKey(signal);
                    await serializeBodyNotification(bodyNotifications, signal, async (state) => {
                        try {
                            if (signal.end === "exited" || signal.end === "put-down")
                                return;
                            if (state.failedRecipients.has(signal.initiator))
                                return;
                            await expressBodyEnd(signal, cancellation);
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
