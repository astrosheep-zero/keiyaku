import { fileURLToPath } from "node:url";
import { spawnDetachedProcess } from "../runtime/proc/run.js";
import { diagnoseLaunchFailure, type BodyLaunch, type LiveBodyLaunch } from "./body-launch.js";
import { readSoul } from "./heart/index.js";
import { worldRootForAkumaPaths } from "./identity.js";
import { akumaExecutionEnvironment } from "./providers/execution-environment.js";

export const LEASH_HELD_EXIT = 75;

export async function bodyProcessInput(launch: BodyLaunch, bodyModuleUrl = import.meta.url) {
  const encoded = Buffer.from(JSON.stringify(launch), "utf8").toString("base64url");
  const soul = launch.seed ?? (await readSoul(launch.paths));
  if (soul === null) throw new Error("Akuma wake has no born soul");
  const executable = process.execPath;
  const source = bodyModuleUrl.endsWith(".ts");
  const entry = fileURLToPath(new URL(source ? "../akuma-body.ts" : "../akuma-body.js", bodyModuleUrl));
  return {
    akumaId: soul.id,
    argv: source ? [executable, "--import", import.meta.resolve("tsx"), entry, encoded] : [executable, entry, encoded],
    cwd: soul.cwd,
    env: akumaExecutionEnvironment(process.env, {
      KEIYAKU_ACTOR_ID: soul.id,
      KEIYAKU_ACTOR_WORLD: worldRootForAkumaPaths(launch.paths),
    }),
    log: launch.paths.log,
  };
}

export async function spawnAkumaBody(launch: BodyLaunch): Promise<LiveBodyLaunch> {
  const input = await bodyProcessInput(launch);
  try {
    const owned = await spawnDetachedProcess(input);
    const completed = owned.exited.then((exit) => ({
      diagnostic:
        exit.code === null ? `pre-admission signal ${exit.signal ?? "unknown"}` : `pre-admission exit ${exit.code}`,
      held: exit.code === LEASH_HELD_EXIT,
      child: { log: { path: exit.log.path } },
    }));
    void completed.catch(() => undefined);
    return {
      completed,
      cancel: (force) => owned.terminate(force),
      release: () => owned.release(),
    };
  } catch (error) {
    throw await diagnoseLaunchFailure(input, launch.seed === undefined, error);
  }
}
