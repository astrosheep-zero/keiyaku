const PROJECTION_ID_ENV = "KEIYAKU_PROJECTION_ID";

export type ActorResolutionInput = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  actor?: string;
}>;

/** Resolve optional caller testimony from the current CLI edge vocabulary. */
export function resolveActor(input: ActorResolutionInput = {}): string | undefined {
  if (input.actor !== undefined) {
    if (input.actor.trim().length === 0) throw new TypeError("actor must be a nonblank string");
    return input.actor;
  }
  const projectionId = input.env?.[PROJECTION_ID_ENV];
  return projectionId !== undefined && projectionId.trim().length > 0 ? projectionId : undefined;
}
