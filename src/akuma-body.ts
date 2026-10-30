import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { driveAkumaBody } from "./akuma/body.js";
import { bodyLaunchSchema } from "./akuma/body-launch.js";
import { LEASH_HELD_EXIT, spawnAkumaBody } from "./akuma/detached-body.js";
import { externalRequestCommandsFor, bodyProcessConfiguration } from "./body-requests.js";

async function runBodyEntrypoint(): Promise<void> {
  const encoded = process.argv[2];
  if (encoded === undefined) throw new TypeError("Akuma body launch payload is missing");
  const launch = bodyLaunchSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  const spawn = spawnAkumaBody;
  const { world, commands, executionAssociation } = await externalRequestCommandsFor(
    launch,
    bodyProcessConfiguration(),
    spawn,
  );
  if (
    (await driveAkumaBody(launch, undefined, {
      world,
      externalCommands: commands,
      executionAssociation,
      spawn,
      requestSpawn: spawn,
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
