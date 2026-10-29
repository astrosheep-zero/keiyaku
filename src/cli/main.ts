import { CliUsageError, parseArgv, renderHelp } from "./parse.js";
import { cliExitCode } from "./streams.js";
import { installedPackageVersion } from "./version.js";

function handleBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(cliExitCode("accepted"));
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
      return cliExitCode("accepted");
    }
    if ("version" in parsed) {
      process.stdout.write(`${await installedPackageVersion()}\n`);
      return cliExitCode("accepted");
    }
    return await (await import("./runtime.js")).runCliCommand(parsed);
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    process.stderr.write(diagnostic.endsWith("\n") ? diagnostic : `${diagnostic}\n`);
    return cliExitCode(error instanceof CliUsageError ? "usage" : "failed");
  }
}
