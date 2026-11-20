import { resolve } from "node:path";
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
import { renderVerb, type RenderVerbContext } from "../cli/render/verbs.js";
import { describeModelTools, modelCoordinates, modelToolOutput } from "../library/model-tools.js";
import { SERVER_DESCRIPTION } from "./description.js";
import { DEFAULT_CLI_COLUMNS } from "../cli/render/terminal.js";

type McpAdapterInput = Readonly<{
  cwd: string;
  environment: Readonly<Record<string, string | undefined>>;
  version: string;
}>;

function createMcpServer(version: string): Server {
  return new Server(
    { name: "keiyaku", version, description: SERVER_DESCRIPTION },
    { capabilities: { tools: {} }, instructions: SERVER_DESCRIPTION },
  );
}

export function createKeiyakuMcpServer(input: McpAdapterInput): Readonly<{ server: Server; close(): Promise<void> }> {
  const cwd = input.cwd;
  const environment = { ...input.environment };
  const home = environment.KEIYAKU_HOME?.trim() || undefined;
  const actorContext = environment.KEIYAKU_ACTOR_ID === undefined ? {} : { actor: environment.KEIYAKU_ACTOR_ID };
  const server = createMcpServer(input.version);
  const catalogue = describeModelTools();
  const tools: Tool[] = catalogue.map(({ verb: _verb, ...tool }) => tool as Tool);
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const entry = catalogue.find((tool) => tool.name === request.params.name);
    if (entry === undefined) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    const operation = call(entry.verb, request.params.arguments, extra.signal);
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
    let recoveryCoordinates: RenderVerbContext["recoveryCoordinates"];
    try {
      const parsed = modelCoordinates(name).safeParse({
        ...(callCwd === undefined ? {} : { cwd: callCwd }),
        ...(repo === undefined ? {} : { repo }),
      });
      if (!parsed.success) throw new KeiyakuUsageError(parsed.error.message);
      const coordinates = { ...parsed.data, cwd: resolve(cwd, parsed.data.cwd ?? ".") };
      if (name === "wait") recoveryCoordinates = coordinates;
      const facet = Keiyaku.for({ ...coordinates, environment, ...(home === undefined ? {} : { home }) });
      completion = { kind: "returned", value: await facet.run(name, value, { signal }) };
    } catch (error) {
      completion = { kind: "threw", error };
    }
    try {
      const disposition = classifyVerb(name, value, completion);
      const text = renderVerb(name, value, completion, {
        surface: "mcp",
        disposition,
        ...(recoveryCoordinates === undefined ? {} : { recoveryCoordinates }),
        columns: DEFAULT_CLI_COLUMNS,
        color: false,
        now: Date.now(),
        ...(name === "report" || name === "ls" ? actorContext : {}),
      });
      const failure = completion.kind === "threw" ? projectFailure(completion.error) : undefined;
      const output = modelToolOutput(name, completion, disposition, failure?.spawn);
      return {
        content: [
          { type: "text", text: output.isError ? `${disposition}\n${text}` : text },
          ...(failure === undefined ? [] : [{ type: "text" as const, text: JSON.stringify(failure) }]),
        ],
        ...output,
        _meta: { "keiyaku/disposition": disposition },
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
