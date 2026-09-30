import { isAbsolute, resolve } from "node:path";
import { allowedActionsSchema } from "./allowed.js";
import { refuseRequest, reserveRequest, type Soul } from "./heart/index.js";
import { archetypeName, akumaIdSchema, type AkuId, type AkumaPaths } from "./identity.js";
import { callDiagnostic, executePreparedCall } from "./publication.js";
import { tellResultSchema, type CallInitialTell, type CallInitialTellAdmission } from "./call-initial-tell.js";
import { providerOptionsSchema, providerRecipeSchema } from "./provider-recipe.js";
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
import type { WorldRoot } from "../world.js";

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

const liveResultSchema = z
  .object({
    kind: z.literal("live"),
    id: akumaIdSchema,
    tell: tellResultSchema.optional(),
    tellFailure: z.string().optional(),
  })
  .strict();
const referenceSchema = z.object({ kind: z.literal("reference"), id: akumaIdSchema }).strict();

export type AkumaCallLive = z.infer<typeof liveResultSchema>;
export type AkumaCallReference = z.infer<typeof referenceSchema>;
export type AkumaCallOutput = AkumaCallLive | AkumaCallReference;

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
): Promise<Readonly<{ result: AkumaCallLive; child: string }>> {
  const { world, paths, parent, spawn, admitInitialTell } = capabilities;
  const outcome = await executePreparedCall({
    archetype: request.archetype,
    cwd: request.cwd ?? parent.cwd,
    ...(request.initialTell === undefined
      ? {}
      : {
          initialTell: {
            tellId: request.initialTell.tellId,
            body: request.initialTell.body,
            ...(request.initialTell.schemaJson === undefined ? {} : { schemaJson: request.initialTell.schemaJson }),
            ...(request.initialTell.initiator === undefined ? {} : { initiator: request.initialTell.initiator }),
          },
        }),
    signal: facts.signal,
    custody: {
      kind: "request",
      world,
      coordinate: request.world,
      recipe: {
        ...(request.recipe.description === undefined ? {} : { description: request.recipe.description }),
        provider: request.recipe.provider,
        options: request.recipe.options,
        allowed: request.recipe.allowed,
      },
      parent,
      requestId: facts.id,
      admissionOpen: facts.admissionOpen,
      reserve: async (child) => {
        await reserveRequest(paths, facts.id, child);
      },
      refuse: async (diagnostic) => {
        await refuseRequest(paths, facts.id, diagnostic);
      },
      spawn,
      admitInitialTell,
    },
  });
  return {
    result: {
      kind: "live",
      id: outcome.child.id,
      ...(outcome.tell === undefined ? {} : { tell: outcome.tell }),
      ...(outcome.failure === undefined ? {} : { tellFailure: callDiagnostic(outcome.failure) }),
    },
    child: outcome.child.id,
  };
}

export function akumaCallRequestProtocol(): RequestProtocol<AkumaCallRequest, AkumaCallLive, AkumaCallReference> {
  return {
    action: "akuma.call",
    supportsCancellation: true,
    encodeRequest: callPayload,
    decodeRequest: decodeAkumaCallRequest,
    encodeResult: (result) => result,
    decodeResult: (result) => {
      const parsed = liveResultSchema.safeParse(result);
      if (!parsed.success) throw new Error("Akuma call returned an invalid live child result");
      return parsed.data;
    },
    decodeReference: (reference) => {
      const parsed = referenceSchema.safeParse(reference);
      if (!parsed.success) throw new Error("Akuma call stored an invalid child reference");
      return parsed.data;
    },
    isPermitted: (allowed) => allowed.includes("akuma.call"),
  };
}

export function akumaCallRequestCommand(
  capabilities: AkumaCallRequestCapabilities,
): ChildRequestCommand<AkumaCallRequest, AkumaCallLive, AkumaCallReference> {
  return {
    completion: "child",
    protocol: akumaCallRequestProtocol(),
    projectChild: (child) => {
      const id = akumaIdSchema.safeParse(child);
      if (!id.success) throw new Error("Akuma call stored an invalid child reference");
      return { kind: "reference", id: id.data };
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
): Promise<AkumaCallOutput> {
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
