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

function describeTools(): Tool[] {
  return Object.entries(Keiyaku.verbs).map(([name, entry]) => {
    const schema = z.toJSONSchema(
      z.object({ cwd: z.string().min(1).optional(), repo: z.string().min(1).optional(), input: entry.input }).strict(),
      { io: "input" },
    );
    const output = z.toJSONSchema(entry.output, { io: "input" });
    return {
      name,
      description: entry.description,
      inputSchema: schema as Tool["inputSchema"],
      ...(output.type === "object" ? { outputSchema: output as Tool["inputSchema"] } : {}),
      annotations: { readOnlyHint: entry.effect === "read", destructiveHint: entry.effect !== "read" },
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
    const name = request.params.name;
    if (!Object.hasOwn(Keiyaku.verbs, name)) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    const operation = call(name as VerbName, request.params.arguments, extra.signal);
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
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
      const projected: unknown =
        completion.kind === "threw" ? projectFailure(completion.error) : JSON.parse(JSON.stringify(completion.value));
      return {
        content: [
          { type: "text", text },
          ...(completion.kind === "threw" ? [{ type: "text" as const, text: JSON.stringify(projected) }] : []),
        ],
        isError: disposition !== "accepted",
        _meta: { "keiyaku/disposition": disposition },
        ...(completion.kind === "returned" &&
        typeof projected === "object" &&
        projected !== null &&
        !Array.isArray(projected)
          ? { structuredContent: projected as Record<string, unknown> }
          : {}),
      };
    } catch (error) {
      console.error("keiyaku-mcp: failed to project result", error);
      throw error;
    }
  }
  return {
    server,
    close() {
      return (closing ??= (async () => {
        await server.close();
        await Promise.allSettled([...pending]);
      })());
    },
  };
}
