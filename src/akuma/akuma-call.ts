import { randomUUID } from "node:crypto";
import type { Settings } from "../settings.js";
import { settings as readSettings } from "../settings.js";
import type { WorldRoot } from "../world.js";
import { readAkumaBirthCwd } from "./akuma-observe.js";
import { AkumaOwner } from "./akuma-owner.js";
import { decodeAllowedActions, unionAllowedActions, type AllowedAction } from "./allowed.js";
import { AkumaArchetypeError, loadPreparedArchetype } from "./archetype.js";
import { spawnAkumaBody, type BodyLaunch, type TellResult } from "./body.js";
import type { CallInitialTell } from "./call-initial-tell.js";
import { canonicalBirthCwd } from "./call-input.js";
import { requestForwardedAkumaCall } from "./call-request.js";
import { archetypeName, type AllocatedAkuma } from "./identity.js";
import { PreparedCallAdmissionError, executePreparedCall } from "./publication.js";
import { executionChannel, type ExecutionContext } from "./requests.js";
import type { Schema } from "./schema.js";

type AkumaCallExecution = Readonly<{
  cwd: string;
  source: "input" | "caller" | "process" | "world";
}>;

export type AkumaCallInput = Readonly<{
  archetype: string;
  body?: string;
  cwd?: string;
  allowed?: readonly AllowedAction[];
  schema?: Schema<unknown>;
  initiator?: string;
  signal?: AbortSignal;
}>;
type AkumaCallContext = Readonly<{
  initiatorCwd?: string;
  cwdCanonical?: true;
}>;

export type AkumaConfiguration = Readonly<{ home?: string; settings?: Settings; execution?: ExecutionContext }>;

export type InitialCallTell = CallInitialTell;

/** One admitted call: the leading child identity plus the exact live initial Tell evidence when supplied. */
export type AdmittedAkumaCall = Readonly<{
  id: AllocatedAkuma["id"];
  cwd: string;
  execution: AkumaCallExecution;
  /** True when the serving process was reached through the one direct-parent request channel. */
  requested: boolean;
  tell?: TellResult;
  /** The native local failure, or the request transport's diagnostic text, after a confirmed birth. */
  failure?: unknown;
}>;

type AkumaCallRecipe = Omit<NonNullable<BodyLaunch["seed"]>, "id" | "archetype" | "cwd" | "origin">;

type AkumaCallLaunchInput = Omit<AkumaCallInput, "body" | "schema"> &
  Readonly<{ initialTell?: InitialCallTell; contractId?: string }>;

async function admitBodyRequest(input: {
  call: AkumaCallLaunchInput;
  context: AkumaCallContext;
  path: WorldRoot;
  name: string;
  recipe: AkumaCallRecipe;
  execution: Extract<ReturnType<typeof executionChannel>, { kind: "body-request" }>;
}): Promise<AdmittedAkumaCall> {
  const cwd =
    input.call.cwd === undefined
      ? undefined
      : input.context.cwdCanonical === true
        ? input.call.cwd
        : await canonicalBirthCwd(input.call.cwd);
  const response = await requestForwardedAkumaCall({
    directory: input.execution.directory,
    id: randomUUID(),
    world: input.path,
    archetype: input.name,
    ...(input.call.initialTell === undefined ? {} : { initialTell: input.call.initialTell }),
    ...(cwd === undefined ? {} : { cwd }),
    recipe: input.recipe,
    ...(input.call.signal === undefined ? {} : { signal: input.call.signal }),
  });
  const bornCwd = await readAkumaBirthCwd(input.path, response.id);
  return {
    id: response.id,
    cwd: bornCwd,
    requested: true,
    execution: { cwd: bornCwd, source: cwd === undefined ? "caller" : "input" },
    ...(response.kind === "live" && response.tell !== undefined ? { tell: response.tell } : {}),
    ...(response.kind === "live" && response.tellFailure !== undefined ? { failure: response.tellFailure } : {}),
    ...(response.kind === "reference" && input.call.initialTell !== undefined
      ? { failure: `Akuma ${response.id} was born without its exact initial Tell receipt` }
      : {}),
  };
}

