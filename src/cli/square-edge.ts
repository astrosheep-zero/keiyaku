import {
  bindCurrentParticipant,
  Square,
  squareAssignedParticipantName,
  unbindCurrentParticipant,
} from "@astrosheep/square";
import type { AllocatedAkuma } from "../akuma/identity.js";
import { keiyakuSquarePath, type WorldRoot } from "../world.js";

const ROLLBACK_DIAGNOSTIC_LIMIT = 500;

function diagnostic(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= ROLLBACK_DIAGNOSTIC_LIMIT ? text : `${text.slice(0, ROLLBACK_DIAGNOSTIC_LIMIT)}...`;
}

function withCleanupDiagnostic(primary: unknown, cleanup: unknown): Error {
  const primaryText = primary instanceof Error ? primary.message : String(primary);
  const cleanupText = diagnostic(cleanup);
  return new Error(`${primaryText}; Square rollback failed: ${cleanupText}`, { cause: primary });
}

async function openKeiyakuSquare(path: string): Promise<Square> {
  try {
    return await Square.at({ path });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as { code?: unknown }).code !== "unavailable")
      throw error;
    try {
      return await Square.build({ path, markdown: "" });
    } catch (buildError) {
      try {
        return await Square.at({ path });
      } catch {
        throw buildError;
      }
    }
  }
}

export async function recognizeAndListen(
  worldRoot: WorldRoot,
  environment: NodeJS.ProcessEnv,
  allocated: AllocatedAkuma,
): Promise<{ committed: boolean; participantName: string; rollback(): Promise<void> } | void> {
  const name = squareAssignedParticipantName(environment);
  if (name === undefined) return;
  const path = keiyakuSquarePath(worldRoot);
  const square = await openKeiyakuSquare(path);
  let joined = false;
  let bound = false;
  let listening = false;
  let primaryError: unknown;
  let rollbackAttempted = false;
  const rollback = async (): Promise<void> => {
    const failures: string[] = [];
    const attempt = async (label: string, operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failures.push(`${label}: ${diagnostic(error)}`);
      }
    };
    if (listening || joined) {
      let rollbackSquare: Square | undefined;
      await attempt("open", async () => {
        rollbackSquare = await Square.at({ path });
      });
      let rollbackParticipant: Awaited<ReturnType<Square["join"]>> | undefined;
      if (rollbackSquare !== undefined)
        await attempt("join", async () => {
          rollbackParticipant = await rollbackSquare!.join(name);
        });
      if (rollbackParticipant !== undefined && listening)
        await attempt("ignore", async () => rollbackParticipant!.ignore(allocated.id));
      if (rollbackParticipant !== undefined && joined) await attempt("done", async () => rollbackParticipant!.done());
      if (rollbackSquare !== undefined) await attempt("close", async () => rollbackSquare!.close());
    }
    if (bound)
      await attempt("unbind", async () => {
        if (!(await unbindCurrentParticipant(path, name, environment)))
          throw new Error("participant binding was not removed");
      });
    if (failures.length > 0) throw new Error(`Square rollback failed: ${failures.join("; ")}`);
  };
  try {
    const joinedResult = await square.joinWithActivity(name);
    joined = joinedResult.activity !== null;
    const participant = joinedResult.participant;
    bound = (await bindCurrentParticipant(path, name, environment)).created;
    const listener = participant;
    let change;
    try {
      change = await listener.listen(allocated.id);
    } catch (error) {
      // Keep birth independent from an older or drifting Square name grammar.
      if ((error as { code?: unknown }).code === "invalid_name") {
        rollbackAttempted = true;
        try {
          await rollback();
        } catch (rollbackError) {
          primaryError = withCleanupDiagnostic(error, rollbackError);
          throw primaryError;
        }
        return;
      }
      throw error;
    }
    listening = change.activity !== null;
    return {
      committed: true,
      participantName: name,
      rollback,
    };
  } catch (error) {
    primaryError = error;
    if (!rollbackAttempted) {
      rollbackAttempted = true;
      try {
        await rollback();
      } catch (rollbackError) {
        primaryError = withCleanupDiagnostic(error, rollbackError);
        throw primaryError;
      }
    }
    throw error;
  } finally {
    try {
      await square.close();
    } catch (closeError) {
      if (primaryError !== undefined) throw withCleanupDiagnostic(primaryError, closeError);
      throw closeError;
    }
  }
}
