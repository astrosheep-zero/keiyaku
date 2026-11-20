import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { harnessOwner } from "@astrosheep/square";
import { registerKeiyakuStatus } from "./status.js";
import { Keiyaku, KeiyakuUsageError } from "../library/keiyaku.js";
import {
  classifyVerb,
  type VerbCompletion,
  type VerbInput,
  type VerbOutput,
  type VerbName,
} from "../library/keiyaku-verbs.js";
import { describeModelTools, modelCoordinates, modelToolOutput } from "../library/model-tools.js";
import { projectFailure } from "../library/outcome.js";
import { renderVerb } from "../cli/render/verbs.js";
import { DEFAULT_CLI_COLUMNS } from "../cli/render/terminal.js";
import { SERVER_DESCRIPTION } from "../mcp/description.js";

function invocationContext(ctx: ExtensionContext) {
  const environment = Object.freeze({ ...process.env });
  const home = environment.KEIYAKU_HOME?.trim() || undefined;
  return {
    cwd: ctx.cwd,
    environment,
    identity: { owner: harnessOwner({ channel: "pi", session: ctx.sessionManager.getSessionId() }) },
    ...(home === undefined ? {} : { home }),
  };
}

/** Register the shipped presentation and native tools without exposing execution internals. */
export function registerKeiyakuExtension(pi: ExtensionAPI): void {
  registerKeiyakuTools(pi);
  registerKeiyakuStatus(pi, invocationContext);
}

/** Register the native codemode integration; execution remains on the invocation facet. */
export function registerKeiyakuTools(pi: ExtensionAPI): void {
  const namespace = { name: "keiyaku", description: SERVER_DESCRIPTION, instructions: SERVER_DESCRIPTION };
  for (const entry of describeModelTools()) {
    const name = entry.verb;
    pi.registerTool({
      name: `keiyaku_${entry.name}`,
      label: `Keiyaku ${entry.name}`,
      description: entry.description,
      exposure: "codemode",
      namespace,
      annotations: entry.annotations,
      parameters: entry.inputSchema,
      ...(entry.outputSchema === undefined ? {} : { outputSchema: entry.outputSchema }),
      async execute(_id, args, signal, _onUpdate, ctx) {
        const { cwd, repo, ...business } = args as Record<string, unknown>;
        const value = business as VerbInput<VerbName>;
        let environment: NodeJS.ProcessEnv = {};
        let completion: VerbCompletion<VerbOutput<VerbName>>;
        try {
          const parsed = modelCoordinates(name).safeParse({
            ...(cwd === undefined ? {} : { cwd }),
            ...(repo === undefined ? {} : { repo }),
          });
          if (!parsed.success) throw new KeiyakuUsageError(parsed.error.message);
          const invocation = invocationContext(ctx);
          environment = invocation.environment;
          const facet = Keiyaku.for({
            ...invocation,
            cwd: resolve(invocation.cwd, parsed.data.cwd ?? "."),
            ...(!("repo" in parsed.data) || parsed.data.repo === undefined ? {} : { repo: parsed.data.repo }),
          });
          completion = {
            kind: "returned",
            value: await facet.run(name, value, signal === undefined ? {} : { signal }),
          };
        } catch (error) {
          completion = { kind: "threw", error };
        }
        const disposition = classifyVerb(name, value, completion);
        const failure = completion.kind === "threw" ? projectFailure(completion.error) : undefined;
        const output = modelToolOutput(name, completion, disposition, failure?.spawn);
        const text = renderVerb(name, value, completion, {
          surface: "mcp",
          columns: DEFAULT_CLI_COLUMNS,
          color: false,
          now: Date.now(),
          ...(environment.KEIYAKU_ACTOR_ID === undefined ? {} : { actor: environment.KEIYAKU_ACTOR_ID }),
        });
        return {
          content: [
            { type: "text", text: output.isError ? `${disposition}\n${text}` : text },
            ...(failure === undefined ? [] : [{ type: "text" as const, text: JSON.stringify(failure) }]),
          ],
          ...output,
          details: { disposition },
        };
      },
    });
  }
  pi.on("session_start", (_event, ctx) => {
    const codemode = pi.getAllTools().find((tool) => tool.name === "codemode" && tool.reachesTools);
    if (codemode === undefined) {
      ctx.ui.notify("Keiyaku tools are callable only from codemode; codemode is not loaded.", "warning");
      return;
    }
    const active = pi.getActiveTools();
    if (!active.includes(codemode.name)) pi.setActiveTools([...active, codemode.name]);
  });
}
