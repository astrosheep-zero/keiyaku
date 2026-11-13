import { resolve } from "node:path";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Keiyaku, KeiyakuUsageError } from "../library/keiyaku.js";
import {
  classifyVerb,
  type VerbCompletion,
  type VerbInput,
  type VerbName,
  type VerbOutput,
} from "../library/keiyaku-verbs.js";
import { projectFailure } from "../library/outcome.js";
import { renderVerb } from "../cli/render/verbs.js";
import { mcpOutputSchemas, projectMcpOutput } from "./output.js";
import { DEFAULT_CLI_COLUMNS } from "../cli/render/terminal.js";

type McpAdapterInput = Readonly<{
  cwd: string;
  environment: Readonly<Record<string, string | undefined>>;
  version: string;
}>;

function hasOutputSchema(name: string): name is keyof typeof mcpOutputSchemas {
  return Object.hasOwn(mcpOutputSchemas, name);
}
const SERVER_DESCRIPTION =
  "Agent work ledger for a Git repository: Contracts bind the work, Akumas do it, kanshi watches.";
const NO_REPO_TOOLS = new Set<VerbName>(["debt.add", "debt.update", "report"]);
const excluded = new Set<VerbName>(["nuke", "settings", "debt.doctor", "debt.addDocument"]);

const coordinates = {
  cwd: z
    .string()
    .regex(/\S/u)
    .exactOptional()
    .describe(
      "Invocation directory (relative paths resolve from the MCP server startup directory); selects the World.",
    ),
  repo: z
    .string()
    .regex(/\S/u)
    .exactOptional()
    .describe(
      "Contract repository path (resolved from cwd when relative); selects the Contract repo without changing the World.",
    ),
};

/** Compose at the declaration boundary so every strict business alternative stays strict. */
export function mcpInputSchema(input: z.core.$ZodType, worldOnly = false): z.ZodType {
  if (input instanceof z.ZodReadonly) return mcpInputSchema(input.unwrap(), worldOnly).readonly();
  if (input instanceof z.ZodUnion) return z.union(input.options.map((branch) => mcpInputSchema(branch, worldOnly)));
  if (!(input instanceof z.ZodObject) || !(input.def.catchall instanceof z.ZodNever))
    throw new Error("MCP business inputs must be strict objects or unions of strict objects");
  for (const key of Object.keys(coordinates)) {
    if (Object.hasOwn(input.shape, key)) throw new Error(`MCP coordinate collides with business field: ${key}`);
  }
  return input.safeExtend(worldOnly ? { cwd: coordinates.cwd } : coordinates);
}

type JsonSchema = z.core.JSONSchema.BaseSchema;

/** Remove annotations only at schema positions; property names and authored JSON stay intact. */
function cleanSchema(schema: JsonSchema): JsonSchema {
  const cleaned: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema" || (key === "readOnly" && typeof value === "boolean")) continue;
    if (["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key)) {
      cleaned[key] = Object.fromEntries(
        Object.entries(value as Record<string, JsonSchema | boolean>).map(([name, child]) => [
          name,
          typeof child === "boolean" ? child : cleanSchema(child),
        ]),
      );
    } else if (["anyOf", "oneOf", "allOf", "prefixItems"].includes(key)) {
      cleaned[key] = (value as (JsonSchema | boolean)[]).map((child) =>
        typeof child === "boolean" ? child : cleanSchema(child),
      );
    } else if (
      [
        "items",
        "additionalProperties",
        "unevaluatedProperties",
        "not",
        "if",
        "then",
        "else",
        "contains",
        "propertyNames",
      ].includes(key) &&
      typeof value === "object" &&
      value !== null
    ) {
      cleaned[key] = cleanSchema(value as JsonSchema);
    } else cleaned[key] = value;
  }
  if (
    cleaned.anyOf?.every((branch) => typeof branch === "object" && branch.type === "string") &&
    cleaned.anyOf.some((branch) => typeof branch === "object" && Object.keys(branch).length === 1) &&
    (cleaned.type === undefined || cleaned.type === "string")
  ) {
    delete cleaned.anyOf;
    cleaned.type = "string";
  }
  return cleaned;
}

function constraints(schema: JsonSchema | boolean): JsonSchema | boolean {
  if (typeof schema === "boolean") return schema;
  const { description: _description, ...value } = schema;
  return value;
}

