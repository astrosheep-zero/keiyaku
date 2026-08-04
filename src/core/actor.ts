const PROJECTION_ID_ENV = "KEIYAKU_PROJECTION_ID";
// The runtime grammar requires the Unicode Sets `v` flag, beyond this project's ES2023 emit target.
const HUMAN_PROFILE = new RegExp("^(?:[a-z0-9\\-]|\\p{RGI_Emoji})+$", "v");
const PROJECTION_SUFFIX = /^[0-9a-f]{8}$/;

export type ActorResolutionCode =
  | "missing-actor"
  | "invalid-projection-id"
  | "invalid-actor"
  | "actor-conflict";

/** An input refusal at the process boundary before a verb receives an actor. */
export class ActorResolutionError extends TypeError {
  readonly code: ActorResolutionCode;

  constructor(code: ActorResolutionCode, message: string) {
    super(message);
    this.name = "ActorResolutionError";
    this.code = code;
  }
}

export type ActorResolutionInput = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  actor?: string;
}>;

function isAkuProjectionIdentity(value: string): boolean {
  if (!value.startsWith("aku/")) return false;

  const segments = value.slice("aku/".length).split("/");
  if (segments.length !== 1 && segments.length !== 2) return false;
  if (!HUMAN_PROFILE.test(segments[0]!)) return false;

  return segments.length === 2 && PROJECTION_SUFFIX.test(segments[1]!);
}

function assertProjectionIdentity(
  value: unknown,
): asserts value is string {
  if (typeof value === "string" && isAkuProjectionIdentity(value)) return;

  throw new ActorResolutionError(
    "invalid-projection-id",
    `invalid ${PROJECTION_ID_ENV}: expected complete aku/<human-profile>/<lower-hex8>; refusing --actor fallback`,
  );
}

function assertNonblankActor(value: unknown): asserts value is string {
  if (typeof value === "string" && value.trim().length > 0) return;

  throw new ActorResolutionError("invalid-actor", "invalid --actor value: expected a nonblank string");
}

/**
 * Resolve the one actor that may enter a verb input.
 *
 * The caller supplies the environment explicitly so resolution remains pure.
 */
export function resolveActor(input: ActorResolutionInput = {}): string {
  const projectionId = input.env?.[PROJECTION_ID_ENV];
  const hasProjectionId = projectionId !== undefined;
  const hasActor = input.actor !== undefined;

  if (hasProjectionId) {
    assertProjectionIdentity(projectionId);

    if (hasActor) {
      assertNonblankActor(input.actor);
      if (projectionId !== input.actor) {
        throw new ActorResolutionError(
          "actor-conflict",
          `${PROJECTION_ID_ENV} and --actor must be exact-string identical when both are provided`,
        );
      }
    }

    return projectionId;
  }

  if (!hasActor) {
    throw new ActorResolutionError(
      "missing-actor",
      `actor identity is required: set ${PROJECTION_ID_ENV} or pass --actor <actor>`,
    );
  }

  assertNonblankActor(input.actor);
  return input.actor;
}
