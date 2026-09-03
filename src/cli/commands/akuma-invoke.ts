import { readFile } from "node:fs/promises";
import { type AkuId } from "../../akuma/identity.js";
import { type ActivityHistory } from "../../akuma/akuma.js";
import {
  Keiyaku,
  type AkumaKillResult,
  type AkumaHistoryResult,
  type AkumaObservation,
  type AkumaTellResult,
  type AkumaWaitResult,
  type CallResult,
  type ForkResult,
  type Keiyaku as KeiyakuContract,
  type Repo,
} from "../../index.js";
import type { Settings } from "../../settings.js";
import type { WorldRoot } from "../../world.js";
import type { AkumaPromptSource, InvokedAkumaCommand } from "./akuma.js";
import { killAkuma, tellAkuma, waitAkuma } from "../../library/fleet.js";
import { localExecutionContext, type ExecutionContext } from "../../akuma/requests.js";
import { Akuma, Schema, type JsonSchemaDocument } from "../../akuma/index.js";
import { addressAkuma } from "../../library/address.js";
import { executionChannel } from "../../akuma/requests.js";
import { requestForwardedFleetTellAnswer } from "../../akuma/fleet-request.js";

export type AkumaInvocationResult =
  | Readonly<{ kind: "akuma"; action: "call"; result: CallResult; world: WorldRoot; schemaAnswer?: unknown }>
  | Readonly<{ kind: "akuma"; action: "status"; status: AkumaObservation; alias?: string }>
  | Readonly<{ kind: "akuma"; action: "wait"; result: AkumaWaitResult; alias?: string }>
  | Readonly<{ kind: "akuma"; action: "tell"; mode: "ordinary"; result: AkumaTellResult; body: string; alias?: string }>
  | Readonly<{ kind: "akuma"; action: "tell"; mode: "schema"; result: unknown; body: string; alias?: string }>
  | Readonly<{
      kind: "akuma";
      action: "tell";
      mode: "interrupt";
      result: Awaited<ReturnType<typeof Keiyaku.interrupt>>;
      body: string;
      alias?: string;
    }>
  | Readonly<{
      kind: "akuma";
      action: "history";
      akuma: AkuId;
      mode: "page";
      history: ActivityHistory;
      historyResult: AkumaHistoryResult;
      alias?: string;
    }>
  | Readonly<{
      kind: "akuma";
      action: "history";
      akuma: AkuId;
      mode: "last";
      answer: string;
      historyResult: AkumaHistoryResult;
      alias?: string;
    }>
  | Readonly<{
      kind: "akuma";
      action: "history";
      akuma: AkuId;
      mode: "no-answer";
      historyResult: AkumaHistoryResult;
      alias?: string;
    }>
  | Readonly<{
      kind: "akuma";
      action: "history";
      akuma: AkuId;
      mode: "exact";
      historyResult: AkumaHistoryResult;
      alias?: string;
    }>
  | Readonly<{ kind: "akuma"; action: "fork"; receipt: ForkResult }>
  | Readonly<{ kind: "akuma"; action: "kill"; result: AkumaKillResult; alias?: string }>;

type InvokeInput = Readonly<{
  path: WorldRoot;
  statedCwd?: string;
  home?: string;
  settings?: Settings;
  contract?: KeiyakuContract;
  repo?: Repo;
  environment: NodeJS.ProcessEnv;
  readStdin(): Promise<string>;
  execution?: ExecutionContext;
}>;

