import { AkumaNotBornError, AkumaObservationError } from "./akuma-errors.js";
import { readSoul } from "./heart/index.js";
import { pathsForAkuId, type AkuId } from "./identity.js";
import type { WorldRoot } from "../world.js";

/**
 * How one Akuma coordinate stands in a World, decided in the single place that
 * reads a Heart for addressing. Absence and unreadability are different facts,
 * and each consumer below maps them to its own caller terms.
 */
export type AkumaAddressability =
  | Readonly<{ kind: "born" }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unreadable"; reason: string }>;

export async function akumaAddressability(worldPath: WorldRoot, id: AkuId): Promise<AkumaAddressability> {
  try {
    return (await readSoul(pathsForAkuId(worldPath, id))) === null ? { kind: "absent" } : { kind: "born" };
  } catch (error) {
    return { kind: "unreadable", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The one normalization of addressability into caller terms: an Akuma whose
 * Heart is absent was never born, and one whose Heart cannot be read is an
 * observation failure that keeps its reason with the identity.
 */
export async function requireBornAkuma(worldPath: WorldRoot, id: AkuId): Promise<void> {
  const addressability = await akumaAddressability(worldPath, id);
  if (addressability.kind === "absent") throw new AkumaNotBornError(id);
  if (addressability.kind === "unreadable") throw new AkumaObservationError(id, addressability.reason);
}