/** Hoist only object input alternatives, retaining each branch's complete restrictions. */
export function normalizeMcpSchema(schema: JsonSchema, input = false): JsonSchema {
  const cleaned = cleanSchema(schema);
  if (!input || cleaned.anyOf === undefined) return cleaned;
  const branches = cleaned.anyOf;
  if (
    !branches.every(
      (branch) => typeof branch === "object" && branch.type === "object" && branch.additionalProperties === false,
    )
  )
    throw new Error("MCP input alternatives must be strict objects");
  const objects = branches as JsonSchema[];
  const keys = [...new Set(objects.flatMap((branch) => Object.keys(branch.properties ?? {})))];
  const properties: Record<string, JsonSchema | boolean> = {};
  for (const key of keys) {
    const alternatives = objects.flatMap((branch) =>
      branch.properties?.[key] === undefined ? [] : [branch.properties[key]!],
    );
    const first = alternatives[0]!;
    const unique = [
      ...new Map(alternatives.map((value) => [JSON.stringify(constraints(value)), constraints(value)])).values(),
    ];
    const merged = unique.includes(true)
      ? true
      : unique.length === 1
        ? unique[0]!
        : { anyOf: unique.filter((value): value is JsonSchema => typeof value !== "boolean") };
    properties[key] =
      typeof merged === "boolean"
        ? merged
        : {
            ...merged,
            ...(typeof first === "boolean" || first.description === undefined
              ? {}
              : { description: first.description }),
          };
  }
  const required = (objects[0]!.required ?? []).filter((key) =>
    objects.every((branch) => branch.required?.includes(key)),
  );
  return {
    ...cleaned,
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
    anyOf: objects.map((branch) => {
      const {
        type: _type,
        properties: _properties,
        required: branchRequired,
        additionalProperties: _extra,
        ...rest
      } = branch;
      const narrowed: Record<string, JsonSchema | boolean> = {};
      for (const key of keys) {
        const value = branch.properties?.[key];
        if (value === undefined) narrowed[key] = false;
        else if (JSON.stringify(constraints(value)) !== JSON.stringify(constraints(properties[key]!)))
          narrowed[key] = constraints(value);
      }
      const needs = (branchRequired ?? []).filter((key) => !required.includes(key));
      return {
        ...rest,
        ...(needs.length === 0 ? {} : { required: needs }),
        ...(Object.keys(narrowed).length === 0 ? {} : { properties: narrowed }),
      };
    }),
  };
}

function describeTools(): Tool[] {
  const entries = Object.entries(Keiyaku.verbs).filter(([name]) => !excluded.has(name as VerbName));
  return entries.map(([name, entry]) => {
    const schema = normalizeMcpSchema(
      z.toJSONSchema(mcpInputSchema(entry.input, NO_REPO_TOOLS.has(name as VerbName)), { io: "input" }),
      true,
    );
    const outputSchema = hasOutputSchema(name)
      ? normalizeMcpSchema(z.toJSONSchema(mcpOutputSchemas[name], { io: "input" }))
      : undefined;
    return {
      name: name.replaceAll(".", "_"),
      description: entry.description,
      inputSchema: { ...schema, type: "object" } as Tool["inputSchema"],
      ...(outputSchema === undefined
        ? {}
        : { outputSchema: { ...outputSchema, type: "object" } as Tool["outputSchema"] }),
      annotations: { readOnlyHint: entry.effect === "read", destructiveHint: entry.effect === "destroy" },
    };
  });
}

function createMcpServer(version: string): Server {
  return new Server({ name: "keiyaku", version, description: SERVER_DESCRIPTION }, { capabilities: { tools: {} } });
}

export function createKeiyakuMcpServer(input: McpAdapterInput): Readonly<{ server: Server; close(): Promise<void> }> {
  const cwd = input.cwd;
  const environment = { ...input.environment };
  const home = environment.KEIYAKU_HOME?.trim() || undefined;
  const actorContext = environment.KEIYAKU_ACTOR_ID === undefined ? {} : { actor: environment.KEIYAKU_ACTOR_ID };
  const server = createMcpServer(input.version);
  const tools = describeTools();
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const name = request.params.name.replaceAll("_", ".");
    if (request.params.name.includes(".") || !Object.hasOwn(Keiyaku.verbs, name) || excluded.has(name as VerbName))
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    const operation = call(name as VerbName, request.params.arguments, extra.signal);
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  });

  async function call(
    name: VerbName,
    args: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const { cwd: callCwd, repo, ...business } = args ?? {};
    const value = business as VerbInput<VerbName>;
    let completion: VerbCompletion<VerbOutput<VerbName>>;
    try {
      const parsed = z.strictObject(NO_REPO_TOOLS.has(name) ? { cwd: coordinates.cwd } : coordinates).safeParse({
        ...(callCwd === undefined ? {} : { cwd: callCwd }),
        ...(repo === undefined ? {} : { repo }),
      });
      if (!parsed.success) throw new KeiyakuUsageError(parsed.error.message);
      const facet = Keiyaku.at({
        cwd: resolve(cwd, parsed.data.cwd ?? "."),
        environment,
        ...(!("repo" in parsed.data) || parsed.data.repo === undefined ? {} : { repo: parsed.data.repo }),
        ...(home === undefined ? {} : { home }),
      });
      completion = { kind: "returned", value: await facet.run(name, value, { signal }) };
    } catch (error) {
      completion = { kind: "threw", error };
    }
    try {
      const disposition = classifyVerb(name, value, completion);
      const text = renderVerb(name, value, completion, {
        surface: "mcp",
        columns: DEFAULT_CLI_COLUMNS,
        color: false,
        now: Date.now(),
        ...(name === "report" || name === "ls" ? actorContext : {}),
      });
      const isError = disposition !== "accepted" && disposition !== "unsatisfied";
      return {
        content: [
          { type: "text", text: isError ? `${disposition}\n${text}` : text },
          ...(completion.kind === "threw"
            ? [{ type: "text" as const, text: JSON.stringify(projectFailure(completion.error)) }]
            : []),
        ],
        isError,
        _meta: { "keiyaku/disposition": disposition },
        ...(!isError && hasOutputSchema(name) && completion.kind === "returned"
          ? { structuredContent: JSON.parse(JSON.stringify(projectMcpOutput(name, completion.value))) }
          : {}),
      };
    } catch (error) {
      console.error("keiyaku-mcp: failed to project result", error);
      throw error;
    }
  }
  return {
    server,
    close: () =>
      (closing ??= (async () => {
        await server.close();
        await Promise.allSettled([...pending]);
      })()),
  };
}
