import type { ActorId } from "../index.js";

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
