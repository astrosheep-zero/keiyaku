import { isAbsolute, resolve } from "node:path";
import { clipAllowedActions, decodeAllowedActions, type AllowedActions } from "./allowed.js";
import { refuseRequest, reserveRequest, type Soul } from "./heart/index.js";
import { archetypeName, parseAkuId, worldRootForAkumaPaths, type AkuId, type AkumaPaths } from "./identity.js";
import { publishAkuma } from "./publication.js";
import { decodeProviderOptions, decodeReadonlyRestraint, type ReadonlyRestraint } from "./provider-recipe.js";
import { decodeProviderExecution } from "./providers/index.js";
import { requestBodyCommand } from "./request-rendezvous.js";
import { eraseRequestCommand, type ErasedRequestCommand, type RequestCommand } from "./request-wire.js";
import type { OwnedProcess } from "../runtime/proc/run.js";

export type AkumaCallRecipe = Readonly<{
  description?: string;
  allowed: AllowedActions;
  provider: ReturnType<typeof decodeProviderExecution>;
  options: ReturnType<typeof decodeProviderOptions>;
  readonly?: ReadonlyRestraint;
}>;

export type AkumaCallRequest = Readonly<{
  action: "akuma.call";
  world: string;
  archetype: string;
  body: string;
  cwd?: string;
  recipe: AkumaCallRecipe;
}>;

export type AkumaCallRequestChildLaunch = Readonly<{
  paths: AkumaPaths;
  seed: Omit<Soul, "createdAt">;
  initialBody: string;
}>;

type CallExecutionContext = Readonly<{
  id: string;
  requester: string;
  signal: AbortSignal;
  paths: AkumaPaths;
  parent: Soul;
  spawn(launch: AkumaCallRequestChildLaunch): Promise<OwnedProcess | void>;
  admissionOpen(): boolean;
}>;

function decodeCallExecutionContext(value: unknown): CallExecutionContext {
  const context = object(value);
  const paths = object(context?.paths);
  const parent = object(context?.parent);
  const parentId = canonicalAkuId(parent?.id);
  if (
    context === null ||
    typeof context.id !== "string" ||
    context.id.trim() === "" ||
    typeof context.requester !== "string" ||
    typeof context.signal !== "object" ||
    context.signal === null ||
    typeof (context.signal as { throwIfAborted?: unknown }).throwIfAborted !== "function" ||
    paths === null ||
    !["directory", "heart", "leash", "log", "requests"].every((key) => typeof paths[key] === "string") ||
    parent === null ||
    parentId === null ||
    typeof parent.cwd !== "string" ||
    !Array.isArray(parent.allowed) ||
    typeof context.spawn !== "function" ||
    typeof context.admissionOpen !== "function"
  )
    throw new Error("invalid Akuma call execution context");
  return {
    id: context.id,
    requester: context.requester,
    signal: context.signal as AbortSignal,
    paths: context.paths as AkumaPaths,
    parent: context.parent as Soul,
    spawn: context.spawn as CallExecutionContext["spawn"],
    admissionOpen: context.admissionOpen as CallExecutionContext["admissionOpen"],
  };
}

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function absolute(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}

function canonicalAkuId(value: unknown): AkuId | null {
  if (typeof value !== "string") return null;
  try {
    const id = parseAkuId(value).id;
    return id === value ? id : null;
  } catch {
    return null;
  }
}

export function decodeAkumaCallRecipe(value: unknown): AkumaCallRecipe | null {
  const recipe = object(value);
  if (recipe === null) return null;
  const expected = [
    "allowed",
    "options",
    "provider",
    ...(recipe.description === undefined ? [] : ["description"]),
    ...(recipe.readonly === undefined ? [] : ["readonly"]),
  ];
  if (
    !exactKeys(recipe, expected) ||
    (recipe.description !== undefined &&
      (typeof recipe.description !== "string" || recipe.description.trim().length === 0))
  )
    return null;
  try {
    const options = decodeProviderOptions(recipe.options);
    const readonly = recipe.readonly === undefined ? undefined : decodeReadonlyRestraint(recipe.readonly);
    if ((options.readonly === true) !== (readonly !== undefined)) return null;
    return Object.freeze({
      ...(recipe.description === undefined ? {} : { description: recipe.description }),
      allowed: decodeAllowedActions(recipe.allowed),
      provider: decodeProviderExecution(recipe.provider),
      options,
      ...(readonly === undefined ? {} : { readonly }),
    });
  } catch {
    return null;
  }
}

