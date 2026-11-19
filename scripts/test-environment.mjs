import { join } from "node:path";

/**
 * Caller-facing environment namespaces. Everything inside them belongs to the
 * process that launched the tests, including coordinates, configuration, and
 * test-only sentinels, so a test child starts with none of it. The list is the
 * one owner of what the test boundary removes; consumers and tests read it
 * rather than maintaining a second inventory.
 */
export const CALLER_ENVIRONMENT_PREFIXES = Object.freeze([
  "KEIYAKU_",
  "SQUARE_",
  "PASEO_",
  "CLAUDE_CODE_",
  "CODEX_",
  "OPENCODE_",
  "PI_SESSION_",
]);

/** Exact caller names that are not prefixes. */
export const CALLER_ENVIRONMENT_NAMES = Object.freeze(["CLAUDECODE"]);

/**
 * Documented test inputs that remain selectable across the boundary. They are
 * not caller identity: a test explicitly chooses them, and their own consumers
 * document the meaning. Keep this list next to the scrub owner so no fixture
 * invents a second exception.
 */
export const TEST_ENVIRONMENT_SELECTORS = Object.freeze(["KEIYAKU_PUBLIC_PACKAGE"]);

/**
 * Recognize one inherited environment key. On Windows environment keys are
 * case-insensitive, so the comparison folds case there; elsewhere the key's
 * exact spelling decides. This is the only recognition path for the test
 * boundary.
 *
 * @param {string} key
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function isCallerEnvironmentKey(key, platform = process.platform) {
  const candidate = platform === "win32" ? key.toUpperCase() : key;
  if (TEST_ENVIRONMENT_SELECTORS.includes(candidate)) return false;
  return (
    CALLER_ENVIRONMENT_NAMES.includes(candidate) ||
    CALLER_ENVIRONMENT_PREFIXES.some((prefix) => candidate.startsWith(prefix))
  );
}

/**
 * Build the environment for one test child. The builder is pure: it copies the
 * caller's ambient values without mutating them, keeps unrelated configuration
 * such as proxy settings and neutral fixture inputs, removes every caller-facing
 * namespace except documented selectors, then installs the fixture-owned home,
 * Keiyaku home, and Square ledger. A fixture that models caller identity adds it
 * after this boundary.
 *
 * @param {Readonly<Record<string, string | undefined>>} inherited
 * @param {string} home
 * @returns {Record<string, string>}
 */
export function isolatedTestEnvironment(inherited, home) {
  /** @type {Record<string, string>} */
  const environment = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) environment[key] = value;
  }
  for (const key of Object.keys(environment)) {
    if (isCallerEnvironmentKey(key)) delete environment[key];
  }
  environment.HOME = home;
  environment.USERPROFILE = home;
  environment.KEIYAKU_HOME = home;
  environment.SQUARE_DELIVERY = join(home, "delivery.sqlite");
  return environment;
}
