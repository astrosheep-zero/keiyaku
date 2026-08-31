import { isAbsolute, resolve } from "node:path";
import { clipAllowedActions, decodeAllowedActions } from "./allowed.js";
import { refuseRequest, reserveRequest, type Soul } from "./heart/index.js";
import { archetypeName, parseAkuId, type AkuId, type AkumaPaths } from "./identity.js";
import { publishAkuma } from "./publication.js";
import { decodeProviderOptions, decodeReadonlyRestraint } from "./provider-recipe.js";
import { decodeProviderExecution } from "./providers/index.js";
import { requestBodyCommand } from "./request-rendezvous.js";
import {
  eraseRequestCommand,
  type ChildRequestCommand,
  type ErasedRequestCommand,
  type ExecutionFacts,
  type RequestProtocol,
} from "./request-wire.js";
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
    context.addIssue({ code: "custom", message: "expected Akuma name" });
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

type AkumaCallRequestCapabilities = Readonly<{
  world: WorldRoot;
  paths: AkumaPaths;
  parent: Soul;
  spawn(launch: AkumaCallRequestChildLaunch): Promise<OwnedProcess | void>;
}>;

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
  facts: ExecutionFacts,
  capabilities: AkumaCallRequestCapabilities,
): Promise<Readonly<{ result: AkuId; child: string }>> {
  const { world, paths, parent, spawn } = capabilities;
  const requestWorld = await World.prove(request.world);
  if (requestWorld !== world) {
    await refuseRequest(paths, facts.id, `request world ${requestWorld} does not match ${world}`);
    throw new Error(`request world ${requestWorld} does not match ${world}`);
  }
  const recipe = {
    ...(request.recipe.description === undefined ? {} : { description: request.recipe.description }),
    allowed: clipAllowedActions(request.recipe.allowed, parent.allowed),
    provider: request.recipe.provider,
    options: request.recipe.options,
    ...(request.recipe.readonly === undefined ? {} : { readonly: request.recipe.readonly }),
  };
  const published = await publishAkuma({
    worldPath: world,
    archetype: request.archetype,
    signal: facts.signal,
    launch: async (allocated) => {
      if (!facts.admissionOpen()) throw new Error("body closed request admission");
      await reserveRequest(paths, facts.id, allocated.id);
      return await spawn({
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: allocated.archetype,
          ...recipe,
          cwd: request.cwd ?? parent.cwd,
          origin: { kind: "request", parent: parent.id, requestId: facts.id },
        },
        initialBody: request.body,
      });
    },
  });
  return { result: published.id, child: published.id };
}

export function akumaCallRequestProtocol(): RequestProtocol<AkumaCallRequest, AkuId, AkuId> {
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
    decodeReference: (reference) => {
      const child = akuIdSchema.safeParse(reference);
      if (!child.success) throw new Error("Akuma call stored an invalid child reference");
      return child.data;
    },
    isPermitted: (allowed) => allowed.includes("akuma.call"),
  };
}

export function akumaCallRequestCommand(
  capabilities: AkumaCallRequestCapabilities,
): ChildRequestCommand<AkumaCallRequest, AkuId, AkuId> {
  return {
    completion: "child",
    protocol: akumaCallRequestProtocol(),
    projectChild: (child) => {
      const id = akuIdSchema.safeParse(child);
      if (!id.success) throw new Error("Akuma call stored an invalid child reference");
      return id.data;
    },
    execute: async (request, facts) => await executeAkumaCall(request, facts, capabilities),
  };
}

export function akumaCallRequestCommands(
  capabilities: AkumaCallRequestCapabilities,
): Readonly<Record<"akuma.call", ErasedRequestCommand>> {
  return { "akuma.call": eraseRequestCommand(akumaCallRequestCommand(capabilities)) };
}

export async function requestForwardedAkumaCall(
  input: Omit<AkumaCallRequest, "action"> & Readonly<{ directory: string; id: string; signal?: AbortSignal }>,
): Promise<AkuId> {
  const { directory, id, signal, ...request } = input;
  const response = await requestBodyCommand({
    directory,
    id,
    command: akumaCallRequestProtocol(),
    value: { ...request, action: "akuma.call" },
    ...(signal === undefined ? {} : { signal }),
  });
  return response.kind === "returned" ? response.result : response.reference;
}
