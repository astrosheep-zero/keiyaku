import { CliUsageError, parseArgv, renderHelp } from "./parse.js";
import { installedPackageVersion } from "./version.js";

function handleBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  handleBrokenPipe(process.stdout);
  handleBrokenPipe(process.stderr);
  try {
    const parsed = parseArgv(argv);
    if ("help" in parsed) {
      const columns =
        process.stdout.isTTY === true && Number.isInteger(process.stdout.columns) ? process.stdout.columns : undefined;
      const help = renderHelp(parsed.help, columns);
      process.stdout.write(help.endsWith("\n") ? help : `${help}\n`);
      return 0;
    }
    if ("version" in parsed) {
      process.stdout.write(`${await installedPackageVersion()}\n`);
      return 0;
    }
    return await (await import("./runtime.js")).runCliCommand(parsed);
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    process.stderr.write(diagnostic.endsWith("\n") ? diagnostic : `${diagnostic}\n`);
    return error instanceof CliUsageError ? 64 : 3;
  }
}
