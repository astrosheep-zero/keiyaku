export const AKUMA_REQUESTS_ENV = "AKUMA_REQUESTS";
export const AKUMA_REQUESTS_ENTRY_ENV = "AKUMA_REQUESTS_ENTRY";

export type ExecutionCoordinate = Readonly<{
  akumaId: string;
  world: string;
  bodySequence: number;
  turnSequence: number;
}>;

const PARENT_HARNESS_IDENTITY_KEYS = [
  "KEIYAKU_BODY_SEQUENCE",
  "KEIYAKU_TURN_SEQUENCE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDECODE",
  "CODEX_THREAD_ID",
  "OPENCODE_SESSION_ID",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PASEO_AGENT_ID",
  "SQUARE_PARTICIPANT_NAME",
  "KEIYAKU_INITIATOR",
  "KEIYAKU_EXTERNAL_CALLER",
] as const;

type Environment = Readonly<Record<string, string | undefined>>;

/** Construct the environment for one isolated Akuma execution or native child. */
export function akumaExecutionEnvironment(
  inherited: Environment,
  overrides: Environment = {},
  requests?: string,
  nativeIdentity: readonly (typeof PARENT_HARNESS_IDENTITY_KEYS)[number][] = [],
  execution?: ExecutionCoordinate,
): Record<string, string> {
  const preserved = Object.fromEntries(
    nativeIdentity.flatMap((key) => (inherited[key] === undefined ? [] : [[key, inherited[key]] as const])),
  );
  const environment = Object.fromEntries(
    Object.entries({ ...inherited, ...overrides }).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  ) as Record<string, string>;
  for (const key of PARENT_HARNESS_IDENTITY_KEYS) delete environment[key];
  Object.assign(environment, preserved);
  delete environment[AKUMA_REQUESTS_ENV];
  delete environment[AKUMA_REQUESTS_ENTRY_ENV];
  if (requests !== undefined) environment[AKUMA_REQUESTS_ENV] = requests;
  if (execution !== undefined)
    Object.assign(environment, {
      KEIYAKU_ACTOR_ID: execution.akumaId,
      KEIYAKU_ACTOR_WORLD: execution.world,
      KEIYAKU_BODY_SEQUENCE: String(execution.bodySequence),
      KEIYAKU_TURN_SEQUENCE: String(execution.turnSequence),
    });
  return environment;
}
