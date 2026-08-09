export class CliUsageError extends Error {
  constructor(readonly diagnostic: string, readonly projection?: string) {
    super(projection === undefined ? diagnostic : `${diagnostic}\n${projection}`);
    this.name = "CliUsageError";
  }
}

export function usageLine(usage: string): string {
  return usage.split("\n").map((line, index) => {
    if (index === 0) return `usage: keiyaku-v4 ${line}`;
    return line.startsWith("task ")
      ? `       keiyaku-v4 ${line}`
      : `       ${line.trimStart()}`;
  }).join("\n");
}
