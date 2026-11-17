import { isDeepStrictEqual } from "node:util";
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
  ls: verbs.ls.normal,
  "debt.add": verbs["debt.add"].normal,
} as const;

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
