import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { driveAkumaBody } from "./akuma/body.js";
import { bodyLaunchSchema } from "./akuma/body-launch.js";
import { LEASH_HELD_EXIT, spawnAkumaBody } from "./akuma/detached-body.js";
import { bodyExecutionContext } from "./body-host.js";

async function runBodyEntrypoint(): Promise<void> {
  const encoded = process.argv[2];
  if (encoded === undefined) throw new TypeError("Akuma body launch payload is missing");
  const launch = bodyLaunchSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  const spawn = spawnAkumaBody;
  const context = await bodyExecutionContext(launch);
  if (
    (await driveAkumaBody(launch, undefined, {
      ...context,
      spawn,
    })) === "held"
  )
    process.exitCode = LEASH_HELD_EXIT;
}

/** Only the spawned entrypoint launches a Body; importing this module composes commands without side effects. */
function invokedAsBodyEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (invokedAsBodyEntrypoint()) await runBodyEntrypoint();
