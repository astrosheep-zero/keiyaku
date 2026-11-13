import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AkumaHost,
  Akumas,
  Repo,
  World,
  KeiyakuError,
  type SpawnResult,
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
export function registerAkumaTools(pi: ExtensionAPI, exposure: "hidden" | "direct" = "hidden"): void {
  type Session = { id: string; host: AkumaHostScope; closed: boolean };
  let current: Session | undefined;
  const create = (ctx: ExtensionContext): Session => ({
    id: ctx.sessionManager.getSessionId(),
    host: AkumaHost.inProcess(),
    closed: false,
  });
  function session(ctx: ExtensionContext): Session {
    if (current === undefined) current = create(ctx);
    if (current.id !== ctx.sessionManager.getSessionId())
      throw new Error("Keiyaku Pi session has changed; wait for session_start");
    if (current.closed) throw new Error("Keiyaku Pi session is shutting down");
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
    await owned.host.close();
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
      exposure,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: true },
      async execute(_id, raw, signal, _update, ctx) {
        const owned = session(ctx);
        signal?.throwIfAborted();
        const world = await (await World.resolve(ctx.cwd)).establish();
        if (owned.closed) throw new Error("Keiyaku Pi session is shutting down");
        const { detach: detached, ...input } = raw as Input & LaunchChoice;
        let result: object;
        let failed = false;
        try {
          result = await run(
            input as Input,
            Akumas.of(world, detached ? { hosting: "detached" } : owned.host),
            ctx,
            signal,
            world,
          );
        } catch (error) {
          let cause = error;
          while (cause instanceof KeiyakuError && cause.constructor === KeiyakuError) cause = cause.cause;
          result = {
            kind: "failed",
            category: error instanceof KeiyakuError
              ? error.category
              : error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
                ? "aborted" : "internal",
            diagnostic: error instanceof Error ? error.message : String(error),
            ...(cause instanceof Error ? { causeClass: cause.name, causeDiagnostic: cause.message } : {}),
            ...(error instanceof KeiyakuError ? {
              ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
              ...(error.spawn === undefined ? {} : { spawn: error.spawn }),
              ...(error.tell === undefined ? {} : { tell: error.tell }),
            } : {}),
          };
          failed = true;
        }
        const text = JSON.stringify(result);
        return {
          content: [{ type: "text", text }],
          details: result,
          structuredContent: JSON.parse(text),
          ...(failed ? { isError: true } : {}),
        };
      },
    });
  }

  async function address<Input extends { repo?: string }>(input: Input, ctx: ExtensionContext) {
    const { repo: path, ...rest } = input;
    return { ...rest, ...(path === undefined ? {} : { repo: await Repo.at({ path: resolve(ctx.cwd, path) }) }) };
  }

  register<{
    akumaName: string;
    body: string;
    workdir?: string;
    writableDirectories?: readonly string[];
    bare?: boolean;
    wait?: boolean;
    timeoutMs?: number;
  }>(
    "akuma_spawn",
    "Spawn any configured Akuma provider. By default launch in this Pi session and return birth plus first-Tell receipt immediately. detach selects detached hosting; wait separately observes the first answer (default five-minute bound). Deadlines/abort stop observation, not admitted execution. Session shutdown retires only this session's in-process launches.",
    {
      akumaName: {
        type: "string",
        minLength: 1,
        pattern: "\\S",
        description: "Spawnable Akuma name (see akuma_definitions)",
      },
      body,
      workdir: { type: "string", minLength: 1, description: "Execution directory relative to Pi cwd (default Pi cwd)" },
      detach,
      writableDirectories: {
        type: "array",
        items: { type: "string", minLength: 1 },
        description:
          "Additional existing canonical absolute writable directories (Codex only); preserves native sandbox/network policy. Separate from product actions.",
      },
      bare,
      wait: { type: "boolean", description: "Observe first answer, independently of host choice (default false)" },
      timeoutMs,
    },
    ["akumaName", "body"],
    async (input, akumas, ctx, signal) => {
      if (input.timeoutMs !== undefined && input.wait !== true) throw new TypeError("timeoutMs requires wait: true");
      const result: SpawnResult = await akumas.spawn({
        akumaName: input.akumaName,
        body: input.body,
        cwd: resolve(ctx.cwd, input.workdir ?? "."),
        ...(input.writableDirectories === undefined ? {} : { writableDirectories: input.writableDirectories }),
        mode: input.wait ? "wait" : "detach",
        caller: caller(ctx),
        ...(input.bare === undefined ? {} : { bare: input.bare }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
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
  register<ToolAddress<AkumaListInput>>(
    "akuma_list",
    "List bounded recent Akuma instances with current work, outcomes, aliases and optional Contract associations. Use akuma_definitions for spawnable names.",
    { akumaName: { type: "string", minLength: 1 }, limit, repo },
    [],
    async (input, akumas, ctx) => akumas.list(await address(input, ctx)),
  );
  register<{ limit?: number }>(
    "akuma_definitions",
    "List visible spawnable Akuma definitions for all configured providers (not running instances).",
    { limit },
    [],
    async (input, akumas) => akumas.akumaNames(input),
  );
  register<ToolAddress<AkumaTellInput> & LaunchChoice>(
    "akuma_tell",
    "Admit text input, optionally awaiting its exact answer with wait. timeoutMs requires wait; omitted timeout with wait is unbounded. detach selects future wake hosting (default this Pi session). Optional interrupt admits first, then requests current work to yield.",
    { akuma: selector, body, interrupt, detach, repo, wait: { type: "boolean" }, timeoutMs },
    ["akuma", "body"],
    async (input, akumas, ctx, signal) => akumas.tell({ ...(await address(input, ctx)), ...(signal === undefined ? {} : { signal }) }),
  );
  register<ToolAddress<Omit<AkumaAskInput, "observe">> & LaunchChoice>(
    "akuma_ask",
    "Admit input and observe its JSON answer under the required JSON Schema provider contract. timeoutMs/abort stop observation, never admitted work. detach selects future wake hosting (default this Pi session). Parsed JSON is returned without local schema validation.",
    {
      akuma: selector,
      body,
      interrupt,
      detach,
      timeoutMs,
      schema: { type: "object", additionalProperties: true },
      repo,
    },
    ["akuma", "body", "schema"],
    async (input, akumas, ctx, signal) => akumas.ask({ ...(await address(input, ctx)), ...(signal === undefined ? {} : { signal }) }),
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
    "Read retained execution history, the last answer, one exact turn/n outcome, or one exact report/n. id cannot combine with paging or last. before/since are durable sequence cursors, not timestamps.",
    {
      akuma: selector,
      id: { type: "string", pattern: "^(turn|report)/[1-9][0-9]*$" },
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
