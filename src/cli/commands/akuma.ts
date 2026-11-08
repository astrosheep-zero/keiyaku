import { akumaCallerFromEnvironment } from "../akuma-caller.js";
import type { AkumaPromptSource, InvokedAkumaCommand } from "./akuma-grammar.js";
import { CliUsageError, isBlankInput } from "../usage.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deliveryOwner } from "../delivery-identity.js";
import { canonicalBirthCwd } from "../../akuma/call-input.js";
import { Schema, type JsonSchemaDocument } from "../../akuma/index.js";
import { settings, type Settings } from "../../settings.js";
import { Akumas, AkumaWorldScopeError, type Kei as KeiyakuContract, type Repo, type SpawnInput } from "../../index.js";
import { Keis } from "../../index.js";
import type { CliCoordinates } from "../coordinates.js";
import { World, type WorldRoot } from "../../world.js";
import { contractFromInput } from "../selectors.js";
import { ActivityDriver } from "../activity.js";
import {
  type CliOutcome,
  displayContext,
  emit,
  resultContext,
  writeJson,
  writeStderr,
  writeStdout,
} from "../streams.js";
import type { CliRuntime } from "../runtime.js";
import { callObservationStream } from "../render/akuma-activity.js";
import { contractWaitText } from "../render/contract-wait.js";
import {
  askRawAnswer,
  callRawAnswer,
  historyRawAnswer,
  historyText,
  tellText,
  waitText,
} from "../render/akuma-activity.js";
import {
  askOutcome,
  askProgressStream,
  callOutcome,
  callObservationHead,
  forkOutcome,
  historyOutcome,
  killOutcome,
  renderCallText,
  renderFailedCallObservation,
  renderForkText,
  renderKillText,
  tellOutcome,
} from "../render/akuma.js";
export { isParsedAkumaCommand, renderAkumaHelp } from "./akuma-grammar.js";

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
  writableDirectories?: readonly string[];
  home?: string;
  settings?: Settings;
  contract?: KeiyakuContract;
  repo?: Repo;
  environment: NodeJS.ProcessEnv;
  readStdin: () => Promise<string>;
  signal?: AbortSignal;
}>;

type SpawnRequest = Omit<SpawnInput, "mode" | "timeoutMs">;

function akumas(input: InvokeInput) {
  return Akumas.of(input.path, { reportDiagnostic: writeStderr });
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
  action: "spawn" | "tell" | "ask",
  command: Readonly<{ prompt: AkumaPromptSource }>,
  input: InvokeInput,
): Promise<string> {
  if (command.prompt.kind !== "stdin") return command.prompt.value;
  const bytes = await input.readStdin();
  if (isBlankInput(bytes)) throw new CliUsageError(`${action} requires a nonblank prompt`);
  return bytes;
}

function inputInitiator(input: InvokeInput): Readonly<{ initiator?: string }> {
  const initiator = deliveryOwner(input.environment);
  return initiator === undefined ? {} : { initiator };
}

function emitAnswer(body: string, exact: boolean): void {
  if (exact) process.stdout.write(body);
  else writeStdout(body);
}

