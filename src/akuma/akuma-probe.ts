import { readSoul } from "./heart/index.js";
import { pathsForAkuId, type AkuId } from "./identity.js";
import type { WorldRoot } from "../world.js";

export async function probeBornAkuma(worldPath: WorldRoot, id: AkuId): Promise<boolean> {
  const soul = await readSoul(pathsForAkuId(worldPath, id));
  return soul !== null;
}
