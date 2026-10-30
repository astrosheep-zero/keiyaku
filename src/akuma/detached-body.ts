import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnDetachedProcess } from "../runtime/proc/run.js";
import type { BodyLaunch, LiveBodyLaunch } from "./body-launch.js";
import { readHeart } from "./heart/index.js";
import { worldRootForAkumaPaths } from "./identity.js";
import { akumaExecutionEnvironment } from "./providers/execution-environment.js";

export const LEASH_HELD_EXIT = 75;

async function launchCwd(launch: BodyLaunch): Promise<string> {
  if (launch.seed !== undefined) return launch.seed.cwd;
  const soul = (await readHeart(launch.paths)).soul;
  if (soul === null) throw new Error("Akuma wake has no born soul");
  return soul.cwd;
}

async function executableMissing(path: string): Promise<boolean> {
  try {
    return !(await stat(path)).isFile();
  } catch {
    return true;
  }
}

async function frozenCwdMissing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch {
    return true;
  }
}

/** Diagnose the attempted executable and frozen cwd independently; never substitute either. */
async function diagnoseSpawnEnoent(
  input: Readonly<{ argv: readonly string[]; cwd: string }>,
  cause: unknown,
): Promise<Error> {
  const executable = input.argv[0] ?? process.execPath;
  const cwd = input.cwd;
  const [noExecutable, noCwd] = await Promise.all([executableMissing(executable), frozenCwdMissing(cwd)]);
  if (!noExecutable && !noCwd) return cause instanceof Error ? cause : new Error(String(cause));
  const missing: string[] = [];
  if (noCwd) missing.push(`frozen execution directory ${cwd} no longer exists`);
  if (noExecutable)
    missing.push(
      `waking process executable ${executable} no longer exists (the host likely removed the running process binary)`,
    );
  const remedies: string[] = [];
  if (noCwd)
    remedies.push(
      "a missing execution directory likely means its Contract was accepted and the worktree cleaned up, with deliverables already in Git",
    );
  if (noExecutable)
    remedies.push(
      "a missing executable likely means the host removed the running process binary: re-enter with a fresh CLI process and retry",
    );
  const remedy = `kill this Akuma and call a fresh one; ${remedies.join("; ")}`;
  const error = new Error(`Body spawn failed: ${missing.join(" and ")}; ${remedy}`, { cause });
  (error as NodeJS.ErrnoException).code = "ENOENT";
  return error;
}

export async function bodyProcessInput(launch: BodyLaunch, bodyModuleUrl = import.meta.url) {
  const encoded = Buffer.from(JSON.stringify(launch), "utf8").toString("base64url");
  const actorId = launch.seed?.id ?? (await readHeart(launch.paths)).soul?.id;
  if (actorId === undefined) throw new Error("Akuma wake has no born soul");
  const executable = process.execPath;
  const source = bodyModuleUrl.endsWith(".ts");
  const entry = fileURLToPath(new URL(source ? "../akuma-body.ts" : "../akuma-body.js", bodyModuleUrl));
  return {
    argv: source ? [executable, "--import", import.meta.resolve("tsx"), entry, encoded] : [executable, entry, encoded],
    cwd: await launchCwd(launch),
    env: akumaExecutionEnvironment(process.env, {
      KEIYAKU_ACTOR_ID: actorId,
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
      child: { code: exit.code, signal: exit.signal, log: exit.log },
    }));
    void completed.catch(() => undefined);
    return {
      completed,
      cancel: (force) => owned.terminate(force),
      release: () => owned.release(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    throw await diagnoseSpawnEnoent(input, error);
  }
}