async function admitDirect(input: {
  call: AkumaCallLaunchInput;
  context: AkumaCallContext;
  path: WorldRoot;
  archetype: Awaited<ReturnType<typeof loadPreparedArchetype>>;
  recipe: AkumaCallRecipe;
}): Promise<AdmittedAkumaCall> {
  const initiatorCwd = input.context.initiatorCwd;
  const selectedCwd = input.call.cwd ?? initiatorCwd ?? input.path;
  const cwd =
    input.call.cwd !== undefined && input.context.cwdCanonical === true
      ? input.call.cwd
      : await canonicalBirthCwd(selectedCwd);
  let result: Awaited<ReturnType<typeof executePreparedCall>>;
  try {
    result = await executePreparedCall({
      archetype: input.archetype.name,
      cwd,
      ...(input.call.initialTell === undefined ? {} : { initialTell: input.call.initialTell }),
      ...(input.call.signal === undefined ? {} : { signal: input.call.signal }),
      custody: {
        kind: "local",
        world: input.path,
        recipe: input.recipe,
        spawn: async (launch) =>
          await spawnAkumaBody({
            paths: launch.paths,
            seed: launch.seed,
            ...(input.call.contractId === undefined ? {} : { completion: { contractId: input.call.contractId } }),
          }),
        admitInitialTell: async ({ id, initialTell, signal }) =>
          await new AkumaOwner(id, input.path).admitInitialTell(initialTell, {
            ...(signal === undefined ? {} : { signal }),
          }),
      },
    });
  } catch (error) {
    // The executor owns provider admission; this local edge restores the
    // Archetype-classified refusal the initiating caller has always seen.
    if (error instanceof PreparedCallAdmissionError) {
      throw new AkumaArchetypeError(
        input.archetype.name,
        [input.archetype.path],
        error.stage === "options" ? `is unsupported: ${error.diagnostic}` : `uses ${error.diagnostic}`,
      );
    }
    throw error;
  }
  return {
    id: result.child.id,
    cwd,
    requested: false,
    execution: {
      cwd,
      source: input.call.cwd !== undefined ? "input" : initiatorCwd === undefined ? "world" : "process",
    },
    ...(result.tell === undefined ? {} : { tell: result.tell }),
    ...(result.failure === undefined ? {} : { failure: result.failure }),
  };
}

/**
 * The one lower recipe preparer and admission edge used by plural creation and
 * standalone birth: load the caller Archetype/Settings, freeze allowed and cwd,
 * then invoke the P3 prepared-call executor under local or request custody.
 */
export async function admitAkumaCall(
  path: WorldRoot,
  configuration: AkumaConfiguration,
  input: AkumaCallLaunchInput,
  context: AkumaCallContext,
): Promise<AdmittedAkumaCall> {
  const name = archetypeName(input.archetype);
  const home = configuration.home === undefined ? {} : { home: configuration.home };
  const settings = configuration.settings ?? (await readSettings({ root: path, ...home }));
  const archetype = await loadPreparedArchetype({ name, project: path, ...home, settings });
  const allowed =
    input.allowed === undefined
      ? archetype.allowed
      : unionAllowedActions(archetype.allowed, decodeAllowedActions(input.allowed, "Akuma call allowed"));
  const execution = executionChannel(configuration.execution);
  const requestRecipe = Object.freeze({
    ...(archetype.description === undefined ? {} : { description: archetype.description }),
    provider: archetype.provider,
    options: archetype.options,
    allowed,
  });
  if (execution.kind === "body-request")
    return await admitBodyRequest({ call: input, context, path, name, recipe: requestRecipe, execution });
  return await admitDirect({ call: input, context, path, archetype, recipe: requestRecipe });
}
