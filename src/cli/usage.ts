export type CliUsageGuide = Readonly<{
  scope: string;
  accepts: string;
  help: string;
  given?: string;
  hideDiagnostic?: boolean;
}>;

export const ROOT_USAGE_GUIDE: CliUsageGuide = {
  scope: "keiyaku",
  accepts: "keiyaku <command> [options]",
  help: "keiyaku --help",
};

export const TASK_FAMILY_USAGE_GUIDE: CliUsageGuide = {
  scope: "keiyaku task",
  accepts: "keiyaku task <command> ...",
  help: "keiyaku task --help",
};

export function acceptsFromUsage(usage: string): string {
  return usage
    .split("\n")
    .map((line) => {
      const continuation = line.trimStart();
      const body = continuation.startsWith("keiyaku ") ? continuation.slice("keiyaku ".length) : continuation;
      return `keiyaku ${body}`;
    })
    .join("\n");
}

export function commandGuide(commandPath: string, usage: string): CliUsageGuide {
  return {
    scope: `keiyaku ${commandPath}`,
    accepts: acceptsFromUsage(usage),
    help: `keiyaku ${commandPath} --help`,
  };
}

export function unknownCommandGuide(guide: CliUsageGuide, given: string): CliUsageGuide {
  return {
    ...guide,
    ...(given.length > 0 ? { given } : {}),
    hideDiagnostic: true,
  };
}

export function renderUsageMessage(
  diagnostic: string,
  guide?: CliUsageGuide,
  kind: "usage" | "selector" = "usage",
): string {
  if (guide === undefined) {
    return `× ${kind}\n  reason  ${diagnostic}`;
  }
  const lines = [`× ${kind}  ${guide.scope}`];
  if (!guide.hideDiagnostic && diagnostic.length > 0) {
    lines.push(`  reason  ${diagnostic}`);
  }
  if (guide.given !== undefined) {
    lines.push(`  given  ${guide.given}`);
  }
  lines.push(...usageAcceptanceLines(guide));
  return lines.join("\n");
}

/** The acceptance grammar tail shared by usage and substantive refusals. */
export function usageAcceptanceLines(guide: CliUsageGuide): readonly string[] {
  const accepts = guide.accepts.split("\n");
  return [
    `  accepts  ${accepts[0]!}`,
    ...accepts.slice(1).map((part) => `           ${part}`),
    `  help  ${guide.help}`,
  ];
}

export class CliUsageError extends Error {
  constructor(
    readonly diagnostic: string,
    readonly guide?: CliUsageGuide,
  ) {
    super(renderUsageMessage(diagnostic, guide));
    this.name = "CliUsageError";
  }
}

export function isBlankInput(value: string): boolean {
  return value.trim().length === 0;
}

/** Run Settings-backed consumption at the edge, refusing a Settings failure as usage. */
export function consumeSettings<T>(run: () => T, ErrorType: new (message: string) => Error): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof Error && "executionReceipt" in error) throw error;
    if (error instanceof ErrorType) throw new CliUsageError(error.message);
    throw error;
  }
}

export function usageLine(usage: string): string {
  return usage
    .split("\n")
    .map((line, index) => {
      if (index === 0) return `usage  keiyaku ${line}`;
      const continuation = line.trimStart();
      return `      keiyaku ${continuation.startsWith("keiyaku ") ? continuation.slice("keiyaku ".length) : continuation}`;
    })
    .join("\n");
}
