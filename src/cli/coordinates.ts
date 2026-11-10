import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  invocationCoordinates,
  KeiyakuUsageError,
  type InvocationCoordinates,
} from "../library/keiyaku-coordinates.js";
import { commandRepoPolicy, type ParsedCommand } from "./parse.js";

export type CliCoordinates = InvocationCoordinates;

export async function resolveInvocationCwd(input: Readonly<{ processCwd?: string; cwd?: string }>): Promise<string> {
  const processCwd = resolve(input.processCwd ?? ".");
  const cwd = resolve(processCwd, input.cwd ?? ".");
  try {
    return await realpath(cwd);
  } catch {
    throw new KeiyakuUsageError(`invocation cwd is not an existing directory: ${cwd}`);
  }
}

type InvocationCoordinatesInput = Readonly<{
  processCwd?: string;
  cwd?: string;
  repo?: string;
  command: ParsedCommand;
}>;

/** Adapt process-edge path spelling and semantic Repo policy to invocation coordinates. */
export async function resolveInvocationCoordinates(
  invocation: InvocationCoordinatesInput,
  environment: NodeJS.ProcessEnv,
): Promise<CliCoordinates> {
  const cwd = resolve(resolve(invocation.processCwd ?? "."), invocation.cwd ?? ".");
  return invocationCoordinates({
    cwd,
    ...(invocation.repo === undefined ? {} : { repo: invocation.repo }),
    environment,
    use: commandRepoPolicy(invocation.command).use,
  });
}
