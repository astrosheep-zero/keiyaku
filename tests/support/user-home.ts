import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { restoreEnvironmentValues } from "./process.js";

const USER_HOME_NAMES = ["HOME", "USERPROFILE"] as const;

let coordinate: string | undefined;

/**
 * Point this test file's process user home at one empty temporary directory.
 *
 * A Body resolves user Settings from the process home, so the developer's own
 * `~/.keiyaku/settings.json` would otherwise activate ambient plugins inside every
 * fixture. HOME is the POSIX coordinate and USERPROFILE the Windows one; both move
 * together, and the previous environment returns when the file's root suite ends.
 */
export function isolateUserHome(): string {
  if (coordinate !== undefined) return coordinate;
  const previous = Object.fromEntries(USER_HOME_NAMES.map((name) => [name, process.env[name]]));
  coordinate = mkdtempSync(join(tmpdir(), "keiyaku-user-home-"));
  for (const name of USER_HOME_NAMES) process.env[name] = coordinate;
  assert.equal(homedir(), coordinate);
  assert.deepEqual(readdirSync(coordinate), []);
  after(() => {
    restoreEnvironmentValues(previous);
    rmSync(coordinate!, { recursive: true, force: true });
  });
  return coordinate;
}
