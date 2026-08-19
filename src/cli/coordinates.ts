import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { NoGitWorldError, Repo } from "../index.js";
import { World, WorldError, type WorldRoot } from "../world.js";
import { CliUsageError, type ParsedCommand } from "./parse.js";

type RepoDiscovery =
  | Readonly<{ kind: "present"; repo: Repo }>
  | Readonly<{ kind: "absent"; error: NoGitWorldError }>;

type RepoUse = "none" | "optional" | "required";
type RepoPolicy = Readonly<{ use: RepoUse; acceptsExplicit: boolean }>;

export type CliCoordinates = Readonly<{
  cwd: string;
  cwdSource: "input" | "process";
  repo?: Repo;
  world: WorldRoot | null;
  candidateWorld: WorldRoot | null;
  establishWorld: () => Promise<WorldRoot>;
}>;

export type CliCoordinateInput = Readonly<{
  processCwd?: string;
  cwd?: string;
  repo?: string;
  gitPath?: string;
  command: ParsedCommand;
}>;

async function canonicalInvocationCwd(input: string): Promise<string> {
  try { return await realpath(input); }
  catch { throw new CliUsageError(`invocation cwd is not an existing directory: ${input}`); }
}

async function discoverRepoAt(coordinate: string, gitPath?: string): Promise<RepoDiscovery> {
  try {
    return {
      kind: "present",
      repo: await Repo.at({ path: coordinate, ...(gitPath === undefined ? {} : { gitPath }) }),
    };
  }
  catch (error) {
    if (error instanceof NoGitWorldError) return { kind: "absent", error };
    throw error;
  }
}

function repoPolicy(command: ParsedCommand): RepoPolicy {
  switch (command.command) {
    case "bind":
    case "amend":
    case "deliver":
    case "review":
    case "arc":
    case "abandon":
    case "audit":
    case "reconcile":
    case "show":
    case "region":
      return { use: "required", acceptsExplicit: true };
    case "ls":
      return { use: command.query.kind === "contracts" ? "required" : "none", acceptsExplicit: false };
    case "status":
    case "tell":
      return { use: "optional", acceptsExplicit: false };
    case "history":
      return "contract" in command
        ? { use: "required", acceptsExplicit: true }
        : { use: "optional", acceptsExplicit: false };
    case "fork":
      return { use: "optional", acceptsExplicit: true };
    case "wait":
    case "kill": {
      const contractSelector = command.akuma.some((selector) => selector.startsWith("kei/"));
      return { use: contractSelector ? "required" : "optional", acceptsExplicit: contractSelector };
    }
    case "call":
      return {
        use: command.contract === undefined ? "none" : "required",
        acceptsExplicit: command.contract !== undefined,
      };
    case "settings":
    case "task":
    case "install":
      return { use: "none", acceptsExplicit: false };
  }
}

function refuseUnusedRepo(command: ParsedCommand): never {
  if (command.command === "call") throw new CliUsageError("--repo has no consumer without --contract");
  throw new CliUsageError(`--repo has no consumer for ${command.command}`);
}

export function assertExplicitRepoUse(command: ParsedCommand, repo: string | undefined): void {
  if (repo !== undefined && !repoPolicy(command).acceptsExplicit) refuseUnusedRepo(command);
}

function repoFor(use: RepoUse, discovery: RepoDiscovery): Repo | undefined {
  if (use === "none") return undefined;
  if (discovery.kind === "present") return discovery.repo;
  if (use === "required") throw discovery.error;
  return undefined;
}

async function resolveWorld(cwd: string, repo: Repo | undefined) {
  try {
    const resolution = await World.resolve({ cwd, ...(repo === undefined ? {} : { repositoryRoot: repo.root }) });
    return {
      root: resolution.root,
      candidate: resolution.candidate,
      async establish(): Promise<WorldRoot> {
        try { return await resolution.establish(); }
        catch (error) {
          if (error instanceof WorldError) throw new CliUsageError(error.message);
          throw error;
        }
      },
    };
  } catch (error) {
    if (error instanceof WorldError) throw new CliUsageError(error.message);
    throw error;
  }
}

export async function resolveCliCoordinates(input: CliCoordinateInput): Promise<CliCoordinates> {
  const processCwd = resolve(input.processCwd ?? ".");
  const cwd = await canonicalInvocationCwd(resolve(processCwd, input.cwd ?? "."));
  const invocationRepo = await discoverRepoAt(cwd, input.gitPath);
  const selectedRepo = input.repo === undefined
    ? invocationRepo
    : await discoverRepoAt(resolve(cwd, input.repo), input.gitPath);
  const worldRepo = invocationRepo.kind === "present" ? invocationRepo.repo : undefined;
  const repo = repoFor(repoPolicy(input.command).use, selectedRepo);
  const world = await resolveWorld(cwd, worldRepo);
  return {
    cwd,
    cwdSource: input.cwd === undefined ? "process" : "input",
    ...(repo === undefined ? {} : { repo }),
    world: world.root,
    candidateWorld: world.candidate,
    establishWorld: world.establish,
  };
}
