import type { CliRuntime } from "../runtime.js";
import type { ParsedWhoamiCommand } from "../parse.js";
import { renderWhoami } from "../render/whoami.js";
import { emit, type CliOutcome } from "../streams.js";

export async function runWhoami(command: ParsedWhoamiCommand, runtime: CliRuntime): Promise<CliOutcome> {
  const facts = await runtime.facet.whoami();
  return emit(command.output, facts, () => renderWhoami(facts), "accepted");
}
