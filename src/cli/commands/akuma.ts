import type { AkumaPromptSource, InvokedAkumaCommand } from "./akuma-grammar.js";
import { CliUsageError, isBlankInput } from "../usage.js";
import { readFile } from "node:fs/promises";
import { Schema, type JsonSchemaDocument } from "../../akuma/index.js";
import { classifyVerb } from "../../library/keiyaku-verbs.js";
import type { AskProgress } from "../../akuma/akuma-selection-execution.js";
import type { SpawnProgress } from "../../library/akuma-creation.js";
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
import { askRawAnswer, callObservationStream, callRawAnswer, historyRawAnswer } from "../render/akuma-activity.js";
import { askProgressStream, callObservationHead, renderFailedCallObservation } from "../render/akuma.js";
import { renderVerb } from "../render/verbs.js";
export { isParsedAkumaCommand, renderAkumaHelp } from "./akuma-grammar.js";

type InvokeInput = Readonly<{ workdir?: string; runtime: CliRuntime }>;

async function schemaFromFile(path: string): Promise<Schema<unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return Schema.json(parsed as JsonSchemaDocument, (value) => value);
  } catch (error) {
    throw new CliUsageError(
      `cannot read JSON Schema file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
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

function spawnWire(
  command: Extract<InvokedAkumaCommand, { command: "spawn" }>,
  input: InvokeInput,
  body: string | undefined,
  schema: Schema<unknown> | undefined,
) {
  return {
    akumaName: command.akumaName,
    ...(body === undefined ? {} : { prompt: body }),
    ...(command.contract === undefined ? {} : { contract: command.contract }),
    ...(input.workdir === undefined ? {} : { workdir: input.workdir }),
    ...(command.alias === undefined ? {} : { alias: command.alias }),
    ...(command.writableDirectories === undefined ? {} : { writableDirectories: command.writableDirectories }),
    ...(command.bare === undefined ? {} : { bare: command.bare }),
    ...(schema === undefined ? {} : { schema: schema.jsonSchema }),
    mode: command.mode,
    ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
  };
}

async function runSpawn(
  command: Extract<InvokedAkumaCommand, { command: "spawn" }>,
  input: InvokeInput,
): Promise<CliOutcome> {
  const body = command.prompt === undefined ? undefined : await promptBody("spawn", { prompt: command.prompt }, input);
  const schema = command.schema === undefined ? undefined : await schemaFromFile(command.schema);
  const wire = spawnWire(command, input, body, schema);
  let stream: ReturnType<typeof callObservationStream> | undefined;
  const driver = new ActivityDriver(process.stderr);
  const observing = command.mode === "wait" && command.output === "text";
  const observe = observing
    ? (event: SpawnProgress): void => {
        if (event.kind === "admitted") {
          stream = callObservationStream(resultContext(), callObservationHead({ akumaId: event.id, ...event.head }), {
            admittedAt: event.tell.row.at,
          });
          driver.redraw(stream.frame());
        } else {
          driver.settle(stream?.observe(event.observation) ?? [], stream?.frame() ?? []);
        }
      }
    : undefined;
  try {
    const result = await input.runtime.facet.run("spawn", wire, {
      signal: input.runtime.signal,
      ...(observe === undefined ? {} : { observe }),
      ...(schema === undefined ? {} : { decode: schema.decode }),
    });
    let streamed = stream !== undefined;
    if (stream !== undefined) driver.conclude(stream.conclude(result));
    else if (observing && result.failure !== undefined) {
      writeStderr(renderFailedCallObservation(result, resultContext(), body === undefined ? {} : { prompt: body }));
      streamed = true;
    }
    const completion = { kind: "returned" as const, value: result };
    if (command.output === "json") writeJson(result);
    else if (streamed)
      emitAnswer(
        callRawAnswer(result, schema !== undefined, true) ?? "",
        callRawAnswer(result, schema !== undefined, true) !== undefined,
      );
    else {
      const raw = callRawAnswer(result, schema !== undefined, false);
      emitAnswer(renderVerb("spawn", wire, completion, displayContext()), raw !== undefined);
    }
    return classifyVerb("spawn", wire, completion);
  } finally {
    driver.close(stream?.flush() ?? []);
  }
}

async function runWait(
  command: Extract<InvokedAkumaCommand, { command: "wait" }>,
  input: InvokeInput,
): Promise<CliOutcome> {
  const wire = {
    selectors: command.akuma,
    ...(command.completion === undefined ? {} : { completion: command.completion }),
    ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
  };
  const result = await input.runtime.facet.run("wait", wire, { signal: input.runtime.signal });
  const completion = { kind: "returned" as const, value: result };
  return emit(
    command.output,
    result,
    () => renderVerb("wait", wire, completion, displayContext()),
    classifyVerb("wait", wire, completion),
  );
}

async function runTell(
  command: Extract<InvokedAkumaCommand, { command: "tell" }>,
  input: InvokeInput,
): Promise<CliOutcome> {
  const wire = {
    akuma: command.akuma,
    prompt: await promptBody("tell", command, input),
    ...(command.interrupt ? { interrupt: true } : {}),
  };
  const result = await input.runtime.facet.run("tell", wire, { signal: input.runtime.signal });
  const completion = { kind: "returned" as const, value: result };
  return emit(
    command.output,
    result,
    () => renderVerb("tell", wire, completion, displayContext()),
    classifyVerb("tell", wire, completion),
  );
}

async function runAsk(
  command: Extract<InvokedAkumaCommand, { command: "ask" }>,
  input: InvokeInput,
): Promise<CliOutcome> {
  const body = await promptBody("ask", command, input);
  const schema = command.schema === undefined ? undefined : await schemaFromFile(command.schema);
  const wire = {
    akuma: command.akuma,
    prompt: body,
    ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    ...(schema === undefined ? {} : { schema: schema.jsonSchema }),
    ...(command.interrupt ? { interrupt: true } : {}),
  };
  const progress =
    command.output === "text" ? askProgressStream(undefined, inputAlias(command.akuma), resultContext()) : undefined;
  const driver = new ActivityDriver(process.stderr);
  const observe =
    progress === undefined
      ? undefined
      : (event: AskProgress): void => {
          if (event.kind === "admitted") driver.settle(progress.admitted(event.tell, event.id), progress.frame());
          else driver.settle(progress.observe(event.observation), progress.frame());
        };
  try {
    const result = await input.runtime.facet.run("ask", wire, {
      signal: input.runtime.signal,
      ...(observe === undefined ? {} : { observe }),
      ...(schema === undefined ? {} : { decode: schema.decode }),
    });
    if (progress !== undefined) driver.conclude(progress.conclude(result).join("\n"));
    const completion = { kind: "returned" as const, value: result };
    if (command.output === "json") writeJson(result);
    else emitAnswer(askRawAnswer(result, schema !== undefined) ?? "", true);
    return classifyVerb("ask", wire, completion);
  } finally {
    driver.close(progress?.flush() ?? []);
  }
}

async function runHistory(
  command: Extract<InvokedAkumaCommand, { command: "history" }>,
  input: InvokeInput,
): Promise<CliOutcome> {
  const wire = {
    selector: command.akuma,
    ...(command.before === undefined ? {} : { before: command.before }),
    ...(command.since === undefined ? {} : { since: command.since }),
    ...(command.limit === undefined ? {} : { limit: command.limit }),
    ...(command.id === undefined ? {} : { id: command.id }),
    last: command.last,
  };
  const result = await input.runtime.facet.run("history", wire, { signal: input.runtime.signal });
  if (result.kind === "contract" || result.kind === "contract-missing")
    throw new Error("Akuma history returned a non-Akuma result");
  const completion = { kind: "returned" as const, value: result };
  if (command.output === "json") writeJson(result);
  else {
    const raw = historyRawAnswer(result, command.id) !== undefined || (command.last && result.kind === "akuma-last");
    emitAnswer(renderVerb("history", wire, completion, displayContext()), raw);
  }
  return classifyVerb("history", wire, completion);
}

async function runFork(
  command: Extract<InvokedAkumaCommand, { command: "fork" }>,
  input: InvokeInput,
): Promise<CliOutcome> {
  const wire = { akuma: command.akuma, at: command.at, ...(command.bare === undefined ? {} : { bare: command.bare }) };
  const result = await input.runtime.facet.run("fork", wire, { signal: input.runtime.signal });
  const completion = { kind: "returned" as const, value: result };
  return emit(
    command.output,
    result,
    () => renderVerb("fork", wire, completion, displayContext()),
    classifyVerb("fork", wire, completion),
  );
}

async function runKill(
  command: Extract<InvokedAkumaCommand, { command: "kill" }>,
  input: InvokeInput,
): Promise<CliOutcome> {
  const wire = { akuma: command.akuma };
  const result = await input.runtime.facet.run("kill", wire, { signal: input.runtime.signal });
  const completion = { kind: "returned" as const, value: result };
  return emit(
    command.output,
    result,
    () => renderVerb("kill", wire, completion, displayContext()),
    classifyVerb("kill", wire, completion),
  );
}

export async function runAkumaCommand(
  command: InvokedAkumaCommand,
  workdir: string | undefined,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const input: InvokeInput = { ...(workdir === undefined ? {} : { workdir }), runtime };
  switch (command.command) {
    case "spawn":
      return runSpawn(command, input);
    case "wait":
      return runWait(command, input);
    case "tell":
      return runTell(command, input);
    case "ask":
      return runAsk(command, input);
    case "history":
      return runHistory(command, input);
    case "fork":
      return runFork(command, input);
    case "kill":
      return runKill(command, input);
  }
}
