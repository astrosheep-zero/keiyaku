import { CliUsageError, parseArgv, renderHelp } from "./parse.js";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    if ("help" in parsed) {
      process.stdout.write(`${renderHelp(parsed.help)}\n`);
      return 0;
    }
    return await (await import("./runtime.js")).runCliCommand(parsed);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof CliUsageError ? 1 : 3;
  }
}
