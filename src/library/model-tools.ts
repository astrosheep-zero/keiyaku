import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { verbs, type VerbName, type VerbOutput } from "./keiyaku-verbs.js";
import { snapshotChangeSchema } from "../protocol/result-leaves.js";
import {
  akumaCatalogueSchema,
  akumaCatalogueRowSchema,
  akumaObservationSchema,
  observedAkumaWaitItemSchema,
  dispatchAssociationSchema,
  currentWorkSchema,
  contractCatalogueSchema,
  contractSummarySchema,
  contractNormalStatusSchema,
  akumaNameCatalogSchema,
  debtListSchema,
  contractIdSchema,
  akumaIdSchema,
} from "./keiyaku-verbs.js";

const bind = verbs.bind.normal.unwrap();
const verify = verbs.verify.normal.unwrap();
const contract = contractNormalStatusSchema.unwrap();
const akuma = akumaObservationSchema.unwrap();
const associated = dispatchAssociationSchema.options[1].unwrap().omit({ kind: true });
const association = z.union([
  associated,
  dispatchAssociationSchema.options[2],
  z.strictObject({ kind: z.literal("unavailable") }),
]);
const work = currentWorkSchema.unwrap().omit({ turn: true, activeTools: true, latestActivity: true });
const contractStatus = contract.omit({ kind: true, targetObservation: true }).meta({ id: "ContractStatus" });
const akumaStatus = akuma
  .omit({ kind: true, contract: true, work: true })
  .extend({
    contract: association.exactOptional(),
    work,
  })
  .meta({ id: "AkumaStatus" });
const akumaListRow = akumaCatalogueRowSchema
  .unwrap()
  .extend({ contract: association.exactOptional() })
  .meta({ id: "AkumaRow" });
const contractWaitRow = contractSummarySchema
  .unwrap()
  .omit({ attention: true })
  .extend({
    changed: z.literal(true).exactOptional(),
    terminal: z.enum(["claimed", "abandoned"]).exactOptional(),
  })
  .meta({ id: "ContractWaitRow" });
const akumaWaitRow = observedAkumaWaitItemSchema
  .unwrap()
  .omit({ kind: true, outcome: true })
  .extend({
    verdict: z.enum(["answered", "failed", "canceled"]).exactOptional(),
    turn: z.string().exactOptional(),
    answer: z.string().exactOptional(),
    diagnostic: z.string().exactOptional(),
  })
  .meta({ id: "AkumaWaitRow" });
const unknownWaitRow = z.strictObject({ id: z.union([contractIdSchema, akumaIdSchema]), unknown: z.literal(true) });
const spawn = verbs.spawn.normal.unwrap();
const gateProblem = z.strictObject({
  gate: z.string(),
  requirement: z.string(),
  state: z.enum(["missing", "stale", "unsatisfied"]),
  summary: z.string().exactOptional(),
  reason: snapshotChangeSchema.exactOptional(),
});
const stops = [
  z.strictObject({ kind: z.literal("delivery-missing") }),
  z.strictObject({
    kind: z.literal("prerequisites-unsatisfied"),
    unmet: z.array(z.strictObject({ contractId: z.string(), state: z.enum(["missing", "active", "abandoned"]) })),
  }),
  z.strictObject({ kind: z.literal("gates-unsatisfied"), unmet: z.array(gateProblem) }),
] as const;
const placement = z.union([
  z.strictObject({
    kind: z.literal("placed"),
    integration: z.string(),
    target: z.string().exactOptional(),
    predecessor: z.string().exactOptional(),
  }),
  ...stops,
]);
const continuation = z.strictObject({
  claimed: z.array(z.string()).exactOptional(),
  stopped: z
    .array(
      z.strictObject({
        contractId: z.string(),
        stop: z.union([...stops, z.strictObject({ kind: z.literal("physical-lag") })]),
      }),
    )
    .exactOptional(),
});

