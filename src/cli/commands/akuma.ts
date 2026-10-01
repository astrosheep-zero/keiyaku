import type { AkumaPromptSource, InvokedAkumaCommand } from "./akuma-grammar.js";
import { CliUsageError, isBlankInput } from "../usage.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { squareAssignedParticipantName } from "@astrosheep/square";
import { emitInitiatingPluginSignal } from "../../plugin/akuma-signals.js";
import { canonicalBirthCwd } from "../../akuma/call-input.js";
import { Schema, type JsonSchemaDocument } from "../../akuma/index.js";
import type { ExecutionContext } from "../../akuma/requests.js";
import { executionChannel } from "../../akuma/requests.js";
import { settings, type Settings } from "../../settings.js";
import { AkumaWorldScopeError, type CallInput, type Keiyaku as KeiyakuContract, type Repo } from "../../index.js";
import { akumasWithExecution } from "../../library/akumas.js";
import type { WorldRoot } from "../../world.js";
import type { CliCoordinates } from "../coordinates.js";
import { contractFromInput } from "../selectors.js";
import { ActivityDriver } from "../activity.js";
import { displayContext, resultContext, writeJson, writeStderr, writeStdout } from "../streams.js";
import type { CliRuntime } from "../runtime.js";
import {
  callObservationStream,
  inputWaitStream,
  waitObservationStream,
  type WaitSelectedIdentity,
} from "../render/akuma-activity.js";
import { askRawAnswer, callRawAnswer, historyRawAnswer, waitRawAnswer } from "../render/akuma-activity.js";
import {
  askExitCode,
  askProgressStream,
  callExitCode,
  callObservationHead,
  forkExitCode,
  historyExitCode,
  killExitCode,
  renderCallText,
  renderForkText,
  renderHistoryText,
  renderKillText,
  renderTellText,
  renderWaitText,
  tellExitCode,
  waitedTellProgress,
} from "../render/akuma.js";
export {
  akumaUsageGuide,
  isAkumaAction,
  isParsedAkumaCommand,
  parseAkumaCommand,
  renderAkumaHelp,
  renderAkumaRootRows,
} from "./akuma-grammar.js";

// ---------------------------------------------------------------------------
// Leaf dispatch: acquisition, one public SDK invocation, direct rendering
// ---------------------------------------------------------------------------

async function settingsAt(root: WorldRoot | undefined, home?: string): Promise<Settings> {
  return settings({
    ...(root === undefined ? {} : { root }),
    ...(home === undefined ? {} : { home }),
  });
}

type InvokeInput = Readonly<{
  path: WorldRoot;
  executionCwd?: string;
  home?: string;
  settings?: Settings;
  contract?: KeiyakuContract;
  repo?: Repo;
  environment: NodeJS.ProcessEnv;
  readStdin: () => Promise<string>;
  execution: ExecutionContext;
  signal?: AbortSignal;
}>;

type CallRequest = Omit<CallInput, "mode" | "timeoutMs">;

