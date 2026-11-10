import { classifyVerb } from "../../library/keiyaku-verbs.js";
import type { CliRuntime } from "../runtime.js";
import { renderVerb } from "../render/verbs.js";
import { displayContext, emit, type CliOutcome } from "../streams.js";
import type { ReportCommand } from "./akuma-grammar.js";

export async function runReport(command: ReportCommand, runtime: CliRuntime): Promise<CliOutcome> {
  const text = command.prompt.kind === "stdin" ? await runtime.readStdin() : command.prompt.value;
  const wire = { text };
  const result = await runtime.facet.run("report", wire, { signal: runtime.signal });
  const completion = { kind: "returned" as const, value: result };
  const actor = runtime.environment.KEIYAKU_ACTOR_ID;
  return emit(
    command.output,
    result,
    () =>
      renderVerb("report", wire, completion, {
        ...displayContext(),
        ...(actor === undefined ? {} : { actor }),
      }),
    classifyVerb("report", wire, completion),
  );
}
