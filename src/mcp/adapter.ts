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
import { DEFAULT_CLI_COLUMNS } from "../cli/render/terminal.js";

type McpAdapterInput = Readonly<{
  cwd: string;
  environment: Readonly<Record<string, string | undefined>>;
  version: string;
}>;

const SCHEMA_TOOLS = new Set<VerbName>([
  "bind",
  "wait",
  "status",
  "ls",
  "show",
  "verify",
  "spawn",
  "fork",
  "debt.add",
  "ask",
]);
const excluded = new Set<VerbName>(["nuke", "settings", "debt.doctor", "debt.addDocument"]);

function describeTools(): Tool[] {
  const entries = Object.entries(Keiyaku.verbs).filter(([name]) => !excluded.has(name as VerbName));
  return entries.map(([name, entry]) => {
    const schema = z.toJSONSchema(
      z.object({ cwd: z.string().min(1).optional(), repo: z.string().min(1).optional(), input: entry.input }).strict(),
      { io: "input" },
    );
    let outputSchema: Tool["outputSchema"];
    if (SCHEMA_TOOLS.has(name as VerbName)) {
      const output = z.toJSONSchema(entry.output, { io: "input", reused: "ref" });
      const branches: z.core.JSONSchema.BaseSchema[] = [output];
      for (const branch of branches) {
        if (branch.anyOf !== undefined) branches.push(...branch.anyOf);
        else if (branch.type !== "object") throw new Error(`Non-object output schema: ${name}`);
      }
      outputSchema = { ...output, type: "object" } as Tool["inputSchema"];
    }
    return {
      name: name.replaceAll(".", "_"),
      description: entry.description,
      inputSchema: schema as Tool["inputSchema"],
      ...(outputSchema === undefined ? {} : { outputSchema }),
      annotations: { readOnlyHint: entry.effect === "read", destructiveHint: entry.effect === "destroy" },
    };
  });
}

function validateArguments(args: Record<string, unknown> | undefined): asserts args is {
  cwd?: string;
  repo?: string;
  input: unknown;
} {
  if (
    args === undefined ||
    !Object.hasOwn(args, "input") ||
    Object.keys(args).some((key) => !["cwd", "repo", "input"].includes(key)) ||
    (args.cwd !== undefined && (typeof args.cwd !== "string" || !args.cwd.trim())) ||
    (args.repo !== undefined && (typeof args.repo !== "string" || !args.repo.trim()))
  ) {
    throw new KeiyakuUsageError("expected input and optional nonblank cwd and repo");
  }
}

export function createKeiyakuMcpServer(input: McpAdapterInput): Readonly<{ server: Server; close(): Promise<void> }> {
  const cwd = input.cwd;
  const environment = { ...input.environment };
  const home = environment.KEIYAKU_HOME?.trim() || undefined;
  const server = new Server({ name: "keiyaku", version: input.version }, { capabilities: { tools: {} } });
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
    const value = args?.input as VerbInput<VerbName>;
    let completion: VerbCompletion<VerbOutput<VerbName>>;
    try {
      validateArguments(args);
      const facet = Keiyaku.at({
        cwd: resolve(cwd, args.cwd ?? "."),
        environment,
        ...(args.repo === undefined ? {} : { repo: args.repo }),
        ...(home === undefined ? {} : { home }),
      });
      completion = { kind: "returned", value: await facet.run(name, value, { signal }) };
    } catch (error) {
      completion = { kind: "threw", error };
    }
    try {
      const disposition = classifyVerb(name, value, completion);
      const text = renderVerb(name, value, completion, {
        columns: DEFAULT_CLI_COLUMNS,
        color: false,
        now: Date.now(),
        ...(name === "report" && environment.KEIYAKU_ACTOR_ID !== undefined
          ? { actor: environment.KEIYAKU_ACTOR_ID }
          : {}),
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
        ...(!isError && SCHEMA_TOOLS.has(name) && completion.kind === "returned"
          ? { structuredContent: JSON.parse(JSON.stringify(completion.value)) }
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
