export { renderAkumaHelp } from "./akuma-grammar.js";
import type { AkumaPromptSource } from "./akuma-grammar.js";
import type { PendingRequest, VerbRequest } from "../parse.js";
import { CliUsageError, isBlankInput } from "../usage.js";
import { readFile } from "node:fs/promises";
import { canonicalDocument } from "../../akuma/schema.js";
import { classifyVerb, verbs } from "../../library/keiyaku-verbs.js";
import type { AskProgress } from "../../akuma/akuma-selection-execution.js";
import { StatusLine } from "../render/status-line.js";
import type { AkumaId } from "../../akuma/identity.js";
import { type CliOutcome, displayContext, writeCliStream, writeJson, writeStdout } from "../streams.js";
import type { CliRuntime } from "../runtime.js";
import { askRawAnswer } from "../render/akuma-activity.js";
import { askFrame, askResultText } from "../render/akuma.js";
import { aliasSelector, renderVerb } from "../render/verbs.js";

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

export async function runAsk(request: VerbRequest<"ask">, runtime: CliRuntime): Promise<CliOutcome> {
  const { input, output } = request;
  const stderr = process.stderr;
  const stdout = process.stdout;
  const alias = aliasSelector(input.akuma);
  const status = output === "text" ? new StatusLine(stderr) : undefined;
  let admittedId: AkumaId | undefined;
  const observe =
    status === undefined
      ? undefined
      : (event: AskProgress): void => {
          if (event.kind === "admitted") admittedId = event.id;
          const id = admittedId;
          if (id === undefined) return;
          const observed = event.kind === "live" ? event.observation.status : undefined;
          status.show((elapsed) => askFrame(elapsed, id, alias, observed));
        };
  try {
    const run = {
      signal: runtime.signal,
      ...(observe === undefined ? {} : { observe }),
    };
    const result = await runtime.facet.run("ask", request.input, run);
    status?.finish();
    const completion = { kind: "returned" as const, value: result };
    if (output === "json") writeJson(result);
    else {
      writeCliStream(stderr, askResultText(result, alias));
      const answer = askRawAnswer(result);
      if (answer !== undefined) stdout.write(answer);
    }
    return classifyVerb(request.name, input, completion);
  } finally {
    status?.finish();
  }
}

export async function runAkumaHistory(request: VerbRequest<"history">, runtime: CliRuntime): Promise<CliOutcome> {
  const { input, output } = request;
  const result = await runtime.facet.run("history", input, { signal: runtime.signal });
  if (
    result.kind === "contract" ||
    result.kind === "contract-exact" ||
    result.kind === "contract-unknown-history" ||
    result.kind === "contract-missing"
  )
    throw new Error("Akuma history returned a non-Akuma result");
  const completion = { kind: "returned" as const, value: result };
  if (output === "json") writeJson(result);
  else {
    const raw =
      result.kind === "akuma-activity" ||
      result.kind === "akuma-report" ||
      result.kind === "akuma-exact" ||
      result.kind === "akuma-answer";
    emitAnswer(renderVerb("history", input, completion, displayContext()), raw);
  }
  return classifyVerb("history", input, completion);
}
