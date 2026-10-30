import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AkumaHost,
  Akumas,
  Repo,
  Schema,
  World,
  listArchetypeDefinitions,
  type CallResult,
  type AkumaHostScope,
  type AkumaCaller,
  type AkumaAddressInput,
  type AkumaAskInput,
  type AkumaHistoryInput,
  type AkumaKillInput,
  type AkumaListInput,
  type AkumaTellInput,
  type AkumaWaitInput,
  type ForkInput,
  type JsonSchemaDocument,
  type WorldRoot,
} from "@astrosheep/keiyaku";

const selector = { type: "string", minLength: 1, description: "Akuma ID or World-local alias" };
const selectors = {
  type: "array",
  items: selector,
  minItems: 1,
  description: "IDs, aliases or glob selectors; Contract selectors require repo",
};
const repo = { type: "string", minLength: 1, description: "Optional Git worktree path, relative to session cwd" };
const body = { type: "string", minLength: 1, description: "Input to admit; an observation deadline never retracts it" };
const interrupt = {
  type: "boolean",
  description: "Admit input with a request for current work to yield; admission survives failed retirement",
};
const detach = {
  type: "boolean",
  description:
    "Launch future work detached (default false: this Pi session's in-process scope). Never relocates an already running Body.",
};
const bare = {
  type: "boolean",
  description: "Omit Keiyaku runtime instructions only; preserved through wake and inherited by forks",
};
const timeoutMs = {
  type: "integer",
  minimum: 0,
  description: "Observation limit in milliseconds; omitted is unbounded",
};
const limit = { type: "integer", minimum: 1 };

type ToolAddress<Input> = Omit<Input, "repo" | "signal"> & { repo?: string };
type LaunchChoice = { detach?: boolean };

function caller(ctx: ExtensionContext): AkumaCaller {
  return { kind: "external", integration: "pi", id: ctx.sessionManager.getSessionId() };
}

