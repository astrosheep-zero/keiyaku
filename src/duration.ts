const MULTIPLIERS = Object.freeze({
  ms: 1n,
  s: 1_000n,
  m: 60_000n,
  h: 3_600_000n,
});

export type DurationParseResult =
  | Readonly<{ kind: "parsed"; milliseconds: number }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "overflow" }>;

export function parseDuration(value: string): DurationParseResult {
  const match = /^(0|[1-9][0-9]*)(ms|s|m|h)$/u.exec(value);
  if (match === null) return { kind: "invalid" };
  const milliseconds = BigInt(match[1]!) * MULTIPLIERS[match[2] as keyof typeof MULTIPLIERS];
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return { kind: "overflow" };
  return { kind: "parsed", milliseconds: Number(milliseconds) };
}

export function formatDuration(milliseconds: number): string {
  for (const [unit, multiplier] of [
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1_000],
  ] as const) {
    if (milliseconds >= multiplier && milliseconds % multiplier === 0) return `${milliseconds / multiplier}${unit}`;
  }
  return `${milliseconds}ms`;
}
