import { readFile } from "node:fs/promises";
import { squareAssignedParticipantName } from "@astrosheep/square";
import { emitInitiatingPluginSignal } from "../../plugin/akuma-signals.js";
import { type AkuId } from "../../akuma/identity.js";
import { type ActivityHistory, type AkumaStatus } from "../../akuma/akuma.js";
import type { WaitObservedAkuma } from "../../akuma/fleet-execution.js";
import { observeAkumaStatus } from "../../akuma/akuma-observe.js";
import {
  AuthorityCorruptionError,
  Keiyaku,
  type AkumaKillResult,
  type AkumaHistoryResult,
  type AkumaObservation,
  type AkumaTellResult,
  type AkumaWaitResult,
  type CallInput,
  type CallObservation,
  type CallResult,
  type ForkResult,
  type IntegrationFailure,
  type Keiyaku as KeiyakuContract,
  type Repo,
} from "../../index.js";
import { activityStream, waitObservationStream } from "../render/akuma-activity.js";
import { renderAkumaText } from "../render/akuma.js";
import type { TextRenderContext } from "../render/terminal.js";
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
  | Readonly<{ kind: "akuma"; action: "wait"; result: AkumaWaitResult; alias?: string; streamed?: boolean }>
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
  executionCwd?: string;
  home?: string;
  settings?: Settings;
  contract?: KeiyakuContract;
  repo?: Repo;
  environment: NodeJS.ProcessEnv;
  readStdin(): Promise<string>;
  execution?: ExecutionContext;
}>;

/** The window a call observes for when the caller gives no `--wait` duration. */
const CALL_TIMEOUT_MS = 300_000;

/** The call the CLI makes once its prompt, schema, and placement are resolved. */
type CallRequest = Omit<CallInput, "mode" | "timeoutMs">;

function integrationFailure(error: unknown): IntegrationFailure {
  return {
    kind: error instanceof AuthorityCorruptionError ? "authority-corruption" : "infrastructure",
    diagnostic: error instanceof Error ? error.message : String(error),
  };
}

/** The display context the command result renders with, so live rows match it. */
function resultContext(): TextRenderContext {
  return {
    columns: process.stdout.isTTY === true && Number.isInteger(process.stdout.columns) ? process.stdout.columns : 80,
    color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
  };
}

function writeProgress(body: string): void {
  process.stderr.write(body.endsWith("\n") ? body : `${body}\n`);
}

/**
 * The live half of an observe-mode call: the birth receipt prints as soon as
 * the identity exists, and every later observation prints the transcript rows
 * that have settled since the previous one. The stream is append-only and
 * shares the snapshot renderer, so a folded tool burst never reopens.
 */
function callObservationStream(
  command: Extract<InvokedAkumaCommand, { command: "call" }>,
  input: InvokeInput,
  born: CallResult,
): (status: AkumaStatus) => void {
  const context = resultContext();
  const receipt = renderAkumaText(command, { kind: "akuma", action: "call", result: born, world: input.path }, context);
  const stream = activityStream(context);
  let opened = false;
  return (status) => {
    if (!opened) {
      opened = true;
      writeProgress(receipt);
    }
    const lines = stream(status.timeline);
    if (lines.length > 0) writeProgress(lines.join("\n"));
  };
}

async function observeCallUntilComplete(
  command: Extract<InvokedAkumaCommand, { command: "call" }>,
  input: InvokeInput,
  born: CallResult,
): Promise<CallObservation> {
  try {
    const status = await observeAkumaStatus(input.path, born.akuma, {
      timeoutMs: command.timeoutMs ?? CALL_TIMEOUT_MS,
      observe: callObservationStream(command, input, born),
    });
    return { kind: "observed", status };
  } catch (error) {
    return { kind: "failed", failure: integrationFailure(error) };
  }
}

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

/**
 * The live half of a local wait: each observation round opens every newly seen
 * Akuma with its identity frame, then prints only the rows that settled since
 * the previous round. The first sighting of an Akuma only establishes its
 * baseline, so an already settled Akuma prints no backlog rows. When the wait
 * ends, `conclude` prints its closing scoreboard on the same channel.
 */
function writeWaitObservationStream(stream: ReturnType<typeof waitObservationStream>) {
  return (observed: readonly WaitObservedAkuma[]): void => {
    const lines = stream.observe(observed);
    if (lines.length > 0) writeProgress(lines.join("\n"));
  };
}

async function invokeWait(
  command: Extract<InvokedAkumaCommand, { command: "wait" }>,
  input: InvokeInput,
): Promise<AkumaInvocationResult> {
  const alias = command.akuma.length === 1 ? inputAlias(command.akuma[0]!) : undefined;
  const stream = command.output === "text" ? waitObservationStream(resultContext()) : undefined;
  const result = await waitAkuma(
    {
      path: input.path,
      akuma: command.akuma,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(command.completion === undefined ? {} : { completion: command.completion }),
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    },
    input.execution ?? localExecutionContext(),
    stream === undefined ? undefined : writeWaitObservationStream(stream),
  );
  if (stream !== undefined && stream.streamed()) {
    const closing = stream.conclude(result);
    if (closing.length > 0) writeProgress(closing);
    return {
      kind: "akuma",
      action: "wait",
      result,
      streamed: true,
      ...(alias === undefined ? {} : { alias }),
    };
  }
  return {
    kind: "akuma",
    action: "wait",
    result,
    ...(alias === undefined ? {} : { alias }),
  };
}

async function inputInitiator(input: InvokeInput): Promise<Readonly<{ initiator?: string }>> {
  let initiator: string | undefined;
  try {
    initiator = squareAssignedParticipantName(input.environment);
  } catch {}
  if (initiator === undefined) return {};
  try {
    await emitInitiatingPluginSignal({
      world: input.path,
      ...(input.settings === undefined ? {} : { settings: input.settings }),
      initiator,
      reportDiagnostic: (message) => process.stderr.write(`${message}\n`),
    });
  } catch (error) {
    process.stderr.write(`! plugin initiation: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return { initiator };
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
    const initiator = await inputInitiator(input);
    const channel = executionChannel(input.execution);
    const answer =
      channel.kind === "body-request"
        ? await requestForwardedFleetTellAnswer({
            directory: channel.directory,
            target: addressed.id,
            body,
            schema,
            interrupt: command.interrupt,
            ...initiator,
          })
        : await Akuma.select(addressed.path, addressed.id).tell(body, {
            schema,
            ...initiator,
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
  const initiator = await inputInitiator(input);
  if (command.interrupt) {
    const result = await Keiyaku.interrupt({
      ...initiator,
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
      ...initiator,
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
      const request: CallRequest = {
        ...(await inputInitiator(input)),
        path: input.path,
        archetype: command.archetype,
        body,
        ...(input.home === undefined ? {} : { home: input.home }),
        ...(input.settings === undefined ? {} : { settings: input.settings }),
        ...(input.executionCwd === undefined ? {} : { cwd: input.executionCwd }),
        ...(input.contract === undefined ? {} : { contract: input.contract }),
        ...(command.alias === undefined ? {} : { alias: command.alias }),
        ...(command.allowed === undefined ? {} : { allowed: command.allowed }),
        ...(schema === undefined ? {} : { schema }),
      };
      const observing = schema === undefined && command.mode === "wait" && command.output === "text";
      const born = await caller.call(
        observing
          ? { ...request, mode: "detach" }
          : {
              ...request,
              mode: command.mode,
              ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
            },
      );
      const result = observing ? { ...born, observation: await observeCallUntilComplete(command, input, born) } : born;
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
