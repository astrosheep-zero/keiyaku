import type { AkumaPromptSource, InvokedAkumaCommand } from "./akuma-grammar.js";
import { CliUsageError, isBlankInput } from "../usage.js";
import { readFile } from "node:fs/promises";
import { Schema, type JsonSchemaDocument } from "../../akuma/index.js";
import { AkumaWorldScopeError, KeiyakuUsageError, type AkumaAskInput } from "../../index.js";
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

type InvokeInput = Readonly<{
  workdir?: string;
  runtime: CliRuntime;
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

async function promptBody(
  action: "spawn" | "tell" | "ask",
  command: Readonly<{ prompt: AkumaPromptSource }>,
  input: InvokeInput,
): Promise<string> {
  if (command.prompt.kind !== "stdin") return command.prompt.value;
  const bytes = await input.runtime.readStdin();
  if (isBlankInput(bytes)) throw new CliUsageError(`${action} requires a nonblank prompt`);
  return bytes;
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

  let stream: ReturnType<typeof callObservationStream> | undefined;
  const driver = new ActivityDriver(process.stderr);
  const observing = command.mode === "wait" && command.output === "text";
  const observe: Parameters<typeof input.runtime.facet.spawn>[0]["observe"] = observing
    ? {
        admitted: (tell, id, head) => {
          stream = callObservationStream(
            resultContext(),
            callObservationHead({
              akuma: id,
              ...head,
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
    const result = await input.runtime.facet.spawn({
      akumaName: command.akumaName,
      ...(body === undefined ? {} : { prompt: body }),
      ...(command.contract === undefined ? {} : { contract: command.contract }),
      ...(input.workdir === undefined ? {} : { workdir: input.workdir }),
      ...(command.alias === undefined ? {} : { alias: command.alias }),
      ...(command.writableDirectories === undefined ? {} : { writableDirectories: command.writableDirectories }),
      ...(command.bare === undefined ? {} : { bare: command.bare }),
      ...(schema === undefined ? {} : { schema }),
      signal: input.runtime.signal,
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
  const result = await input.runtime.facet.wait({
    selectors: command.akuma,
    ...(command.completion === undefined ? {} : { completion: command.completion }),
    ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    signal: input.runtime.signal,
  });
  if ("contracts" in result) {
    if (command.output === "json") writeJson(result);
    else writeStdout(contractWaitText(result));
    return result.kind === "missing" ? "refused" : "accepted";
  }
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
  const result = await input.runtime.facet.tell({
    akuma: command.akuma,
    prompt: body,
    ...(command.interrupt ? { interrupt: true } : {}),
    signal: input.runtime.signal,
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
  const observe: AkumaAskInput<unknown>["observe"] =
    progress === undefined
      ? undefined
      : {
          admitted: (tell, id) => {
            driver.settle(progress.admitted(tell, id), progress.frame());
          },
          observe: (observation) => {
            driver.settle(progress.observe(observation), progress.frame());
          },
        };
  try {
    const result = await input.runtime.facet.ask({
      akuma: command.akuma,
      prompt: body,
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      ...(schema === undefined ? {} : { schema }),
      ...(command.interrupt ? { interrupt: true } : {}),
      signal: input.runtime.signal,
      ...(observe === undefined ? {} : { observe }),
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
  const result = await input.runtime.facet.history({
    selector: command.akuma,
    ...(command.before === undefined ? {} : { before: command.before }),
    ...(command.since === undefined ? {} : { since: command.since }),
    ...(command.limit === undefined ? {} : { limit: command.limit }),
    ...(command.id === undefined ? {} : { id: command.id }),
    last: command.last,
  });
  if (result === null || !("kind" in result)) throw new Error("Akuma history returned a non-Akuma result");
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
  const receipt = await input.runtime.facet.fork({
    akuma: command.akuma,
    at: command.at,
    ...(command.bare === undefined ? {} : { bare: command.bare }),
  });
  return emit(command.output, receipt, () => renderForkText(receipt), forkOutcome(receipt));
}

async function runKill(
  command: Extract<InvokedAkumaCommand, { command: "kill" }>,
  input: InvokeInput,
): Promise<CliOutcome> {
  const alias = command.akuma.length === 1 ? inputAlias(command.akuma[0]!) : undefined;
  const result = await input.runtime.facet.kill({
    akuma: command.akuma,
    signal: input.runtime.signal,
  });
  const text = () => renderKillText(result, alias, displayContext());
  return emit(command.output, result, text, killOutcome(result));
}

export async function runAkumaCommand(
  command: InvokedAkumaCommand,
  workdir: string | undefined,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  try {
    const input: InvokeInput = { ...(workdir === undefined ? {} : { workdir }), runtime };
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
    if (error instanceof AkumaWorldScopeError || error instanceof KeiyakuUsageError) throw error;
    if (error instanceof TypeError) throw new CliUsageError(error.message);
    throw error;
  }
}