function akumas(input: InvokeInput) {
  return akumasWithExecution(input.path, input.execution);
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

async function promptBody(
  action: "call" | "tell" | "ask",
  command: Readonly<{ prompt: AkumaPromptSource }>,
  input: InvokeInput,
): Promise<string> {
  if (command.prompt.kind !== "stdin") return command.prompt.value;
  const bytes = await input.readStdin();
  if (isBlankInput(bytes)) throw new CliUsageError(`${action} requires a nonblank prompt`);
  return bytes;
}

function waitObserver(
  stream: ReturnType<typeof waitObservationStream>,
  driver: ActivityDriver,
  onSelected?: (selected: readonly WaitSelectedIdentity[]) => void,
): import("../../library/akumas.js").WaitObserver {
  return {
    selected: (selected) => {
      onSelected?.(selected);
      stream.select(selected);
    },
    observe: (observed) => {
      driver.settle(stream.observe(observed), stream.frame());
    },
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
      reportDiagnostic: (message) => writeStderr(message),
    });
  } catch (error) {
    writeStderr(`! plugin initiation: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { initiator };
}

function emitResult(body: string, exact: boolean): void {
  if (exact) process.stdout.write(body);
  else writeStdout(body);
}

// eslint-disable-next-line complexity -- one call owns prompt/schema/placement plus live observation.
async function runCall(
  command: Extract<InvokedAkumaCommand, { command: "call" }>,
  input: InvokeInput,
): Promise<number> {
  const body = command.prompt === undefined ? undefined : await promptBody("call", { prompt: command.prompt }, input);
  const schema = command.schema === undefined ? undefined : await schemaFromFile(command.schema);
  const caller = akumas(input);
  const request: CallRequest = {
    ...(await inputInitiator(input)),
    archetype: command.archetype,
    ...(body === undefined ? {} : { body }),
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.settings === undefined ? {} : { settings: input.settings }),
    ...(input.executionCwd === undefined ? {} : { cwd: input.executionCwd }),
    ...(input.contract === undefined ? {} : { contract: input.contract }),
    ...(command.alias === undefined ? {} : { alias: command.alias }),
    ...(command.allowed === undefined ? {} : { allowed: command.allowed }),
    ...(schema === undefined ? {} : { schema }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  let stream: ReturnType<typeof callObservationStream> | undefined;
  const driver = new ActivityDriver(process.stderr);
  const observing = command.mode === "wait" && command.output === "text";
  const observe: CallRequest["observe"] = observing
    ? {
        admitted: (tell, id, head) => {
          stream = callObservationStream(resultContext(), callObservationHead({ akuma: id, ...head }), {
            admittedAt: tell.row.at,
          });
          driver.redraw(stream.frame());
        },
        observe: (observation) => {
          driver.settle(stream?.observe(observation) ?? [], stream?.frame() ?? []);
        },
      }
    : undefined;
  try {
    const result = await caller.call({
      ...request,
      mode: command.mode,
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      ...(observe === undefined ? {} : { observe }),
    });
    let streamed = stream !== undefined;
    if (stream !== undefined) {
      driver.conclude(stream.conclude(result.observation));
    } else if (observing && result.observation.kind === "failed") {
      const fallback = inputWaitStream(
        resultContext(),
        () =>
          callObservationHead({
            akuma: result.akuma,
            dispatch: result.dispatch,
            alias: result.alias,
          }),
        { cursor: "empty", answerSeparator: true },
      );
      writeStderr(fallback.conclude({ kind: "failed", diagnostic: result.observation.failure.diagnostic }));
      streamed = true;
    }
    if (command.output === "json") {
      writeJson(result);
      return callExitCode(result);
    }
    const raw = callRawAnswer(result, streamed);
    if (raw === undefined) emitResult(renderCallText(result, streamed, displayContext()), false);
    else emitResult(raw, true);
    return callExitCode(result);
  } finally {
    driver.close(stream?.flush() ?? []);
  }
}

async function runWait(
  command: Extract<InvokedAkumaCommand, { command: "wait" }>,
  input: InvokeInput,
): Promise<number> {
  const alias = command.akuma.length === 1 ? inputAlias(command.akuma[0]!) : undefined;
  const stream = command.output === "text" ? waitObservationStream(resultContext()) : undefined;
  const driver = new ActivityDriver(process.stderr);
  const startedAt = Date.now();
  let selection: readonly WaitSelectedIdentity[] | undefined;
  const observer =
    stream === undefined
      ? undefined
      : waitObserver(stream, driver, (selected) => {
          selection = selected;
        });
  try {
    const result = await akumas(input).wait({
      akuma: command.akuma,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(command.completion === undefined ? {} : { completion: command.completion }),
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(observer === undefined ? {} : { observe: observer }),
    });
    const streamed = stream !== undefined && stream.streamed();
    if (stream !== undefined && streamed) driver.conclude(stream.conclude(result));
    const presentation = {
      ...(alias === undefined ? {} : { alias }),
      ...(selection === undefined ? {} : { selection }),
      startedAt,
    };
    if (command.output === "json") {
      writeJson(result);
      return 0;
    }
    const raw = waitRawAnswer(result, streamed);
    if (raw === undefined) emitResult(renderWaitText(result, presentation, displayContext()), false);
    else emitResult(raw, true);
    return 0;
  } finally {
    driver.close(stream?.flush() ?? []);
  }
}

async function runTell(
  command: Extract<InvokedAkumaCommand, { command: "tell" }>,
  input: InvokeInput,
): Promise<number> {
  const body = await promptBody("tell", command, input);
  const result = await akumas(input).tell({
    ...(await inputInitiator(input)),
    akuma: command.akuma,
    body,
    ...(command.interrupt ? { interrupt: true } : {}),
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (command.output === "json") {
    writeJson(result);
    return tellExitCode(result);
  }
  emitResult(renderTellText(result, inputAlias(command.akuma), displayContext()), false);
  return tellExitCode(result);
}

async function runAsk(command: Extract<InvokedAkumaCommand, { command: "ask" }>, input: InvokeInput): Promise<number> {
  const body = await promptBody("ask", command, input);
  const schema = command.schema === undefined ? undefined : await schemaFromFile(command.schema);
  const alias = inputAlias(command.akuma);
  const channel = executionChannel(input.execution);
  const progress =
    command.output === "text" && channel.kind === "local"
      ? askProgressStream(undefined, alias, resultContext())
      : undefined;
  const driver = new ActivityDriver(process.stderr);
  try {
    const result = await akumas(input).ask({
      ...(await inputInitiator(input)),
      akuma: command.akuma,
      body,
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      ...(schema === undefined ? {} : { schema }),
      ...(command.interrupt ? { interrupt: true } : {}),
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(progress === undefined
        ? {}
        : {
            observe: {
              admitted: (tell, id) => {
                driver.settle(progress.admitted(tell, id), progress.frame());
              },
              observe: (observation) => {
                driver.settle(progress.observe(observation), progress.frame());
              },
            },
          }),
    });
    if (progress !== undefined) driver.conclude(progress.conclude(result).join("\n"));
    else if (command.output === "text" && channel.kind === "body-request")
      writeStderr(waitedTellProgress(result, alias, resultContext()));
    if (command.output === "json") {
      writeJson(result);
      return askExitCode(result);
    }
    emitResult(askRawAnswer(result, schema !== undefined) ?? "", true);
    return askExitCode(result);
  } finally {
    driver.close(progress?.flush() ?? []);
  }
}

async function runHistory(
  command: Extract<InvokedAkumaCommand, { command: "history" }>,
  input: InvokeInput,
): Promise<number> {
  const result = await akumas(input).history({
    akuma: command.akuma,
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(command.before === undefined ? {} : { before: command.before }),
    ...(command.since === undefined ? {} : { since: command.since }),
    ...(command.limit === undefined ? {} : { limit: command.limit }),
    ...(command.id === undefined ? {} : { id: command.id }),
    last: command.last,
  });
  if (command.output === "json") {
    writeJson(result);
    return historyExitCode(result, command.id);
  }
  const raw = historyRawAnswer(result, command.id);
  const presentation = {
    ...(inputAlias(command.akuma) === undefined ? {} : { alias: command.akuma }),
    ...(command.id === undefined ? {} : { id: command.id }),
    last: command.last,
  };
  if (raw !== undefined) emitResult(raw, true);
  else if (command.last && result.kind === "last") emitResult(result.answer, true);
  else emitResult(renderHistoryText(result, presentation, displayContext()), false);
  return historyExitCode(result, command.id);
}

async function runFork(
  command: Extract<InvokedAkumaCommand, { command: "fork" }>,
  input: InvokeInput,
): Promise<number> {
  const receipt = await akumas(input).fork({
    akuma: command.akuma,
    at: command.at,
    ...(input.repo === undefined ? {} : { repo: input.repo }),
  });
  if (command.output === "json") {
    writeJson(receipt);
    return forkExitCode(receipt);
  }
  emitResult(renderForkText(receipt), false);
  return forkExitCode(receipt);
}

async function runKill(
  command: Extract<InvokedAkumaCommand, { command: "kill" }>,
  input: InvokeInput,
): Promise<number> {
  const alias = command.akuma.length === 1 ? inputAlias(command.akuma[0]!) : undefined;
  const result = await akumas(input).kill({
    akuma: command.akuma,
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (command.output === "json") {
    writeJson(result);
    return killExitCode(result);
  }
  emitResult(renderKillText(result, alias, displayContext()), false);
  return killExitCode(result);
}

async function akumaWorld(command: InvokedAkumaCommand, coordinates: CliCoordinates): Promise<WorldRoot> {
  const world =
    command.command === "call"
      ? (coordinates.candidateWorld ?? (await coordinates.establishWorld()))
      : coordinates.world;
  if (world === null) throw new CliUsageError("no Keiyaku world contains the invocation cwd");
  return world;
}

async function callExecutionCwd(
  command: InvokedAkumaCommand,
  cwd: string,
  workdir: string | undefined,
): Promise<string | undefined> {
  if (command.command !== "call") return undefined;
  if (workdir !== undefined)
    return await canonicalBirthCwd(resolve(cwd, workdir), `workdir is not an existing directory: ${workdir}`);
  return cwd;
}

async function akumaInput(
  command: InvokedAkumaCommand,
  coordinates: CliCoordinates,
  workdir: string | undefined,
  runtime: CliRuntime,
): Promise<InvokeInput> {
  const path = await akumaWorld(command, coordinates);
  const executionCwd = await callExecutionCwd(command, coordinates.cwd, workdir);
  const execution = runtime.execution;
  const home = command.command === "call" ? runtime.home : undefined;
  const configuration = command.command === "call" ? await settingsAt(path, home) : undefined;
  if (command.command === "call" && command.contract !== undefined && coordinates.repo === undefined)
    throw new Error("call with Contract requires a resolved Repo");
  const contract =
    command.command === "call" && command.contract !== undefined
      ? contractFromInput(coordinates.repo!, command.contract, execution).contract
      : undefined;
  return {
    path,
    ...(executionCwd === undefined ? {} : { executionCwd }),
    ...(home === undefined ? {} : { home }),
    ...(configuration === undefined ? {} : { settings: configuration }),
    ...(contract === undefined ? {} : { contract }),
    ...(coordinates.repo === undefined ? {} : { repo: coordinates.repo }),
    environment: runtime.environment,
    readStdin: runtime.readStdin,
    execution,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  };
}

export async function runAkumaCommand(
  command: InvokedAkumaCommand,
  coordinates: CliCoordinates,
  workdir: string | undefined,
  runtime: CliRuntime,
): Promise<number> {
  try {
    const input = await akumaInput(command, coordinates, workdir, runtime);
    switch (command.command) {
      case "call":
        return await runCall(command, input);
      case "wait":
        return await runWait(command, input);
      case "tell":
        return await runTell(command, input);
      case "ask":
        return await runAsk(command, input);
      case "history":
        return await runHistory(command, input);
      case "fork":
        return await runFork(command, input);
      case "kill":
        return await runKill(command, input);
    }
  } catch (error) {
    if (error instanceof Error && "executionReceipt" in error) throw error;
    if (error instanceof AkumaWorldScopeError) throw error;
    if (error instanceof TypeError) throw new CliUsageError(error.message);
    throw error;
  }
}