/** Transport declarations describe routing facts, independently of complete native answers. */
export const modelOutputSchemas = {
  bind: bind.omit({ issues: true, recoverySnapshots: true, overlapError: true }),
  verify: verify
    .omit({ issues: true, recoverySnapshots: true, checks: true, placement: true, continuation: true })
    .extend({
      checks: z.array(
        z.strictObject({
          index: z.number(),
          requirement: z.string(),
          verdict: z.enum(["satisfied", "unsatisfied"]),
          admission: z.enum(["admitted", "reused", "unrecorded"]),
          summary: z.string().exactOptional(),
          retainedPath: z.string().exactOptional(),
        }),
      ),
      placement: placement.exactOptional(),
      continuation: continuation.exactOptional(),
    }),
  spawn: spawn.omit({ dispatchWarning: true, alias: true, wake: true, input: true }),
  fork: verbs.fork.normal.unwrap().omit({ dispatchWarning: true }),
  ask: z.union([
    verbs.ask.normal.options[0]
      .unwrap()
      .omit({ interrupt: true, wake: true, completedAt: true })
      .extend({ answer: z.unknown() }),
    verbs.ask.normal.options[1].unwrap().omit({ interrupt: true, wake: true }),
    verbs.ask.normal.options[2].unwrap().omit({ interrupt: true, wake: true }),
  ]),
  wait: z.strictObject({
    reason: verbs.wait.normal.unwrap().shape.reason,
    members: z.array(z.union([contractWaitRow, akumaWaitRow, unknownWaitRow])).nonempty(),
  }),
  status: z.union([contractStatus, akumaStatus]),
  ls: z.union([
    contractCatalogueSchema.unwrap().omit({ kind: true }),
    akumaCatalogueSchema
      .unwrap()
      .omit({ kind: true, rows: true })
      .extend({ rows: z.array(akumaListRow).exactOptional() }),
    akumaNameCatalogSchema.unwrap().omit({ kind: true }),
    debtListSchema.unwrap().omit({ kind: true }),
  ]),
  "debt.add": verbs["debt.add"].normal,
} as const;
type ModelOutputName = keyof typeof modelOutputSchemas;

type Normal<K extends ModelOutputName> = z.output<(typeof verbs)[K]["normal"]>;
type Verify = Normal<"verify">;

function projectPlacement(
  value: NonNullable<Verify["placement"]> | NonNullable<NonNullable<Verify["continuation"]>["stopped"]>[number]["stop"],
) {
  if (value.kind !== "gates-unsatisfied") return value;
  return {
    kind: value.kind,
    unmet: value.unmet.map((problem) => {
      const { gate, requirement, state } = problem;
      return {
        gate,
        requirement,
        state,
        ...("summary" in problem ? { summary: problem.summary } : {}),
        ...("reason" in problem && problem.reason !== undefined ? { reason: problem.reason } : {}),
      };
    }),
  };
}

function projectStatus(value: Normal<"status">) {
  if (value.kind === "contract") {
    const { kind: _kind, targetObservation: _target, ...routing } = value;
    return routing;
  }
  const { kind: _kind, contract: association, work: frontier, ...routing } = value;
  const { turn: _turn, activeTools: _tools, latestActivity: _latest, ...work } = frontier;
  return { ...routing, contract: projectAssociation(association), work };
}

function projectAssociation(
  value: z.output<typeof akuma>["contract"] | z.output<typeof akumaCatalogueRowSchema>["contract"],
) {
  if (value?.kind !== "associated") return value;
  const { kind: _kind, ...association } = value;
  return association;
}

function projectWait(value: Normal<"wait">) {
  return {
    reason: value.reason,
    members: value.members.map((member) => {
      if (member.kind === "contract") {
        const { presence, summary, ...row } = member.observation;
        return presence === "unknown" ? { id: row.id, unknown: true } : { ...summary, ...row };
      }
      const observation = member.observation;
      if (observation.kind === "unknown") return { id: observation.id, unknown: true };
      const { kind: _kind, outcome, ...row } = observation;
      if (outcome === undefined) return row;
      const { kind: verdict, historyId: turn, ...answer } = outcome;
      return { ...row, verdict, turn, ...answer };
    }),
  };
}

