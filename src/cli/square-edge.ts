import {
  bindCurrentParticipant,
  Square,
  squareAssignedParticipantName,
  unbindCurrentParticipant,
} from "@astrosheep/square";
import type { AllocatedAkuma } from "../akuma/identity.js";
import { keiyakuSquarePath, type WorldRoot } from "../world.js";

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
  const rollback = async (): Promise<void> => {
    if (listening || joined) {
      const rollbackSquare = await Square.at({ path });
      try {
        const rollbackParticipant = await rollbackSquare.join(name);
        if (listening) await rollbackParticipant.ignore(allocated.id);
        if (joined) await rollbackParticipant.done();
      } finally {
        await rollbackSquare.close();
      }
    }
    if (bound) await unbindCurrentParticipant(path, name, environment);
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
        await rollback();
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
    try {
      await rollback();
    } catch {
      /* preserve the original Square edge failure */
    }
    throw error;
  } finally {
    await square.close();
  }
}