// eslint-disable-next-line complexity -- one spawn owns prompt/schema/placement plus live observation.
async function runSpawn(
  command: Extract<InvokedAkumaCommand, { command: "spawn" }>,
  input: InvokeInput,
): Promise<CliOutcome> {
  const body = command.prompt === undefined ? undefined : await promptBody("spawn", { prompt: command.prompt }, input);
  const schema = command.schema === undefined ? undefined : await schemaFromFile(command.schema);
  const declaredCaller = await akumaCallerFromEnvironment(input.environment);
  await World.at(input.path);
  const caller = akumas(input);
  const request: SpawnRequest = {
    ...(await inputInitiator(input)),
    ...(declaredCaller === undefined ? {} : { caller: declaredCaller }),
    akumaName: command.akumaName,
    ...(body === undefined ? {} : { body }),
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.settings === undefined ? {} : { settings: input.settings }),
    ...(input.executionCwd === undefined ? {} : { cwd: input.executionCwd }),
    ...(input.contract === undefined ? {} : { contract: input.contract }),
    ...(command.alias === undefined ? {} : { alias: command.alias }),
    ...(input.writableDirectories === undefined ? {} : { writableDirectories: input.writableDirectories }),
    ...(command.bare === undefined ? {} : { bare: command.bare }),
    ...(schema === undefined ? {} : { schema }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  let stream: ReturnType<typeof callObservationStream> | undefined;
  const driver = new ActivityDriver(process.stderr);
  const observing = command.mode === "wait" && command.output === "text";
  const observe: SpawnRequest["observe"] = observing
    ? {
        admitted: (tell, id, head) => {
          stream = callObservationStream(
            resultContext(),
            callObservationHead({
              akuma: id,
              ...head,
              ...(input.executionCwd === undefined ? {} : { cwd: input.executionCwd }),
            }),
            { admittedAt: tell.row.at },
          );
          driver.redraw(stream.frame());
        },
        observe: (observation) => {
          driver.settle(stream?.observe(observation) ?? [], stream?.frame() ?? []);
        },
      }
    : undefined;
  try {
    const result = await caller.spawn({
      ...request,
      mode: command.mode,
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      ...(observe === undefined ? {} : { observe }),
    });
    let streamed = stream !== undefined;
    if (stream !== undefined) {
      driver.conclude(stream.conclude(result.observation));
    } else if (observing && result.observation.kind === "failed") {
      writeStderr(renderFailedCallObservation(result, resultContext()));
      streamed = true;
    }
    if (command.output === "json") writeJson(result);
    else {
      const raw = callRawAnswer(result, streamed);
      if (raw === undefined) emitAnswer(renderCallText(result, streamed, displayContext()), false);
      else emitAnswer(raw, true);
    }
    return callOutcome(result);
  } finally {
    driver.close(stream?.flush() ?? []);
  }
}

async function runWait(
  command: Extract<InvokedAkumaCommand, { command: "wait" }>,
  input: InvokeInput,
): Promise<CliOutcome> {
  const alias = command.akuma.length === 1 ? inputAlias(command.akuma[0]!) : undefined;
  const result = await akumas(input).wait({
    akuma: command.akuma,
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(command.completion === undefined ? {} : { completion: command.completion }),
    ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const outcome = result.unobserved.length === 0 ? "accepted" : "failed";
  if (command.output === "json") writeJson(result);
  else emitAnswer(waitText(result, { ...(alias === undefined ? {} : { alias }) }, displayContext()), false);
  return outcome;
}

async function runTell(
  command: Extract<InvokedAkumaCommand, { command: "tell" }>,
  input: InvokeInput,
): Promise<CliOutcome> {
  const body = await promptBody("tell", command, input);
  const result = await akumas(input).tell({
    ...(await inputInitiator(input)),
    akuma: command.akuma,
    body,
    ...(command.interrupt ? { interrupt: true } : {}),
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const text = () => tellText(result, inputAlias(command.akuma), displayContext());
  return emit(command.output, result, text, tellOutcome(result));
}

async function runAsk(
  command: Extract<InvokedAkumaCommand, { command: "ask" }>,
  input: InvokeInput,
): Promise<CliOutcome> {
  const body = await promptBody("ask", command, input);
  const schema = command.schema === undefined ? undefined : await schemaFromFile(command.schema);
  const alias = inputAlias(command.akuma);
  const progress = command.output === "text" ? askProgressStream(undefined, alias, resultContext()) : undefined;
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
    if (command.output === "json") writeJson(result);
    else emitAnswer(askRawAnswer(result, schema !== undefined) ?? "", true);
    return askOutcome(result);
  } finally {
    driver.close(progress?.flush() ?? []);
  }
}

async function runHistory(
  command: Extract<InvokedAkumaCommand, { command: "history" }>,
  input: InvokeInput,
): Promise<CliOutcome> {
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
    return historyOutcome(result, command.id);
  }
  const raw = historyRawAnswer(result, command.id);
  const presentation = {
    ...(inputAlias(command.akuma) === undefined ? {} : { alias: command.akuma }),
    ...(command.id === undefined ? {} : { id: command.id }),
    last: command.last,
  };
  if (raw !== undefined) emitAnswer(raw, true);
  else if (command.last && result.kind === "last") emitAnswer(result.answer, true);
  else emitAnswer(historyText(result, presentation, displayContext()), false);
  return historyOutcome(result, command.id);
}

async function runFork(
  command: Extract<InvokedAkumaCommand, { command: "fork" }>,
  input: InvokeInput,
): Promise<CliOutcome> {
  const caller = await akumaCallerFromEnvironment(input.environment);
  const receipt = await akumas(input).fork({
    ...(await inputInitiator(input)),
    ...(caller === undefined ? {} : { caller }),
    akuma: command.akuma,
    at: command.at,
    ...(command.bare === undefined ? {} : { bare: command.bare }),
    ...(input.repo === undefined ? {} : { repo: input.repo }),
  });
  return emit(command.output, receipt, () => renderForkText(receipt), forkOutcome(receipt));
}

async function runKill(
  command: Extract<InvokedAkumaCommand, { command: "kill" }>,
  input: InvokeInput,
): Promise<CliOutcome> {
  const alias = command.akuma.length === 1 ? inputAlias(command.akuma[0]!) : undefined;
  const result = await akumas(input).kill({
    akuma: command.akuma,
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const text = () => renderKillText(result, alias, displayContext());
  return emit(command.output, result, text, killOutcome(result));
}

async function akumaWorld(command: InvokedAkumaCommand, coordinates: CliCoordinates): Promise<WorldRoot> {
  const world =
    command.command === "spawn"
      ? (coordinates.candidateWorld ?? (await coordinates.establishWorld()))
      : coordinates.world;
  if (world === null) throw new CliUsageError("no Keiyaku world contains the invocation cwd");
  return world;
}

async function spawnExecutionCwd(
  command: InvokedAkumaCommand,
  cwd: string,
  workdir: string | undefined,
): Promise<string | undefined> {
  if (command.command !== "spawn") return undefined;
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
  const executionCwd = await spawnExecutionCwd(command, coordinates.cwd, workdir);
  const writableDirectories =
    command.command !== "spawn" || command.writableDirectories === undefined
      ? undefined
      : await Promise.all(
          command.writableDirectories.map((path) => {
            if (path.trim() === "") throw new TypeError("--add-dir requires a nonblank directory");
            return canonicalBirthCwd(resolve(coordinates.cwd, path));
          }),
        );
  const home = command.command === "spawn" ? runtime.home : undefined;
  const configuration = command.command === "spawn" ? await settingsAt(path, home) : undefined;
  if (command.command === "spawn" && command.contract !== undefined && coordinates.repo === undefined)
    throw new Error("spawn with Contract requires a resolved Repo");
  const contract =
    command.command === "spawn" && command.contract !== undefined
      ? contractFromInput(Keis.of(coordinates.repo!), command.contract).contract
      : undefined;
  return {
    path,
    ...(executionCwd === undefined ? {} : { executionCwd }),
    ...(writableDirectories === undefined ? {} : { writableDirectories }),
    ...(home === undefined ? {} : { home }),
    ...(configuration === undefined ? {} : { settings: configuration }),
    ...(contract === undefined ? {} : { contract }),
    ...(coordinates.repo === undefined ? {} : { repo: coordinates.repo }),
    environment: runtime.environment,
    readStdin: runtime.readStdin,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  };
}

export async function runAkumaCommand(
  command: InvokedAkumaCommand,
  coordinates: CliCoordinates,
  workdir: string | undefined,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  try {
    if (command.command === "wait") {
      const contracts = command.akuma.filter((selector) => selector.startsWith("kei/"));
      if (contracts.length > 0) {
        if (coordinates.repo === undefined) throw new CliUsageError("Contract wait requires a repository");
        const result = await Keis.of(coordinates.repo).wait({
          contracts,
          ...(command.completion === undefined ? {} : { completion: command.completion }),
          ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
          ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
        });
        if (command.output === "json") writeJson(result);
        else writeStdout(contractWaitText(result));
        return result.kind === "missing" ? "refused" : "accepted";
      }
    }
    const input = await akumaInput(command, coordinates, workdir, runtime);
    switch (command.command) {
      case "spawn":
        return await runSpawn(command, input);
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
