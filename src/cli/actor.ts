import type { ActorId } from "../index.js";
import { CliUsageError } from "./usage.js";

const ACTOR_ID_ENV = "KEIYAKU_ACTOR_ID";

type ActorResolutionInput = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  actor?: string;
}>;

/** Resolve optional caller testimony from the current CLI edge vocabulary. */
export function resolveActor(input: ActorResolutionInput = {}): ActorId | undefined {
  if (input.actor !== undefined) {
    if (input.actor.trim().length === 0) throw new TypeError("actor must be a nonblank string");
    return input.actor;
  }
  const actorId = input.env?.[ACTOR_ID_ENV];
  return actorId !== undefined && actorId.trim().length > 0 ? actorId : undefined;
}

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
