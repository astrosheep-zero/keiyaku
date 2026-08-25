import { Square } from "@astrosheep/square";
import { join } from "node:path";
import type { AllocatedAkuma } from "../akuma/identity.js";
import type { WorldRoot } from "../world.js";

export async function recognizeAndListen(
  worldRoot: WorldRoot,
  environment: NodeJS.ProcessEnv,
  allocated: AllocatedAkuma,
): Promise<{ committed: boolean; rollback(): Promise<void> } | void> {
  const path = join(worldRoot, ".square", "PUBLIC.square");
  let square: Square;
  try {
    square = await Square.at({ path });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as { code?: unknown }).code === "unavailable")
      return;
    throw error;
  }
  try {
    const recognize = (square as unknown as { recognize?: (env: NodeJS.ProcessEnv) => Promise<unknown> }).recognize;
    if (recognize === undefined) return;
    const participant = await recognize.call(square, environment);
    if (participant === null) return;
    const listener = participant as {
      listen(target: string): Promise<{ activity: unknown | null }>;
      ignore(target: string): Promise<unknown>;
    };
    const change = await listener.listen(allocated.id);
    if (change.activity === null) return;
    return {
      committed: true,
      rollback: async () => {
        const rollbackSquare = await Square.at({ path });
        try {
          const current = (rollbackSquare as unknown as { recognize?: (env: NodeJS.ProcessEnv) => Promise<unknown> })
            .recognize;
          if (current === undefined) return;
          const rollbackParticipant = await current.call(rollbackSquare, environment);
          if (rollbackParticipant === null) return;
          await (rollbackParticipant as { ignore(target: string): Promise<unknown> }).ignore(allocated.id);
        } finally {
          await rollbackSquare.close();
        }
      },
    };
  } finally {
    await square.close();
  }
}
