import { invoke } from "./invoke.js";
import { CliUsageError, parseArgv } from "./parse.js";
import { renderText } from "./render/text.js";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    const result = await invoke(parsed);
    const output = parsed.command.output === "json" ? JSON.stringify(result) : renderText(result);
    process.stdout.write(`${output}\n`);
    return result.kind === "refused" ? 1 : result.kind === "retry" ? 2 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof CliUsageError ? 1 : 3;
  }
}