function projectList(value: Normal<"ls">) {
  if (value.kind === "akuma-catalogue") {
    const { kind: _kind, rows, ...catalogue } = value;
    return {
      ...catalogue,
      rows: rows?.map(({ contract, ...row }) => ({
        ...row,
        contract: projectAssociation(contract),
      })),
    };
  }
  const { kind: _kind, ...catalogue } = value;
  return catalogue;
}

const projections = {
  bind(value: Normal<"bind">) {
    const { kind, contractId, worktreePath, target, overlaps } = value;
    return { kind, contractId, worktreePath, target, overlaps };
  },
  verify(value: Verify) {
    const { issues: _issues, recoverySnapshots: _recoveries, checks, placement, continuation, ...routing } = value;
    return {
      ...routing,
      checks: checks.map(({ kind: _kind, ...check }) => check),
      placement: placement === undefined ? undefined : projectPlacement(placement),
      continuation:
        continuation === undefined
          ? undefined
          : {
              ...continuation,
              stopped: continuation.stopped?.map(({ contractId, stop }) => ({
                contractId,
                stop: projectPlacement(stop),
              })),
            },
    };
  },
  spawn(value: Normal<"spawn">) {
    const { dispatchWarning: _dispatch, alias: _alias, wake: _wake, input: _input, ...routing } = value;
    return routing;
  },
  fork(value: Normal<"fork">) {
    const { dispatchWarning: _dispatch, ...routing } = value;
    return routing;
  },
  ask(value: Normal<"ask">) {
    const { interrupt: _interrupt, wake: _wake, ...routing } = value;
    if (routing.kind !== "answered") return routing;
    const { completedAt: _completedAt, ...settled } = routing;
    return settled;
  },
  wait: projectWait,
  status: projectStatus,
  ls: projectList,
  "debt.add": (value: Normal<"debt.add">) => value,
};

/** Called only after the invocation owner has classified a normal completion. No parsing or I/O. */
export function projectModelOutput(name: ModelOutputName, value: VerbOutput<VerbName>): unknown {
  // The edge preserves the name/value correlation; classification proves the normal subset.
  return (projections[name] as (value: VerbOutput<VerbName>) => unknown)(value);
}

export function hasOutputSchema(name: string): name is keyof typeof modelOutputSchemas {
  return Object.hasOwn(modelOutputSchemas, name);
}

const NO_REPO_TOOLS = new Set<VerbName>(["debt.add", "debt.update", "report"]);
const excluded = new Set<VerbName>(["nuke", "settings", "debt.doctor", "debt.addDocument"]);

const coordinates = {
  cwd: z
    .string()
    .regex(/\S/u)
    .exactOptional()
    .describe(
      "Directory to use for this call; relative paths are relative to your current directory. Selects the World.",
    ),
  repo: z
    .string()
    .regex(/\S/u)
    .exactOptional()
    .describe(
      "Contract repository path (resolved from cwd when relative); selects the Contract repo without changing the World.",
    ),
};

export function modelCoordinates(name: VerbName) {
  return z.strictObject(NO_REPO_TOOLS.has(name) ? { cwd: coordinates.cwd } : coordinates);
}

/** Compose at the declaration boundary so every strict business alternative stays strict. */
export function modelInputSchema(input: z.core.$ZodType, worldOnly = false): z.ZodType {
  if (input instanceof z.ZodReadonly) return modelInputSchema(input.unwrap(), worldOnly).readonly();
  if (input instanceof z.ZodUnion) return z.union(input.options.map((branch) => modelInputSchema(branch, worldOnly)));
  if (!(input instanceof z.ZodObject) || !(input.def.catchall instanceof z.ZodNever))
    throw new Error("MCP business inputs must be strict objects or unions of strict objects");
  for (const key of Object.keys(coordinates)) {
    if (Object.hasOwn(input.shape, key)) throw new Error(`MCP coordinate collides with business field: ${key}`);
  }
  return input.safeExtend(worldOnly ? { cwd: coordinates.cwd } : coordinates);
}

type JsonSchema = z.core.JSONSchema.BaseSchema;

