export class CliUsageError extends Error {
  constructor(readonly diagnostic: string, readonly projection?: string) {
    super(projection === undefined ? diagnostic : `${diagnostic}\n${projection}`);
    this.name = "CliUsageError";
  }
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
