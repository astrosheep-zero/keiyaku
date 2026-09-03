import { createHostLedgerPort, Square, squareAssignedParticipantName } from "@astrosheep/square";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const DUPLICATE_HINT = "ignore if you have already seen this.";
function squareEnvironment(environment, path) {
    const ledgerRoot = environment.SQUARE_REGISTRY === undefined ? undefined : dirname(environment.SQUARE_REGISTRY);
    return {
        ...environment,
        SQUARE_HOST_LEDGER_USER: environment.SQUARE_HOST_LEDGER_USER ?? ledgerRoot ?? join(homedir(), ".square", "host-ledger"),
        SQUARE_HOST_LEDGER_LOCAL: environment.SQUARE_HOST_LEDGER_LOCAL ??
            ledgerRoot ??
            join(environment.PWD ?? dirname(path), ".square", "host-ledger"),
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
async function openSquare(path, environment, ledger) {
    try {
        return await Square.at({ path, env: environment, hostLedger: ledger });
    }
    catch (error) {
        if (errorCode(error) !== "ENOENT" && errorCode(error) !== "unavailable")
            throw error;
        try {
            return await Square.build({ path, markdown: "", env: environment, hostLedger: ledger });
        }
        catch (buildError) {
            try {
                return await Square.at({ path, env: environment, hostLedger: ledger });
            }
            catch {
                throw buildError;
            }
        }
    }
}
function outcomeExpression(signal, caller) {
    const header = [
        signal.akumaId,
        `turn/${signal.turnSequence}`,
        caller === undefined ? undefined : `(@${caller})`,
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
const plugin = {
    manifest: {
        id: "square",
        apiVersion: 1,
        writablePaths: [{ name: "square", path: ".square" }],
    },
    activate(context) {
        const path = join(context.writablePath("square"), "KEIYAKU.square");
        const environment = squareEnvironment(process.env, path);
        const ledger = hostLedger(environment);
        let caller;
        try {
            caller = squareAssignedParticipantName(environment);
        }
        catch { }
        return {
            signals: {
                async "akuma.called"(signal) {
                    if (caller === undefined)
                        return;
                    const square = await openSquare(path, environment, ledger);
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
                async "akuma.turn-outcome"(signal) {
                    const square = await openSquare(path, environment, ledger);
                    try {
                        const joined = await square.implicitJoin(signal.akumaId);
                        if (joined.state === "done" || joined.participant === undefined)
                            return;
                        await joined.participant.express(outcomeExpression(signal, caller), caller === undefined ? {} : { mentions: [caller] });
                    }
                    finally {
                        await square.close();
                    }
                },
            },
        };
    },
};
export default plugin;