async function schemaFromFile(path: string): Promise<Schema<unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return Schema.json(parsed as JsonSchemaDocument, (value) => value);
  } catch (error) {
    throw new Error(`cannot read JSON Schema file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function inputAlias(selector: string): string | undefined {
  return selector.startsWith("@") ? selector : undefined;
}

async function promptBody(command: Readonly<{ prompt: AkumaPromptSource }>, input: InvokeInput): Promise<string> {
  return command.prompt.kind === "stdin" ? await input.readStdin() : command.prompt.value;
}

async function invokeWait(
  command: Extract<InvokedAkumaCommand, { command: "wait" }>,
  input: InvokeInput,
): Promise<AkumaInvocationResult> {
  const alias = command.akuma.length === 1 ? inputAlias(command.akuma[0]!) : undefined;
  return {
    kind: "akuma",
    action: "wait",
    result: await waitAkuma(
      {
        path: input.path,
        akuma: command.akuma,
        ...(input.repo === undefined ? {} : { repo: input.repo }),
        ...(command.completion === undefined ? {} : { completion: command.completion }),
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      },
      input.execution ?? localExecutionContext(),
    ),
    ...(alias === undefined ? {} : { alias }),
  };
}

async function invokeTell(
  command: Extract<InvokedAkumaCommand, { command: "tell" }>,
  input: InvokeInput,
): Promise<AkumaInvocationResult> {
  const body = await promptBody(command, input);
  if (command.schema !== undefined) {
    const schema = await schemaFromFile(command.schema);
    const addressed = await addressAkuma({
      path: input.path,
      akuma: command.akuma,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
    });
    const channel = executionChannel(input.execution);
    const answer =
      channel.kind === "body-request"
        ? await requestForwardedFleetTellAnswer({
            directory: channel.directory,
            target: addressed.id,
            body,
            schema,
            interrupt: command.interrupt,
          })
        : await Akuma.select(addressed.path, addressed.id).tell(body, {
            schema,
            ...(command.interrupt ? { interrupt: true } : {}),
          });
    const alias = inputAlias(command.akuma);
    return {
      kind: "akuma",
      action: "tell",
      mode: "schema",
      result: answer,
      body,
      ...(alias === undefined ? {} : { alias }),
    };
  }
  if (command.interrupt) {
    const result = await Keiyaku.interrupt({
      path: input.path,
      akuma: command.akuma,
      body,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
    });
    const alias = inputAlias(command.akuma);
    return {
      kind: "akuma",
      action: "tell",
      mode: "interrupt",
      result,
      body,
      ...(alias === undefined ? {} : { alias }),
    };
  }
  const result = await tellAkuma(
    {
      path: input.path,
      akuma: command.akuma,
      body,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
    },
    input.execution ?? localExecutionContext(),
  );
  const alias = inputAlias(command.akuma);
  return { kind: "akuma", action: "tell", mode: "ordinary", result, body, ...(alias === undefined ? {} : { alias }) };
}

async function invokeHistory(
  command: Extract<InvokedAkumaCommand, { command: "history" }>,
  input: InvokeInput,
): Promise<AkumaInvocationResult> {
  const result = await Keiyaku.history({
    path: input.path,
    akuma: command.akuma,
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(command.before === undefined ? {} : { before: command.before }),
    ...(command.since === undefined ? {} : { since: command.since }),
    ...(command.limit === undefined ? {} : { limit: command.limit }),
    ...(command.id === undefined ? {} : { id: command.id }),
    last: command.last,
  });
  return {
    kind: "akuma",
    action: "history",
    akuma: result.id,
    historyResult: result,
    ...(inputAlias(command.akuma) === undefined ? {} : { alias: command.akuma }),
    ...(command.id !== undefined
      ? { mode: "exact" as const }
      : result.kind === "history"
        ? { mode: "page" as const, history: result.history }
        : result.kind === "last"
          ? { mode: "last" as const, answer: result.answer }
          : { mode: "no-answer" as const }),
  };
}

async function invokeFork(
  command: Extract<InvokedAkumaCommand, { command: "fork" }>,
  input: InvokeInput,
): Promise<AkumaInvocationResult> {
  return {
    kind: "akuma",
    action: "fork",
    receipt: await Keiyaku.fork({
      path: input.path,
      akuma: command.akuma,
      at: command.at,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
    }),
  };
}

async function invokeKill(
  command: Extract<InvokedAkumaCommand, { command: "kill" }>,
  input: InvokeInput,
): Promise<AkumaInvocationResult> {
  const alias = command.akuma.length === 1 ? inputAlias(command.akuma[0]!) : undefined;
  return {
    kind: "akuma",
    action: "kill",
    result: await killAkuma(
      {
        path: input.path,
        akuma: command.akuma,
        ...(input.repo === undefined ? {} : { repo: input.repo }),
      },
      input.execution ?? localExecutionContext(),
    ),
    ...(alias === undefined ? {} : { alias }),
  };
}

export async function invokeAkuma(command: InvokedAkumaCommand, input: InvokeInput): Promise<AkumaInvocationResult> {
  switch (command.command) {
    case "call": {
      const body = await promptBody(command, input);
      const schema = command.schema === undefined ? undefined : await schemaFromFile(command.schema);
      const caller = input.execution === undefined ? Keiyaku : Keiyaku.withExecution({ execution: input.execution });
      const result = await caller.call({
        path: input.path,
        archetype: command.archetype,
        body,
        ...(input.home === undefined ? {} : { home: input.home }),
        ...(input.settings === undefined ? {} : { settings: input.settings }),
        ...(input.statedCwd === undefined ? {} : { cwd: input.statedCwd }),
        mode: command.mode,
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
        ...(input.contract === undefined ? {} : { contract: input.contract }),
        ...(command.alias === undefined ? {} : { alias: command.alias }),
        ...(command.allowed === undefined ? {} : { allowed: command.allowed }),
        ...(schema === undefined ? {} : { schema }),
      });
      if (schema !== undefined && command.mode === "wait" && result.schemaAnswer !== undefined) {
        return { kind: "akuma", action: "call", result, world: input.path, schemaAnswer: result.schemaAnswer };
      }
      return { kind: "akuma", action: "call", result, world: input.path };
    }
    case "wait":
      return await invokeWait(command, input);
    case "tell":
      return await invokeTell(command, input);
    case "history":
      return await invokeHistory(command, input);
    case "fork":
      return await invokeFork(command, input);
    case "kill":
      return await invokeKill(command, input);
  }
}

export async function invokeAkumaStatus(
  path: WorldRoot,
  akuma: string,
  alias?: string,
  repo?: Repo,
): Promise<AkumaInvocationResult> {
  return {
    kind: "akuma",
    action: "status",
    status: await Keiyaku.status({ path, akuma, ...(repo === undefined ? {} : { repo }) }),
    ...(alias === undefined ? {} : { alias }),
  };
}
