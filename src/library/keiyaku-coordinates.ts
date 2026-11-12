import { KeiyakuError } from "../errors.js";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { World, WorldError, type WorldRoot } from "../world.js";
import { NoGitWorldError, Repo } from "./repo.js";
import type { ContractId } from "../core/facts/types.js";

/** Invalid arc material retains the resolved subject for the process-edge refusal. */
export class KeiyakuArcDocumentError extends KeiyakuError {
  constructor(
    readonly contract: ContractId,
    cause: Error,
  ) {
    super("internal", cause.message, { cause });
  }
}
export class KeiyakuUsageError extends KeiyakuError {
  constructor(message: string) {
    super("internal", message);
  }
}

export type InvocationCoordinates = Readonly<{
  cwd: string;
  repo?: Repo;
  world: WorldRoot | null;
  candidateWorld: WorldRoot | null;
  establishWorld: () => Promise<WorldRoot>;
}>;

type RepoDiscovery = Readonly<{ kind: "present"; repo: Repo }> | Readonly<{ kind: "absent"; error: NoGitWorldError }>;

async function discoverRepo(path: string, gitPath?: string): Promise<RepoDiscovery> {
  try {
    return { kind: "present", repo: await Repo.at({ path, ...(gitPath === undefined ? {} : { gitPath }) }) };
  } catch (error) {
    if (error instanceof NoGitWorldError) return { kind: "absent", error };
    throw error;
  }
}

export async function invocationCoordinates(
  input: Readonly<{
    cwd: string;
    repo?: string;
    environment: Readonly<Record<string, string | undefined>>;
    use: "none" | "optional" | "required";
    contractWait?: boolean;
  }>,
): Promise<InvocationCoordinates> {
  const gitPath = input.environment.KEIYAKU_GIT_PATH;
  if (gitPath !== undefined && gitPath.trim() === "")
    throw new KeiyakuUsageError("KEIYAKU_GIT_PATH requires a nonblank value");
  let cwd: string;
  try {
    cwd = await realpath(input.cwd);
  } catch {
    throw new KeiyakuUsageError(`invocation cwd is not an existing directory: ${input.cwd}`);
  }
  const invocation = input.contractWait === true ? undefined : await discoverRepo(cwd, gitPath);
  const selected =
    input.repo === undefined && invocation !== undefined
      ? invocation
      : await discoverRepo(input.repo === undefined ? cwd : resolve(cwd, input.repo), gitPath);
  if (input.use === "required" && selected.kind === "absent") throw selected.error;
  const repo = input.use !== "none" && selected.kind === "present" ? selected.repo : undefined;
  if (input.contractWait === true) {
    return {
      cwd,
      ...(repo === undefined ? {} : { repo }),
      world: null,
      candidateWorld: null,
      establishWorld: async () => {
        throw new Error("Contract wait has no World");
      },
    };
  }
  const worldRepo = invocation?.kind === "present" ? invocation.repo : undefined;
  try {
    const world = await World.resolve({ cwd, ...(worldRepo === undefined ? {} : { repositoryRoot: worldRepo.root }) });
    return {
      cwd,
      ...(repo === undefined ? {} : { repo }),
      world: world.root,
      candidateWorld: world.candidate,
      establishWorld: async () => {
        try {
          return await world.establish();
        } catch (error) {
          if (error instanceof WorldError) throw new KeiyakuUsageError(error.message);
          throw error;
        }
      },
    };
  } catch (error) {
    if (error instanceof WorldError) throw new KeiyakuUsageError(error.message);
    throw error;
  }
}
