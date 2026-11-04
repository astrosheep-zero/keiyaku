import { decodeAkumaCaller, type AkumaCaller } from "./caller.js";
import type { Settings } from "../settings.js";
import { settings as readSettings } from "../settings.js";
import type { WorldRoot } from "../world.js";
import { AkumaOwner } from "./akuma-owner.js";
import { AkumaArchetypeError, loadPreparedArchetype } from "./archetype.js";
import type { BodyLauncher } from "./body-launch.js";
import { tellWakeRuntime, type TellResult } from "./body.js";
import type { CallInitialTell } from "./call-initial-tell.js";
import { bareOption, canonicalBirthCwd, writableDirectoriesOption } from "./call-input.js";
import { validateAkumaName } from "../identity/normalize.js";
import { type AllocatedAkuma } from "./identity.js";
import { PreparedCallAdmissionError, executePreparedCall } from "./publication.js";
import type { Schema } from "./schema.js";

export type AkumaCallInput = Readonly<{
  archetype: string;
  body?: string;
  cwd?: string;
  writableDirectories?: readonly string[];
  bare?: boolean;
  schema?: Schema<unknown>;
  initiator?: string;
  caller?: AkumaCaller;
  signal?: AbortSignal;
}>;
type AkumaCallContext = Readonly<{
  initiatorCwd?: string;
  cwdCanonical?: true;
}>;

export type AkumaConfiguration = Readonly<{ home?: string; settings?: Settings }>;

export type InitialCallTell = CallInitialTell;

/** One admitted call: the leading child identity plus the exact live initial Tell evidence when supplied. */
export type AdmittedAkumaCall = Readonly<{
  id: AllocatedAkuma["id"];
  cwd: string;
  execution: Readonly<{ cwd: string; source: "input" | "process" | "world" }>;
  tell?: TellResult;
  /** The native failure after a confirmed birth. */
  failure?: unknown;
}>;

type AkumaCallLaunchInput = Omit<AkumaCallInput, "body" | "schema"> &
  Readonly<{ initialTell?: InitialCallTell; contractId?: string }>;

async function callExecution(
  path: WorldRoot,
  input: AkumaCallLaunchInput,
  context: AkumaCallContext,
): Promise<AdmittedAkumaCall["execution"]> {
  const cwd =
    input.cwd !== undefined && context.cwdCanonical === true
      ? input.cwd
      : await canonicalBirthCwd(input.cwd ?? context.initiatorCwd ?? path);
  return { cwd, source: input.cwd !== undefined ? "input" : context.initiatorCwd === undefined ? "world" : "process" };
}

/** Load caller configuration once, then publish through the native birth owner. */
export async function admitAkumaCall(
  path: WorldRoot,
  configuration: AkumaConfiguration,
  input: AkumaCallLaunchInput,
  context: AkumaCallContext,
  spawn: BodyLauncher,
): Promise<AdmittedAkumaCall> {
  decodeAkumaCaller(input.caller);
  const name = validateAkumaName(input.archetype);
  const home = configuration.home === undefined ? {} : { home: configuration.home };
  const settings = configuration.settings ?? (await readSettings({ root: path, ...home }));
  const archetype = await loadPreparedArchetype({ name, project: path, ...home, settings });
  const writableDirectories = await writableDirectoriesOption(input.writableDirectories);
  if (writableDirectories.length > 0 && archetype.provider.kind !== "codex-app-server")
    throw new TypeError(`writableDirectories is unsupported by provider ${archetype.provider.kind}`);
  const recipe = Object.freeze({
    ...(archetype.description === undefined ? {} : { description: archetype.description }),
    provider: archetype.provider,
    options: archetype.options,
    bare: bareOption(input.bare) ?? false,
  });
  const execution = await callExecution(path, input, context);
  const { cwd } = execution;
  const launch: BodyLauncher = async (child) =>
    await spawn({
      ...child,
      ...(input.contractId === undefined ? {} : { completion: { contractId: input.contractId } }),
    });
  let result: Awaited<ReturnType<typeof executePreparedCall>>;
  try {
    result = await executePreparedCall({
      archetype: archetype.name,
      cwd,
      ...(input.writableDirectories === undefined ? {} : { writableDirectories: input.writableDirectories }),
      ...(input.caller === undefined ? {} : { caller: input.caller }),
      ...(input.initialTell === undefined ? {} : { initialTell: input.initialTell }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      world: path,
      recipe,
      spawn: async (child) =>
        await launch({
          ...child,
          ...(input.initiator === undefined ? {} : { birthInitiator: input.initiator }),
        }),
      admitInitialTell: async ({ id, initialTell, signal }) =>
        await new AkumaOwner(id, path).admitInitialTell(initialTell, {
          runtime: tellWakeRuntime(launch),
          ...(signal === undefined ? {} : { signal }),
        }),
    });
  } catch (error) {
    // Provider admission retains the initiating caller's Archetype-classified refusal.
    if (error instanceof PreparedCallAdmissionError) {
      throw new AkumaArchetypeError(
        archetype.name,
        [archetype.path],
        error.stage === "options" ? `is unsupported: ${error.diagnostic}` : `uses ${error.diagnostic}`,
      );
    }
    throw error;
  }
  return {
    id: result.child.id,
    cwd,
    execution,
    ...(result.tell === undefined ? {} : { tell: result.tell }),
    ...(result.failure === undefined ? {} : { failure: result.failure }),
  };
}
