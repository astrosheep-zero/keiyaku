import { Akuma } from "../../index.js";
import { akumaCallerFromEnvironment } from "../akuma-caller.js";
import type { CliRuntime } from "../runtime.js";
import { emit, writeStderr, type CliOutcome } from "../streams.js";
import { CliUsageError } from "../usage.js";
import type { ParsedAkumaCommand } from "./akuma-grammar.js";

function executionSequence(environment: NodeJS.ProcessEnv, key: string): number {
  const value = environment[key];
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value)))
    throw new CliUsageError(`report requires an explicit positive execution coordinate: ${key}`);
  return Number(value);
}

export async function runReport(
  command: Extract<ParsedAkumaCommand, { command: "report" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const text = command.prompt.kind === "stdin" ? await runtime.readStdin() : command.prompt.value;
  if (text.trim() === "") throw new CliUsageError("report requires nonblank text");
  const environment = runtime.environment;
  if (environment.KEIYAKU_ACTOR_ID === undefined || environment.KEIYAKU_ACTOR_WORLD === undefined)
    throw new CliUsageError("report requires explicit KEIYAKU_ACTOR_ID and KEIYAKU_ACTOR_WORLD");
  const bodySequence = executionSequence(environment, "KEIYAKU_BODY_SEQUENCE");
  const turnSequence = executionSequence(environment, "KEIYAKU_TURN_SEQUENCE");
  const caller = await akumaCallerFromEnvironment(environment);
  if (caller?.kind !== "akuma") throw new CliUsageError("report requires explicit Akuma identity");
  const result = await Akuma.select(caller.world, caller.akuId, { reportDiagnostic: writeStderr }).report(text, {
    bodySequence,
    turnSequence,
    signal: runtime.signal,
  });
  return emit(
    command.output,
    result,
    () =>
      result.kind === "recorded"
        ? `recorded ${caller.akuId} report/${result.report.sequence} · body/${bodySequence} · turn/${turnSequence}`
        : `refused report · ${result.reason}`,
    result.kind === "recorded" ? "accepted" : "refused",
  );
}
