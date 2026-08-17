export class CliUsageError extends Error {
  constructor(readonly diagnostic: string, readonly projection?: string) {
    super(projection === undefined ? diagnostic : `${diagnostic}\n${projection}`);
    this.name = "CliUsageError";
  }
}

export const JSON_AUTOMATION_HELP =
  "--json is only for automation script input/output and should not be used for daily interactive use.";

export function withJsonAutomationHelp(help: string): string {
  return help.includes("--json") ? `${help}\n\n${JSON_AUTOMATION_HELP}` : help;
}

export function isBlankInput(value: string): boolean {
  return value.trim().length === 0;
}

export function usageLine(usage: string): string {
  return usage.split("\n").map((line, index) => {
    if (index === 0) return `usage: keiyaku ${line}`;
    return line.startsWith("task ")
      ? `       keiyaku ${line}`
      : `       ${line.trimStart()}`;
  }).join("\n");
}
