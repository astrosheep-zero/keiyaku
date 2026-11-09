import { classifyVerb } from "../../library/keiyaku-verbs.js";
import type { CliRuntime } from "../runtime.js";
import type { ParsedWhoamiCommand } from "../parse.js";
import { renderVerb } from "../render/verbs.js";
import { displayContext, emit, type CliOutcome } from "../streams.js";

export async function runWhoami(command: ParsedWhoamiCommand, runtime: CliRuntime): Promise<CliOutcome> {
  const wire = {};
  const facts = await runtime.facet.run("whoami", wire, { signal: runtime.signal });
  const completion = { kind: "returned" as const, value: facts };
  return emit(
    command.output,
    facts,
    () => renderVerb("whoami", wire, completion, displayContext()),
    classifyVerb("whoami", wire, completion),
  );
}
