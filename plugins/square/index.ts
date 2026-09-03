import { createHostLedgerPort, Square, squareAssignedParticipantName } from "@astrosheep/square";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { KeiyakuPlugin, PluginSignalMap } from "@astrosheep/keiyaku/plugin";

type SquareEnvironment = NodeJS.ProcessEnv &
  Readonly<{
    SQUARE_HOST_LEDGER_USER: string;
    SQUARE_HOST_LEDGER_LOCAL: string;
  }>;

function squareEnvironment(environment: NodeJS.ProcessEnv, path: string): SquareEnvironment {
  const ledgerRoot = environment.SQUARE_REGISTRY === undefined ? undefined : dirname(environment.SQUARE_REGISTRY);
  return {
    ...environment,
    SQUARE_HOST_LEDGER_USER:
      environment.SQUARE_HOST_LEDGER_USER ?? ledgerRoot ?? join(homedir(), ".square", "host-ledger"),
    SQUARE_HOST_LEDGER_LOCAL:
      environment.SQUARE_HOST_LEDGER_LOCAL ??
      ledgerRoot ??
      join(environment.PWD ?? dirname(path), ".square", "host-ledger"),
  } as SquareEnvironment;
}

function hostLedger(environment: SquareEnvironment) {
  return createHostLedgerPort({
    userPath: environment.SQUARE_HOST_LEDGER_USER,
    localPath: environment.SQUARE_HOST_LEDGER_LOCAL,
  });
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

async function openSquare(path: string, environment: NodeJS.ProcessEnv, ledger: ReturnType<typeof hostLedger>) {
  try {
    return await Square.at({ path, env: environment, hostLedger: ledger });
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "unavailable") throw error;
    try {
      return await Square.build({ path, markdown: "", env: environment, hostLedger: ledger });
    } catch (buildError) {
      try {
        return await Square.at({ path, env: environment, hostLedger: ledger });
      } catch {
        throw buildError;
      }
    }
  }
}

function outcomeExpression(signal: PluginSignalMap["akuma.turn-outcome"], caller: string | undefined): string {
  const header = [
    signal.akumaId,
    `turn/${signal.turnSequence}`,
    caller === undefined ? undefined : `(@${caller})`,
    signal.contractId,
  ]
    .filter((value) => value !== undefined)
    .join(" ");
  return signal.outcome.kind === "answered" ? `${header}\n✓ came back` : `${header}\n× ${signal.outcome.reason}`;
}

function calledExpression(signal: PluginSignalMap["akuma.called"]): string {
  const source = signal.callerAkumaId;
  return [source, "called", signal.akumaId].filter((value) => value !== undefined).join(" ");
}

const plugin: KeiyakuPlugin = {
  manifest: {
    id: "square",
    apiVersion: 1,
    writablePaths: [{ name: "square", path: ".square" }],
  },
  activate(context) {
    const path = join(context.writablePath("square"), "KEIYAKU.square");
    const environment = squareEnvironment(process.env, path);
    const ledger = hostLedger(environment);
    let caller: string | undefined;
    try {
      caller = squareAssignedParticipantName(environment);
    } catch {}
    return {
      signals: {
        async "akuma.called"(signal) {
          if (caller === undefined) return;
          const square = await openSquare(path, environment, ledger);
          try {
            const joined = await square.implicitJoin(caller);
            if (joined.state === "done" || joined.participant === undefined) return;
            await joined.participant.express(calledExpression(signal));
          } finally {
            await square.close();
          }
        },
        async "akuma.turn-outcome"(signal) {
          const square = await openSquare(path, environment, ledger);
          try {
            const joined = await square.implicitJoin(signal.akumaId);
            if (joined.state === "done" || joined.participant === undefined) return;
            await joined.participant.express(
              outcomeExpression(signal, caller),
              caller === undefined ? {} : { mentions: [caller] },
            );
          } finally {
            await square.close();
          }
        },
      },
    };
  },
};

export default plugin;
