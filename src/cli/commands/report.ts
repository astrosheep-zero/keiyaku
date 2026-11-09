import type { CliRuntime } from "../runtime.js";
import { emit, type CliOutcome } from "../streams.js";
import type { ParsedAkumaCommand } from "./akuma-grammar.js";

export async function runReport(
  command: Extract<ParsedAkumaCommand, { command: "report" }>,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const text = command.prompt.kind === "stdin" ? await runtime.readStdin() : command.prompt.value;
  const result = await runtime.facet.report({ text, signal: runtime.signal });
  return emit(
    command.output,
    result,
    () =>
      result.kind === "recorded"
        ? `recorded ${runtime.environment.KEIYAKU_ACTOR_ID} report/${result.report.sequence} · body/${result.report.bodySequence} · turn/${result.report.turnSequence}`
        : `refused report · ${result.reason}`,
    result.kind === "recorded" ? "accepted" : "refused",
  );
}