/** Native adaptation only. Addressing, admission, observation and lifecycle stay with Keiyaku. */
export function registerAkumaTools(pi: ExtensionAPI): void {
  pi.registerFlag("keiyaku-request-only", {
    type: "boolean",
    default: false,
    description: "Disable local native Akuma tools in provider-owned Pi sessions; use the request-aware CLI",
  });
  type Session = { id: string; host?: AkumaHostScope; closed: boolean };
  let current: Session | undefined;
  const create = (ctx: ExtensionContext): Session => ({
    id: ctx.sessionManager.getSessionId(),
    ...(pi.getFlag("keiyaku-request-only") === true ? {} : { host: AkumaHost.inProcess() }),
    closed: false,
  });
  function session(ctx: ExtensionContext): Session {
    if (current === undefined) current = create(ctx);
    if (current.id !== ctx.sessionManager.getSessionId())
      throw new Error("Keiyaku Pi session has changed; wait for session_start");
    if (current.closed) throw new Error("Keiyaku Pi session is shutting down");
    if (current.host === undefined)
      throw new Error(
        "Native Akuma tools require an external Pi session. Inside an Akuma use the request-aware keiyaku CLI (direct-parent permissions apply).",
      );
    return current;
  }
  pi.on("session_start", (_event, ctx) => {
    if (current?.id === ctx.sessionManager.getSessionId() && !current.closed) return;
    if (current !== undefined && !current.closed) throw new Error("Previous Keiyaku Pi session has not shut down");
    current = create(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const owned = current;
    if (owned === undefined || owned.id !== ctx.sessionManager.getSessionId()) return;
    owned.closed = true;
    await owned.host?.close();
  });
  function register<Input>(
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    run: (
      input: Input,
      akumas: Akumas,
      ctx: ExtensionContext,
      signal: AbortSignal | undefined,
      world: WorldRoot,
    ) => Promise<object>,
  ): void {
    pi.registerTool({
      name,
      label: name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: true },
      async execute(_id, raw, signal, _update, ctx) {
        // SDK flag injection happens after the factory. Read here, before World
        // establishment, including when invoked as another tool's nested call.
        if (pi.getFlag("keiyaku-request-only") === true)
          throw new Error(
            "Native Akuma tools require an external Pi session. Inside an Akuma use the request-aware keiyaku CLI (direct-parent permissions apply).",
          );
        const owned = session(ctx);
        signal?.throwIfAborted();
        const world = await (await World.resolve(ctx.cwd)).establish();
        if (owned.closed) throw new Error("Keiyaku Pi session is shutting down");
        const { detach: detached, ...input } = raw as Input & LaunchChoice;
        let result: object;
        try {
          result = await run(
            input as Input,
            Akumas.of(world, detached ? { hosting: "detached" } : owned.host),
            ctx,
            signal,
            world,
          );
        } catch (error) {
          // SDK exceptions can retain a leading birth. Do not turn that known
          // identity into a text-only error or pretend the birth was rolled back.
          if (!(error instanceof Error) || !("akuma" in error) || typeof error.akuma !== "string") throw error;
          result = { akuma: error.akuma, failure: { diagnostic: error.message } };
          const text = JSON.stringify(result);
          return {
            content: [{ type: "text", text }],
            details: result,
            structuredContent: JSON.parse(text),
            isError: true,
          };
        }
        const text = JSON.stringify(result);
        return {
          content: [{ type: "text", text }],
          details: result,
          structuredContent: JSON.parse(text),
        };
      },
    });
  }

  async function address<Input extends { repo?: string }>(input: Input, ctx: ExtensionContext) {
    const { repo: path, ...rest } = input;
    return { ...rest, ...(path === undefined ? {} : { repo: await Repo.at({ path: resolve(ctx.cwd, path) }) }) };
  }

  register<{
    akuma: string;
    body: string;
    workdir?: string;
    bare?: boolean;
    wait?: boolean;
    timeoutMs?: number;
    schema?: JsonSchemaDocument;
  }>(
    "akuma_call",
    "Call any configured Akuma provider. By default launch in this Pi session and return birth plus first-Tell receipt immediately. detach selects detached hosting; wait separately observes the first answer (default five-minute bound). Deadlines/abort stop observation, not admitted execution. Session shutdown retires only this session's in-process launches.",
    {
      akuma: {
        type: "string",
        minLength: 1,
        pattern: "\\S",
        description: "Callable definition name (see akuma_definitions)",
      },
      body,
      workdir: { type: "string", minLength: 1, description: "Execution directory relative to Pi cwd (default Pi cwd)" },
      detach,
      bare,
      wait: { type: "boolean", description: "Observe first answer, independently of host choice (default false)" },
      timeoutMs,
      schema: { type: "object", additionalProperties: true },
    },
    ["akuma", "body"],
    async (input, akumas, ctx, signal) => {
      if (input.timeoutMs !== undefined && input.wait !== true) throw new TypeError("timeoutMs requires wait: true");
      const result: CallResult = await akumas.call({
        archetype: input.akuma,
        body: input.body,
        cwd: resolve(ctx.cwd, input.workdir ?? "."),
        mode: input.wait ? "wait" : "detach",
        caller: caller(ctx),
        ...(input.bare === undefined ? {} : { bare: input.bare }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.schema === undefined ? {} : { schema: Schema.json(input.schema, (value) => value) }),
        ...(signal === undefined ? {} : { signal }),
      });
      return result;
    },
  );

  register<ToolAddress<AkumaAddressInput>>(
    "akuma_status",
    "Observe one Akuma's lifecycle, current work and retained outcome. No mutation.",
    { akuma: selector, repo },
    ["akuma"],
    async (input, akumas, ctx) => akumas.status(await address(input, ctx)),
  );
  register<AkumaListInput>(
    "akuma_list",
    "List a bounded recent-activity roster of Akuma instances, with aliases. Use akuma_definitions for callable names.",
    { archetype: { type: "string", minLength: 1 }, limit },
    [],
    async (input, akumas) => akumas.list(input),
  );
  register<{ limit?: number }>(
    "akuma_definitions",
    "List visible callable Akuma definitions for all configured providers (not running instances).",
    { limit },
    [],
    async (input, _akumas, _ctx, _signal, world) => listArchetypeDefinitions({ project: world, ...input }),
  );
  register<ToolAddress<AkumaTellInput> & LaunchChoice>(
    "akuma_tell",
    "Admit input without awaiting its answer. detach explicitly selects future wake hosting (default this Pi session); running work stays in its current host. Optional interrupt admits first, then requests current work to yield.",
    { akuma: selector, body, interrupt, detach, repo },
    ["akuma", "body"],
    async (input, akumas, ctx, signal) =>
      akumas.tell({ ...(await address(input, ctx)), ...(signal === undefined ? {} : { signal }) }),
  );
  register<ToolAddress<Omit<AkumaAskInput, "schema" | "observe">> & LaunchChoice & { schema?: JsonSchemaDocument }>(
    "akuma_ask",
    "Admit input and observe that exact answer. timeoutMs/abort stop observation, never admitted work. detach selects future wake hosting (default this Pi session), never relocates running work. Optional JSON Schema is a provider answer contract; parsed JSON is returned without arbitrary local schema validation.",
    {
      akuma: selector,
      body,
      interrupt,
      detach,
      timeoutMs,
      schema: { type: "object", additionalProperties: true },
      repo,
    },
    ["akuma", "body"],
    async (input, akumas, ctx, signal) => {
      const { schema, ...rest } = await address(input, ctx);
      return akumas.ask({
        ...rest,
        ...(signal === undefined ? {} : { signal }),
        ...(schema === undefined ? {} : { schema: Schema.json(schema, (value) => value) }),
      });
    },
  );
  register<ToolAddress<AkumaWaitInput>>(
    "akuma_wait",
    "Observe existing Akuma-wide work for a frozen selection. Defaults to any; all waits for every member. Completion is not proof of success. Deadline/cancellation does not stop workers.",
    { akuma: selectors, completion: { type: "string", enum: ["any", "all"] }, timeoutMs, repo },
    ["akuma"],
    async (input, akumas, ctx, signal) =>
      akumas.wait({ ...(await address(input, ctx)), ...(signal === undefined ? {} : { signal }) }),
  );
  register<ToolAddress<AkumaHistoryInput>>(
    "akuma_history",
    "Read retained execution history, the last answer, or one exact turn/n outcome. id cannot combine with paging or last. before/since are durable sequence cursors, not timestamps.",
    {
      akuma: selector,
      id: { type: "string", pattern: "^turn/[1-9][0-9]*$" },
      before: { type: "integer", minimum: 1 },
      since: { type: "integer", minimum: 1 },
      limit,
      last: { type: "boolean" },
      repo,
    },
    ["akuma"],
    async (input, akumas, ctx) => akumas.history(await address(input, ctx)),
  );
  register<ToolAddress<ForkInput> & LaunchChoice>(
    "akuma_fork",
    "Fork one exact retained answered turn/n into a prompt-free Akuma. detach selects birth hosting (default this Pi session). Source is unchanged. Native refusal preserves unavailable history/provider capability; cancellation cannot undo birth.",
    { akuma: selector, at: { type: "string", pattern: "^turn/[1-9][0-9]*$" }, detach, bare, repo },
    ["akuma", "at"],
    async (input, akumas, ctx) =>
      akumas.fork({
        ...(await address(input, ctx)),
        caller: caller(ctx),
      }),
  );
  register<ToolAddress<AkumaKillInput>>(
    "akuma_kill",
    "Stop current work for a frozen Akuma selection without admitting input or deleting history. Returns each owner's honest stop evidence; does not shut down this Pi host.",
    { akuma: selectors, repo },
    ["akuma"],
    async (input, akumas, ctx, signal) =>
      akumas.kill({ ...(await address(input, ctx)), ...(signal === undefined ? {} : { signal }) }),
  );
}