export function decodeAkumaCallRequest(value: unknown): AkumaCallRequest | null {
  const request = object(value);
  if (request === null) return null;
  const expected = ["archetype", "body", "recipe", "world", ...(request.cwd === undefined ? [] : ["cwd"])];
  if (
    !exactKeys(request, expected) ||
    typeof request.body !== "string" ||
    !absolute(request.world) ||
    (request.cwd !== undefined && !absolute(request.cwd))
  )
    return null;
  let archetype: string;
  try {
    if (typeof request.archetype !== "string") return null;
    archetype = archetypeName(request.archetype);
  } catch {
    return null;
  }
  const recipe = decodeAkumaCallRecipe(request.recipe);
  if (recipe === null) return null;
  return {
    action: "akuma.call",
    world: request.world,
    archetype,
    body: request.body,
    recipe,
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
  };
}

function callPayload(request: AkumaCallRequest): unknown {
  const { action: _action, ...payload } = request;
  return payload;
}

async function executeAkumaCall(
  request: AkumaCallRequest,
  context: CallExecutionContext,
): Promise<Readonly<{ result: AkuId; child: string }>> {
  const world = worldRootForAkumaPaths(context.paths);
  if (request.world !== world) {
    await refuseRequest(context.paths, context.id, `request world ${request.world} does not match ${world}`);
    throw new Error(`request world ${request.world} does not match ${world}`);
  }
  const recipe = { ...request.recipe, allowed: clipAllowedActions(request.recipe.allowed, context.parent.allowed) };
  const published = await publishAkuma({
    worldPath: world,
    archetype: request.archetype,
    signal: context.signal,
    launch: async (allocated) => {
      if (!context.admissionOpen()) throw new Error("body closed request admission");
      await reserveRequest(context.paths, context.id, allocated.id);
      return await context.spawn({
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: allocated.archetype,
          ...recipe,
          cwd: request.cwd ?? context.parent.cwd,
          origin: { kind: "request", parent: context.parent.id, requestId: context.id },
        },
        initialBody: request.body,
      });
    },
  });
  return { result: published.id, child: published.id };
}

export function akumaCallRequestCommand(): RequestCommand<AkumaCallRequest, AkuId, never, AkuId, CallExecutionContext> {
  return {
    action: "akuma.call",
    encodeRequest: callPayload,
    decodeRequest: decodeAkumaCallRequest,
    encodeResult: (result) => result,
    decodeResult: (result) => {
      const child = canonicalAkuId(result);
      if (child === null) throw new Error("Akuma call returned an invalid child");
      return child;
    },
    encodeService: (service) => service,
    decodeService: (_service) => {
      throw new Error("Akuma call has no service evidence");
    },
    projectService: (_service) => {
      throw new Error("Akuma call has no service evidence");
    },
    projectChild: (child) => {
      const id = canonicalAkuId(child);
      if (id === null) throw new Error("Akuma call stored an invalid child reference");
      return id;
    },
    decodeReference: (reference) => {
      const child = canonicalAkuId(reference);
      if (child === null) throw new Error("Akuma call stored an invalid child reference");
      return child;
    },
    isPermitted: (allowed) => allowed.includes("akuma.call"),
    decodeExecutionContext: decodeCallExecutionContext,
    execute: executeAkumaCall,
  };
}

export function akumaCallRequestCommands(): Readonly<Record<"akuma.call", ErasedRequestCommand>> {
  return { "akuma.call": eraseRequestCommand(akumaCallRequestCommand()) };
}

export async function requestForwardedAkumaCall(
  input: Omit<AkumaCallRequest, "action"> & Readonly<{ directory: string; id: string; signal?: AbortSignal }>,
): Promise<AkuId> {
  const { directory, id, signal, ...request } = input;
  const response = await requestBodyCommand({
    directory,
    id,
    command: akumaCallRequestCommand(),
    value: { ...request, action: "akuma.call" },
    ...(signal === undefined ? {} : { signal }),
  });
  return response.kind === "returned" ? response.result : response.reference;
}