/** Zod visits schema positions; authored const/default JSON is not traversed. */
export function modelJsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, {
    io: "input",
    override: ({ jsonSchema }) => {
      delete jsonSchema.$schema;
      if (typeof jsonSchema.readOnly === "boolean") delete jsonSchema.readOnly;
      if (
        jsonSchema.anyOf?.every((branch) => typeof branch === "object" && branch.type === "string") &&
        jsonSchema.anyOf.some((branch) => typeof branch === "object" && Object.keys(branch).length === 1) &&
        (jsonSchema.type === undefined || jsonSchema.type === "string")
      ) {
        delete jsonSchema.anyOf;
        jsonSchema.type = "string";
      }
    },
  });
  return json;
}

function sharedSchema(alternatives: readonly (JsonSchema | boolean)[]): JsonSchema | boolean {
  const first = alternatives[0]!;
  if (alternatives.every((value) => isDeepStrictEqual(value, first))) return first;
  if (alternatives.some((value) => typeof value === "boolean")) return {};
  const objects = alternatives as readonly JsonSchema[];
  const shared: JsonSchema = {};
  for (const [key, value] of Object.entries(first as JsonSchema)) {
    if (key === "description" || !objects.every((schema) => Object.hasOwn(schema, key))) continue;
    if (key === "items" && objects.every((schema) => typeof schema.items === "object")) {
      shared.items = sharedSchema(objects.map((schema) => schema.items as JsonSchema));
    } else if (key === "properties") {
      shared.properties = Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .filter((name) => objects.every((schema) => Object.hasOwn(schema.properties!, name)))
          .map((name) => [name, sharedSchema(objects.map((schema) => schema.properties![name]!))]),
      );
    } else if (objects.every((schema) => isDeepStrictEqual(schema[key], value))) shared[key] = value;
  }
  if (objects.every((schema) => Object.hasOwn(schema, "const"))) {
    const values = [...new Set(objects.map((schema) => schema.const).filter((value) => value !== undefined))];
    delete shared.const;
    if (values.length === 2 && values.every((value) => typeof value === "boolean")) shared.type = "boolean";
    else shared.enum = values;
  }
  const description = objects.find((schema) => schema.description)?.description;
  if (description !== undefined) shared.description = description;
  return shared;
}

/** Advertise shared structure; native verb validation owns cross-field admission. */
export function normalizeModelSchema(schema: JsonSchema, input = false): JsonSchema {
  if (!input || schema.anyOf === undefined) return schema;
  const { anyOf: branches, ...root } = schema;
  if (
    !branches.every(
      (branch) => typeof branch === "object" && branch.type === "object" && branch.additionalProperties === false,
    )
  )
    throw new Error("MCP input alternatives must be strict objects");
  const objects = branches as JsonSchema[];
  const keys = [...new Set(objects.flatMap((branch) => Object.keys(branch.properties ?? {})))];
  const properties = Object.fromEntries(
    keys.map((key) => [
      key,
      sharedSchema(
        objects.flatMap((branch) => (branch.properties?.[key] === undefined ? [] : [branch.properties[key]!])),
      ),
    ]),
  );
  const required = (objects[0]!.required ?? []).filter((key) =>
    objects.every((branch) => branch.required?.includes(key)),
  );
  return {
    ...root,
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
}

export function describeModelTools() {
  const entries = Object.entries(verbs).filter(([name]) => !excluded.has(name as VerbName));
  return entries.map(([name, entry]) => {
    const schema = normalizeModelSchema(
      modelJsonSchema(modelInputSchema(entry.input, NO_REPO_TOOLS.has(name as VerbName))),
      true,
    );
    const outputSchema = hasOutputSchema(name)
      ? normalizeModelSchema(modelJsonSchema(modelOutputSchemas[name]))
      : undefined;
    return {
      verb: name as VerbName,
      name: name.replaceAll(".", "_"),
      description: entry.description,
      inputSchema: { ...schema, type: "object" },
      ...(outputSchema === undefined ? {} : { outputSchema: { ...outputSchema, type: "object" } }),
      annotations: { readOnlyHint: entry.effect === "read", destructiveHint: entry.effect === "destroy" },
    };
  });
}
