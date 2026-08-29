import { isAbsolute, resolve } from "node:path";
import { clipAllowedActions, decodeAllowedActions } from "./allowed.js";
import { refuseRequest, reserveRequest, type Soul } from "./heart/index.js";
import { archetypeName, parseAkuId, type AkuId, type AkumaPaths } from "./identity.js";
import { publishAkuma } from "./publication.js";
import { decodeProviderOptions, decodeReadonlyRestraint } from "./provider-recipe.js";
import { decodeProviderExecution } from "./providers/index.js";
import { requestBodyCommand } from "./request-rendezvous.js";
import { eraseRequestCommand, type ErasedRequestCommand, type RequestCommand } from "./request-wire.js";
import type { OwnedProcess } from "../runtime/proc/run.js";
import { z } from "zod";
import { World, type WorldRoot } from "../world.js";

function schemaDecode<Value>(
  decode: (value: unknown) => Value,
  message: string,
): z.ZodPipe<z.ZodUnknown, z.ZodTransform<Value, unknown>> {
  return z.unknown().transform((value, context) => {
    try {
      return decode(value);
    } catch {
      context.addIssue({ code: "custom", message });
      return z.NEVER;
    }
  });
}

const absolutePathSchema = z.string().refine((value) => isAbsolute(value) && resolve(value) === value);
const akuIdSchema = z.string().transform((value, context) => {
  try {
    const id = parseAkuId(value).id;
    if (id !== value) {
      context.addIssue({ code: "custom", message: "expected canonical AkuId" });
      return z.NEVER;
    }
    return id;
  } catch {
    context.addIssue({ code: "custom", message: "expected canonical AkuId" });
    return z.NEVER;
  }
});
const archetypeSchema = z.string().transform((value, context) => {
  try {
    return archetypeName(value);
  } catch {
    context.addIssue({ code: "custom", message: "expected archetype" });
    return z.NEVER;
  }
});
const allowedActionsSchema = schemaDecode(decodeAllowedActions, "expected allowed actions");
const providerExecutionSchema = schemaDecode(decodeProviderExecution, "expected provider execution");
const providerOptionsSchema = schemaDecode(decodeProviderOptions, "expected provider options");
const readonlyRestraintSchema = schemaDecode(decodeReadonlyRestraint, "expected readonly restraint");

const akumaCallRecipeSchema = z
  .object({
    description: z.string().trim().min(1).optional(),
    allowed: allowedActionsSchema,
    provider: providerExecutionSchema,
    options: providerOptionsSchema,
    readonly: readonlyRestraintSchema.optional(),
  })
  .strict()
  .superRefine((recipe, context) => {
    if ((recipe.options.readonly === true) !== (recipe.readonly !== undefined)) {
      context.addIssue({ code: "custom", message: "readonly recipe fields disagree" });
    }
  });

const akumaCallPayloadSchema = z
  .object({
    world: absolutePathSchema,
    archetype: archetypeSchema,
    body: z.string(),
    cwd: absolutePathSchema.optional(),
    recipe: akumaCallRecipeSchema,
  })
  .strict();

export type AkumaCallRecipe = z.infer<typeof akumaCallRecipeSchema>;
export type AkumaCallRequest = z.infer<typeof akumaCallPayloadSchema> & Readonly<{ action: "akuma.call" }>;

export type AkumaCallRequestChildLaunch = Readonly<{
  paths: AkumaPaths;
  seed: Omit<Soul, "createdAt">;
  initialBody: string;
}>;

type CallExecutionContext = Readonly<{
  id: string;
  requester: string;
  signal: AbortSignal;
  world: WorldRoot;
  paths: AkumaPaths;
  parent: Soul;
  spawn(launch: AkumaCallRequestChildLaunch): Promise<OwnedProcess | void>;
  admissionOpen(): boolean;
}>;

function carriesLaunchWorld(value: unknown): value is Readonly<{ launchWorld(): WorldRoot }> {
  const upstream = object(value);
  return upstream !== null && typeof upstream.launchWorld === "function";
}

function decodeCallExecutionContext(value: unknown): CallExecutionContext {
  const context = object(value);
  const paths = object(context?.paths);
  const parent = object(context?.parent);
  const parentId = akuIdSchema.safeParse(parent?.id);
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
    !parentId.success ||
    typeof parent.cwd !== "string" ||
    !Array.isArray(parent.allowed) ||
    typeof context.spawn !== "function" ||
    typeof context.admissionOpen !== "function"
  )
    throw new Error("invalid Akuma call execution context");
  if (!carriesLaunchWorld(context.upstream)) throw new Error("Akuma call requires a minted launch World");
  return {
    id: context.id,
    requester: context.requester,
    signal: context.signal as AbortSignal,
    world: context.upstream.launchWorld(),
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

export function decodeAkumaCallRequest(value: unknown): AkumaCallRequest | null {
  const parsed = akumaCallPayloadSchema.safeParse(value);
  return parsed.success ? { ...parsed.data, action: "akuma.call" } : null;
}

function callPayload(request: AkumaCallRequest): unknown {
  const { action: _action, ...payload } = request;
  return payload;
}

async function executeAkumaCall(
  request: AkumaCallRequest,
  context: CallExecutionContext,
): Promise<Readonly<{ result: AkuId; child: string }>> {
  const world = context.world;
  const requestWorld = await World.prove(request.world);
  if (requestWorld !== world) {
    await refuseRequest(context.paths, context.id, `request world ${requestWorld} does not match ${world}`);
    throw new Error(`request world ${requestWorld} does not match ${world}`);
  }
  const recipe = {
    ...(request.recipe.description === undefined ? {} : { description: request.recipe.description }),
    allowed: clipAllowedActions(request.recipe.allowed, context.parent.allowed),
    provider: request.recipe.provider,
    options: request.recipe.options,
    ...(request.recipe.readonly === undefined ? {} : { readonly: request.recipe.readonly }),
  };
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
      const child = akuIdSchema.safeParse(result);
      if (!child.success) throw new Error("Akuma call returned an invalid child");
      return child.data;
    },
    encodeService: (service) => service,
    decodeService: (_service) => {
      throw new Error("Akuma call has no service evidence");
    },
    projectService: (_service) => {
      throw new Error("Akuma call has no service evidence");
    },
    projectChild: (child) => {
      const id = akuIdSchema.safeParse(child);
      if (!id.success) throw new Error("Akuma call stored an invalid child reference");
      return id.data;
    },
    decodeReference: (reference) => {
      const child = akuIdSchema.safeParse(reference);
      if (!child.success) throw new Error("Akuma call stored an invalid child reference");
      return child.data;
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
