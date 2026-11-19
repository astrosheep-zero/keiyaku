import { AkumaNotBornError, AkumaObservationError } from "./akuma-errors.js";
import { readSoul } from "./heart/index.js";
import { HeartNeedsUpgradeError } from "./heart/schema.js";
import { pathsForAkumaId, type AkumaId } from "./identity.js";
import type { WorldRoot } from "../world.js";

/**
 * How one Akuma coordinate stands in a World, decided in the single place that
 * reads a Heart for addressing. Absence and unreadability are different facts,
 * and each consumer below maps them to its own caller terms.
 */
export type AkumaAddressability =
  | Readonly<{ kind: "born" | "absent" }>
  | Readonly<{ kind: "unreadable" | "needs-upgrade"; reason: string }>;

export async function akumaAddressability(worldPath: WorldRoot, id: AkumaId): Promise<AkumaAddressability> {
  try {
    return (await readSoul(pathsForAkumaId(worldPath, id))) === null ? { kind: "absent" } : { kind: "born" };
  } catch (error) {
    const kind = error instanceof HeartNeedsUpgradeError ? "needs-upgrade" : "unreadable";
    return { kind, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The one normalization of addressability into caller terms: an Akuma whose
 * Heart is absent was never born, and one whose Heart cannot be read is an
 * observation failure. Only native mutation callers may defer the birth check
 * for a supported predecessor to their own admission.
 */
export async function requireBornAkuma(worldPath: WorldRoot, id: AkumaId, forWrite = false): Promise<void> {
  const addressability = await akumaAddressability(worldPath, id);
  if (addressability.kind === "absent") throw new AkumaNotBornError(id);
  if ("reason" in addressability && !(forWrite && addressability.kind === "needs-upgrade"))
    throw new AkumaObservationError(id, addressability.reason);
}
