import { z } from "zod";
import { verbs, type VerbName } from "./keiyaku-verbs.js";

/** Routing tools publish their producing owner's normal wire answer. */
export const modelOutputSchemas = {
  bind: verbs.bind.normal,
  verify: verbs.verify.normal,
  spawn: verbs.spawn.normal,
  fork: verbs.fork.normal,
  ask: verbs.ask.normal,
  wait: verbs.wait.normal,
  status: verbs.status.normal,
  surveil: verbs.surveil.normal,
  ls: verbs.ls.normal,
  "debt.add": verbs["debt.add"].normal,
} as const;

export function hasOutputSchema(name: string): name is keyof typeof modelOutputSchemas {
  return Object.hasOwn(modelOutputSchemas, name);
}

const NO_REPO_TOOLS = new Set<VerbName>(["debt.add", "debt.update", "report", "surveil"]);
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

/** Extend the authored strict business object without dropping pure refinements. */
export function modelInputSchema(input: z.core.$ZodType, worldOnly = false): z.ZodType {
  const business = input instanceof z.ZodReadonly ? input.unwrap() : input;
  if (!(business instanceof z.ZodObject) || !(business.def.catchall instanceof z.ZodNever))
    throw new Error("MCP business inputs must be strict objects");
  for (const key of Object.keys(coordinates)) {
    if (Object.hasOwn(business.shape, key)) throw new Error(`MCP coordinate collides with business field: ${key}`);
  }
  return business.safeExtend(worldOnly ? { cwd: coordinates.cwd } : coordinates);
}

type JsonSchema = z.core.JSONSchema.BaseSchema;

/** Zod visits schema positions; authored const/default JSON is not traversed. */
export function modelJsonSchema(schema: z.ZodType, position: "input" | "output" = "input"): JsonSchema {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, {
    io: "input",
    override: ({ jsonSchema }) => {
      delete jsonSchema.$schema;
      if (typeof jsonSchema.readOnly === "boolean") delete jsonSchema.readOnly;
      if (position === "output" && jsonSchema.type === "integer" && jsonSchema.maximum === Number.MAX_SAFE_INTEGER) {
        delete jsonSchema.maximum;
        if (jsonSchema.minimum === 0) delete jsonSchema.minimum;
      }
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

export function describeModelTools() {
  const entries = Object.entries(verbs).filter(([name]) => !excluded.has(name as VerbName));
  return entries.map(([name, entry]) => {
    const schema = modelJsonSchema(modelInputSchema(entry.input, NO_REPO_TOOLS.has(name as VerbName)));
    const outputSchema = hasOutputSchema(name) ? modelJsonSchema(modelOutputSchemas[name], "output") : undefined;
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
