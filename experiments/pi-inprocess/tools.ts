import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Akumas,
  Repo,
  Schema,
  World,
  listArchetypeDefinitions,
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
} from "../../src/index.js";

const selector = { type: "string", minLength: 1, description: "Akuma ID or World-local alias" };
const selectors = {
  type: "array",
  items: selector,
  minItems: 1,
  description: "IDs, aliases or glob selectors; Contract selectors require repo",
};
const repo = { type: "string", minLength: 1, description: "Optional Git worktree path, relative to session cwd" };
const body = { type: "string", minLength: 1, description: "Input to admit; an observation deadline never retracts it" };
const interrupt = { type: "boolean", description: "Put down current work before admitting this input" };
const timeoutMs = {
  type: "integer",
  minimum: 0,
  description: "Observation limit in milliseconds; omitted is unbounded",
};
const limit = { type: "integer", minimum: 1 };

type ToolAddress<Input> = Omit<Input, "repo" | "signal"> & { repo?: string };

/** Native adaptation only. Addressing, admission, observation and lifecycle stay with Keiyaku. */
export function registerAkumaTools(pi: ExtensionAPI, isClosing: () => boolean): void {
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
        if (isClosing()) throw new Error("Pi in-process PoC is shutting down");
        signal?.throwIfAborted();
        const world = await (await World.resolve(ctx.cwd)).establish();
        const result = await run(raw as Input, Akumas.of(world), ctx, signal, world);
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
    "List visible callable Akuma definitions (not running instances). Call currently requires a Pi-backed definition.",
    { limit },
    [],
    async (input, _akumas, _ctx, _signal, world) => listArchetypeDefinitions({ project: world, ...input }),
  );
  register<ToolAddress<AkumaTellInput>>(
    "akuma_tell",
    "Admit input to one Akuma without awaiting its answer; interrupt optionally puts down current work. Live Pi Bodies use SQLite/native steering; asleep or interrupted targets use Keiyaku's standard detached wake, not this host.",
    { akuma: selector, body, interrupt, repo },
    ["akuma", "body"],
    async (input, akumas, ctx, signal) =>
      akumas.tell({ ...(await address(input, ctx)), ...(signal === undefined ? {} : { signal }) }),
  );
  register<ToolAddress<Omit<AkumaAskInput, "schema" | "observe">> & { schema?: JsonSchemaDocument }>(
    "akuma_ask",
    "Admit input and observe that exact answer. timeoutMs bounds observation, not execution. Optional JSON Schema is a provider answer contract; answers are parsed as JSON, without arbitrary local schema validation. Asleep/interrupt wake uses the standard detached path.",
    { akuma: selector, body, interrupt, timeoutMs, schema: { type: "object", additionalProperties: true }, repo },
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
  register<ToolAddress<ForkInput>>(
    "akuma_fork",
    "Fork one exact retained answered turn/n into a new prompt-free Akuma; source is unchanged. Uses Keiyaku's standard detached birth, NOT in-process hosting. Returns native refusal for unavailable history/provider capability. Cancellation after submission cannot undo birth.",
    { akuma: selector, at: { type: "string", pattern: "^turn/[1-9][0-9]*$" }, repo },
    ["akuma", "at"],
    async (input, akumas, ctx) =>
      akumas.fork({
        ...(await address(input, ctx)),
        caller: { kind: "external", integration: "pi", id: ctx.sessionManager.getSessionId() },
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
