import { Keiyaku, KeiyakuRefused, type NukeResult } from "../../index.js";
import type { WorldRoot } from "../../world.js";
import { CliUsageError, type ParsedCommand } from "../parse.js";
import type { InvocationResult } from "../result.js";

export async function invokeNuke(
  command: Extract<ParsedCommand, { command: "nuke" }>,
  world: WorldRoot | null,
): Promise<Readonly<{ kind: "nuke"; result: NukeResult }> | InvocationResult> {
  if (world === null) throw new CliUsageError("no Keiyaku world contains the invocation cwd");
  try {
    return {
      kind: "nuke",
      result: await Keiyaku.nuke({
        world,
        ...(command.confirm === undefined ? {} : { confirm: command.confirm }),
      }),
    };
  } catch (error) {
    if (error instanceof KeiyakuRefused) return { kind: "refused", verb: "nuke", refusal: error.refusal };
    throw error;
  }
}
