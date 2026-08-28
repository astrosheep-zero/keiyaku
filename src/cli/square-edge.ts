import {
  bindCurrentParticipant,
  createHostLedgerPort,
  Square,
  squareAssignedParticipantName,
  type HostLedgerPort,
  type PresenceRecord,
} from "@astrosheep/square";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AllocatedAkuma } from "../akuma/identity.js";
import { keiyakuSquarePath, type WorldRoot } from "../world.js";

type SquareInvocationEnvironment = NodeJS.ProcessEnv & {
  SQUARE_HOST_LEDGER_USER: string;
  SQUARE_HOST_LEDGER_LOCAL: string;
};
type PresenceKey = Pick<PresenceRecord, "location" | "participant" | "session" | "channel">;

async function openKeiyakuSquare(
  path: string,
  environment: NodeJS.ProcessEnv,
  hostLedger: HostLedgerPort,
): Promise<Square> {
  try {
    return await Square.at({ path, env: environment, hostLedger });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as { code?: unknown }).code !== "unavailable")
      throw error;
    try {
      return await Square.build({ path, markdown: "", env: environment, hostLedger });
    } catch (buildError) {
      try {
        return await Square.at({ path, env: environment, hostLedger });
      } catch {
        throw buildError;
      }
    }
  }
}

function squareInvocationEnvironment(environment: NodeJS.ProcessEnv, path: string): SquareInvocationEnvironment {
  const ledgerRoot = environment.SQUARE_REGISTRY === undefined ? undefined : dirname(environment.SQUARE_REGISTRY);
  return {
    ...environment,
    SQUARE_HOST_LEDGER_USER:
      environment.SQUARE_HOST_LEDGER_USER ?? ledgerRoot ?? join(homedir(), ".square", "host-ledger"),
    SQUARE_HOST_LEDGER_LOCAL:
      environment.SQUARE_HOST_LEDGER_LOCAL ??
      ledgerRoot ??
      join(environment.PWD ?? dirname(path), ".square", "host-ledger"),
  };
}

function invocationHostLedger(environment: SquareInvocationEnvironment): HostLedgerPort {
  return createHostLedgerPort({
    userPath: environment.SQUARE_HOST_LEDGER_USER,
    localPath: environment.SQUARE_HOST_LEDGER_LOCAL,
  });
}

async function participantBindings(hostLedger: HostLedgerPort, path: string, name: string) {
  return await hostLedger.listPresence({ location: path, participant: name });
}

function presenceKey({ location, participant, session, channel }: PresenceKey): string {
  return JSON.stringify([location, participant, session, channel]);
}

function exactPresenceKey({ location, participant, session, channel }: PresenceRecord): PresenceKey {
  return { location, participant, session, channel };
}

async function bestEffort(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {}
}

async function rollbackSquareEdge(input: {
  path: string;
  environment: SquareInvocationEnvironment;
  hostLedger: HostLedgerPort;
  name: string;
  allocated: AllocatedAkuma;
  joined: boolean;
  listening: boolean;
  createdBindings: readonly PresenceKey[];
}): Promise<void> {
  const { path, environment, hostLedger, name, allocated, joined, listening, createdBindings } = input;
  if (listening || joined) {
    let square: Square | undefined;
    await bestEffort(async () => {
      square = await Square.at({ path, env: environment, hostLedger });
    });
    let participant: Awaited<ReturnType<Square["join"]>> | undefined;
    if (square !== undefined)
      await bestEffort(async () => {
        participant = await square!.join(name);
      });
    if (participant !== undefined && listening) await bestEffort(async () => participant!.ignore(allocated.id));
    if (participant !== undefined && joined) await bestEffort(async () => participant!.done());
    if (square !== undefined) await bestEffort(async () => square!.close());
  }
  for (const binding of createdBindings) await bestEffort(async () => hostLedger.removePresence(binding));
}

export async function recognizeAndListen(
  worldRoot: WorldRoot,
  environment: NodeJS.ProcessEnv,
  allocated: AllocatedAkuma,
): Promise<{ committed: boolean; participantName: string; rollback(): Promise<void> } | void> {
  const path = keiyakuSquarePath(worldRoot);
  const squareEnvironment = squareInvocationEnvironment(environment, path);
  let name: string;
  try {
    const assigned = squareAssignedParticipantName(squareEnvironment);
    if (assigned === undefined) return;
    name = assigned;
  } catch {
    return;
  }
  const hostLedger = invocationHostLedger(squareEnvironment);
  let joined = false;
  let listening = false;
  let bindingsBeforeCall: readonly PresenceRecord[] = [];
  let hasBindingSnapshot = false;
  let createdBindings: readonly PresenceKey[] = [];
  const rememberCreatedBindings = async (): Promise<void> => {
    const beforeKeys = new Set(bindingsBeforeCall.map(presenceKey));
    createdBindings = (await participantBindings(hostLedger, path, name))
      .filter((binding) => !beforeKeys.has(presenceKey(binding)))
      .map(exactPresenceKey);
  };
  const refreshCreatedBindings = async (): Promise<void> => {
    try {
      await rememberCreatedBindings();
    } catch {}
  };
  const rollback = async (): Promise<void> =>
    await rollbackSquareEdge({
      path,
      environment: squareEnvironment,
      hostLedger,
      name,
      allocated,
      joined,
      listening,
      createdBindings,
    });
  let square: Square | undefined;
  try {
    bindingsBeforeCall = await participantBindings(hostLedger, path, name);
    hasBindingSnapshot = true;
    square = await openKeiyakuSquare(path, squareEnvironment, hostLedger);
    const joinedResult = await square.joinWithActivity(name);
    joined = joinedResult.activity !== null;
    const participant = joinedResult.participant;
    await bindCurrentParticipant(path, name, squareEnvironment);
    await rememberCreatedBindings();
    const listener = participant;
    let change;
    try {
      change = await listener.listen(allocated.id);
    } catch {
      // Keep birth independent from an older or drifting Square name grammar.
      await refreshCreatedBindings();
      await rollback();
      return;
    }
    listening = change.activity !== null;
    await square.close();
    square = undefined;
    return {
      committed: true,
      participantName: name,
      rollback,
    };
  } catch {
    if (hasBindingSnapshot) await refreshCreatedBindings();
    await rollback();
    return;
  } finally {
    if (square !== undefined) await square.close().catch(() => undefined);
  }
}
