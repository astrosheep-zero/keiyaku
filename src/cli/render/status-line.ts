export type StatusLineStream = NodeJS.WritableStream &
  Readonly<{
    isTTY?: boolean;
  }>;

type IntervalHandle = ReturnType<typeof setInterval>;

export type StatusLineOptions = Readonly<{
  now?: () => number;
  intervalMs?: number;
  schedule?: (tick: () => void, every: number) => IntervalHandle;
  cancel?: (handle: IntervalHandle) => void;
}>;

/** Draw short ASCII status text without measuring the terminal or changing wrap mode. */
function frame(text: string): string {
  const cells = text.replace(/[^ -~]/gu, "?");
  let output = "\r\u001b[2K";
  // Horizontal positioning clamps at the right edge. Painting right to left leaves the visible prefix there.
  for (let index = cells.length - 1; index >= 0; index--) output += `\u001b[${index + 1}G${cells[index]}`;
  return output;
}

/** A terminal-only, ephemeral line. It owns neither execution nor its outcome. */
export class StatusLine {
  readonly isTTY: boolean;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly schedule: (tick: () => void, every: number) => IntervalHandle;
  private readonly cancel: (handle: IntervalHandle) => void;
  private timer: IntervalHandle | undefined;
  private format: ((elapsedMs: number) => string) | undefined;
  private startedAt: number | undefined;
  private finished = false;

  constructor(
    private readonly stream: StatusLineStream,
    options: StatusLineOptions = {},
  ) {
    this.isTTY = stream.isTTY === true;
    this.now = options.now ?? (() => performance.now());
    this.intervalMs = options.intervalMs ?? 1_000;
    this.schedule = options.schedule ?? ((tick, every) => setInterval(tick, every));
    this.cancel = options.cancel ?? ((handle) => clearInterval(handle));
  }

  show(format: (elapsedMs: number) => string): void {
    if (!this.isTTY || this.finished) return;
    this.format = format;
    this.startedAt ??= this.now();
    this.redraw();
    if (!this.finished) this.timer ??= this.schedule(() => this.redraw(), this.intervalMs);
  }

  writeBlock(lines: readonly string[]): void {
    if (lines.length === 0) return;
    if (this.isTTY) this.erase();
    this.stream.write(`${lines.join("\n")}\n`);
    if (this.isTTY && this.format !== undefined) this.redraw();
  }

  finish(line?: string): void {
    if (this.finished) return;
    this.finished = true;
    const visible = this.format !== undefined;
    this.stop();
    this.format = undefined;
    this.startedAt = undefined;
    if (!this.isTTY) return;
    if (visible) this.stream.write("\r\u001b[2K");
    if (line !== undefined) this.stream.write(`${line}\n`);
  }

  private redraw(): void {
    if (!this.isTTY || this.format === undefined || this.startedAt === undefined) return;
    const line = this.format(Math.max(0, this.now() - this.startedAt));
    if (!this.finished) this.stream.write(frame(line));
  }

  private erase(): void {
    if (this.isTTY && this.format !== undefined) this.stream.write("\r\u001b[2K");
  }

  private stop(): void {
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
  }
}
