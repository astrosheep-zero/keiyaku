export { renderAkumaHelp } from "./akuma-grammar.js";
import type { AkumaPromptSource } from "./akuma-grammar.js";
import type { PendingRequest, VerbRequest } from "../parse.js";
import { CliUsageError, isBlankInput } from "../usage.js";
import { readFile } from "node:fs/promises";
import { canonicalDocument } from "../../akuma/schema.js";
import { classifyVerb, verbs } from "../../library/keiyaku-verbs.js";
import type { AskProgress } from "../../akuma/akuma-selection-execution.js";
import type { SpawnProgress } from "../../library/akuma-creation.js";
import { ActivityDriver } from "../activity.js";
import { type CliOutcome, displayContext, resultContext, writeJson, writeStderr, writeStdout } from "../streams.js";
import type { CliRuntime } from "../runtime.js";
import { askRawAnswer, callObservationStream, callRawAnswer, historyRawAnswer } from "../render/akuma-activity.js";
import { askProgressStream, callObservationHead, renderFailedCallObservation } from "../render/akuma.js";
import { renderVerb } from "../render/verbs.js";

async function schemaFromFile(path: string) {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return canonicalDocument(parsed).json;
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
  prompt: AkumaPromptSource,
  runtime: CliRuntime,
): Promise<string> {
  if (prompt.kind !== "stdin") return prompt.value;
  const bytes = await runtime.readStdin();
  if (isBlankInput(bytes)) throw new CliUsageError(`${action} requires a nonblank prompt`);
  return bytes;
}

export async function acquireAkumaRequest(
  request: Extract<PendingRequest, { name: "spawn" | "tell" | "ask" }>,
  workdir: string | undefined,
  runtime: CliRuntime,
): Promise<VerbRequest<"spawn" | "tell" | "ask">> {
  const prompt =
    request.acquire.prompt === undefined ? undefined : await promptBody(request.name, request.acquire.prompt, runtime);
  if (request.name === "tell")
    return { name: "tell", input: { ...request.input, prompt: prompt! }, output: request.output };
  if (request.name === "ask")
    return {
      name: "ask",
      input: { ...request.input, schema: await schemaFromFile(request.acquire.schema), prompt: prompt! },
      output: request.output,
    };
  const parsed = verbs.spawn.input.safeParse({
    ...request.input,
    ...(prompt === undefined ? {} : { prompt }),
    ...(workdir === undefined ? {} : { workdir }),
  });
  if (!parsed.success) throw new CliUsageError(parsed.error.message);
  return { name: "spawn", input: parsed.data, output: request.output };
}

function emitAnswer(body: string, exact: boolean): void {
  if (exact) process.stdout.write(body);
  else writeStdout(body);
}

export async function runSpawn(request: VerbRequest<"spawn">, runtime: CliRuntime): Promise<CliOutcome> {
  const { input, output } = request;
  let stream: ReturnType<typeof callObservationStream> | undefined;
  const driver = new ActivityDriver(process.stderr);
  const observing = input.wait !== undefined && output === "text";
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
    const result = await runtime.facet.run("spawn", input, {
      signal: runtime.signal,
      ...(observe === undefined ? {} : { observe }),
    });
    let streamed = stream !== undefined;
    if (stream !== undefined) driver.conclude(stream.conclude(result));
    else if (observing && result.kind === "failed") {
      writeStderr(
        renderFailedCallObservation(
          result,
          resultContext(),
          input.prompt === undefined ? {} : { prompt: input.prompt },
        ),
      );
      streamed = true;
    }
    const completion = { kind: "returned" as const, value: result };
    if (output === "json") writeJson(result);
    else if (streamed) {
      const raw = callRawAnswer(result, true);
      emitAnswer(raw ?? "", raw !== undefined);
    } else {
      const raw = callRawAnswer(result, false);
      emitAnswer(renderVerb("spawn", input, completion, displayContext()), raw !== undefined);
    }
    return classifyVerb("spawn", input, completion);
  } finally {
    driver.close(stream?.flush() ?? []);
  }
}

export async function runAsk(request: VerbRequest<"ask" | "tell">, runtime: CliRuntime): Promise<CliOutcome> {
  const { input, output } = request;
  const progress =
    output === "text" ? askProgressStream(undefined, inputAlias(input.akuma), resultContext()) : undefined;
  const driver = new ActivityDriver(process.stderr);
  const observe =
    progress === undefined
      ? undefined
      : (event: AskProgress): void => {
          if (event.kind === "admitted") driver.settle(progress.admitted(event.tell, event.id), progress.frame());
          else driver.settle(progress.observe(event.observation), progress.frame());
        };
  try {
    const run = {
      signal: runtime.signal,
      ...(observe === undefined ? {} : { observe }),
    };
    const result =
      request.name === "ask"
        ? await runtime.facet.run("ask", request.input, run)
        : await runtime.facet.run("tell", request.input, run);
    if (progress !== undefined) driver.conclude(progress.conclude(result).join("\n"));
    const completion = { kind: "returned" as const, value: result };
    if (output === "json") writeJson(result);
    else emitAnswer(askRawAnswer(result) ?? "", true);
    return classifyVerb(request.name, input, completion);
  } finally {
    driver.close(progress?.flush() ?? []);
  }
}

export async function runAkumaHistory(request: VerbRequest<"history">, runtime: CliRuntime): Promise<CliOutcome> {
  const { input, output } = request;
  const result = await runtime.facet.run("history", input, { signal: runtime.signal });
  if (result.kind === "contract" || result.kind === "contract-missing")
    throw new Error("Akuma history returned a non-Akuma result");
  const completion = { kind: "returned" as const, value: result };
  if (output === "json") writeJson(result);
  else {
    const raw =
      historyRawAnswer(result, "id" in input ? input.id : undefined) !== undefined ||
      ("last" in input && input.last === true && result.kind === "akuma-last");
    emitAnswer(renderVerb("history", input, completion, displayContext()), raw);
  }
  return classifyVerb("history", input, completion);
}
