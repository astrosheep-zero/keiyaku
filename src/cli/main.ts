import { CliUsageError, parseArgv, renderHelp } from "./parse.js";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    if ("help" in parsed) {
      const columns =
        process.stdout.isTTY === true && Number.isInteger(process.stdout.columns) ? process.stdout.columns : undefined;
      const help = renderHelp(parsed.help, columns);
      process.stdout.write(help.endsWith("\n") ? help : `${help}\n`);
      return 0;
    }
    return await (await import("./runtime.js")).runCliCommand(parsed);
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    process.stderr.write(diagnostic.endsWith("\n") ? diagnostic : `${diagnostic}\n`);
    return error instanceof CliUsageError ? 1 : 3;
  }
}
