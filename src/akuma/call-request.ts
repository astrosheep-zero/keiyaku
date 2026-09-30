import { isAbsolute, resolve } from "node:path";
import { clipAllowedActions, allowedActionsSchema } from "./allowed.js";
import { refuseRequest, reserveRequest, type Soul } from "./heart/index.js";
import { archetypeName, akumaIdSchema, type AkuId, type AkumaPaths } from "./identity.js";
import { publishAkuma } from "./publication.js";
import type { CallInitialTell, CallInitialTellAdmission } from "./call-initial-tell.js";
import { providerOptionsSchema, providerRecipeSchema } from "./provider-recipe.js";
import { resolveProviderExecution } from "./providers/index.js";
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

const absolutePathSchema = z.string().refine((value) => isAbsolute(value) && resolve(value) === value);
const archetypeSchema = z.string().transform((value, context) => {
  try {
    return archetypeName(value);
  } catch {
    context.addIssue({ code: "custom", message: "expected Akuma name" });
    return z.NEVER;
  }
});

const akumaCallRecipeSchema = z
  .object({
    description: z.string().trim().min(1).optional(),
    allowed: allowedActionsSchema,
    provider: providerRecipeSchema,
    options: providerOptionsSchema,
  })
  .strict();

const initialTellSchema = z
  .object({
    tellId: z.string().trim().min(1),
    body: z.string(),
    schemaJson: z.string().trim().min(1).optional(),
    initiator: z.string().min(1).optional(),
  })
  .strict();
const akumaCallPayloadSchema = z
  .object({
    world: absolutePathSchema,
    archetype: archetypeSchema,
    initialTell: initialTellSchema.optional(),
    cwd: absolutePathSchema.optional(),
    recipe: akumaCallRecipeSchema,
  })
  .strict();

export type AkumaCallRecipe = z.infer<typeof akumaCallRecipeSchema>;
export type AkumaCallRequest = z.infer<typeof akumaCallPayloadSchema> & Readonly<{ action: "akuma.call" }>;

export type AkumaCallRequestChildLaunch = Readonly<{
  paths: AkumaPaths;
  seed: Omit<Soul, "createdAt">;
}>;

export type InitialTellAdmissionRequest = Readonly<{
  id: AkuId;
  initialTell: CallInitialTell;
  signal: AbortSignal;
}>;

type AkumaCallRequestCapabilities = Readonly<{
  world: WorldRoot;
  paths: AkumaPaths;
  parent: Soul;
  spawn(launch: AkumaCallRequestChildLaunch): Promise<OwnedProcess | void>;
  admitInitialTell(input: InitialTellAdmissionRequest): Promise<CallInitialTellAdmission>;
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
  const selected = await resolveProviderExecution(request.recipe.provider);
  const admission = selected.adapter.admitOptions(request.recipe.options);
  if (admission.kind === "refused") {
    await refuseRequest(paths, facts.id, admission.diagnostic);
    throw new Error(admission.diagnostic);
  }
  const recipe = {
    ...(request.recipe.description === undefined ? {} : { description: request.recipe.description }),
    allowed: clipAllowedActions(request.recipe.allowed, parent.allowed),
    provider: selected.execution,
    options: admission.options,
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
      });
    },
  });
  if (request.initialTell === undefined) return { result: published.id, child: published.id };
  const admitted = await capabilities.admitInitialTell({
    id: published.id,
    initialTell: {
      tellId: request.initialTell.tellId,
      body: request.initialTell.body,
      ...(request.initialTell.schemaJson === undefined ? {} : { schemaJson: request.initialTell.schemaJson }),
      ...(request.initialTell.initiator === undefined ? {} : { initiator: request.initialTell.initiator }),
    },
    signal: facts.signal,
  });
  if (admitted.kind === "birth-failed") throw new Error(admitted.diagnostic);
  if (admitted.kind === "not-born") throw new Error(`Akuma ${published.id} was not born for its initial Tell`);
  await admitted.wake;
  return { result: published.id, child: published.id };
}

export function akumaCallRequestProtocol(): RequestProtocol<AkumaCallRequest, AkuId, AkuId> {
  return {
    action: "akuma.call",
    supportsCancellation: true,
    encodeRequest: callPayload,
    decodeRequest: decodeAkumaCallRequest,
    encodeResult: (result) => result,
    decodeResult: (result) => {
      const child = akumaIdSchema.safeParse(result);
      if (!child.success) throw new Error("Akuma call returned an invalid child");
      return child.data;
    },
    decodeReference: (reference) => {
      const child = akumaIdSchema.safeParse(reference);
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
      const id = akumaIdSchema.safeParse(child);
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
