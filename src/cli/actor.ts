import type { ActorId } from "../index.js";
import { resolveActor } from "../library/keiyaku-attribution.js";
import { CliUsageError } from "./usage.js";

/** Resolve edge actor testimony, refusing malformed caller input as usage. */
export function actorFromEdge(
  actor: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): ActorId | undefined {
  try {
    return resolveActor({ env: environment, ...(actor === undefined ? {} : { actor }) });
  } catch (error) {
    if (error instanceof Error && "executionReceipt" in error) throw error;
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}
