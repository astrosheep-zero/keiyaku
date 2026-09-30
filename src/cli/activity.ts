import { writeCliStream } from "./streams.js";

/**
 * The one process-facing activity driver for observing Call, Ask and Wait. It owns the live frame's
 * whole lifetime — settled-row emission, redrawable frame, one conclusion and honest close — so the
 * three modes supply only their typed observation port and their native conclusion, never a second frame.
 */
export class ActivityDriver {
  private lines: readonly string[] = [];
  private concluded = false;

  constructor(private readonly stream: NodeJS.WriteStream = process.stderr) {}

  /** Emit one settled row block, then redraw the retained live frame beneath it. */
  settle(rows: readonly string[], frame: readonly string[]): void {
    if (rows.length > 0) {
      this.clear();
      this.write(rows.join("\n"));
    }
    this.redraw(frame);
  }

  /** Replace the redrawable live frame. Non-TTY streams keep settled rows only. */
  redraw(frame: readonly string[]): void {
    this.clear();
    this.lines = frame;
    this.draw();
  }

  /** Conclude the frame once with its final body and release it. */
  conclude(body: string): void {
    if (this.concluded) return;
    this.concluded = true;
    this.clear();
    this.lines = [];
    if (body.length > 0) this.write(body);
  }

  /**
   * Close on failure or cancellation without inventing a conclusion. Any still-in-flight rows are
   * emitted with their unresolved marks so the terminal shows what never settled, then the frame is
   * released; a mode that already concluded contributes no rows and this is a no-op.
   */
  close(inFlight: readonly string[] = []): void {
    if (this.concluded) return;
    this.concluded = true;
    this.clear();
    this.lines = [];
    if (inFlight.length > 0) this.write(inFlight.join("\n"));
  }

  private write(body: string): void {
    writeCliStream(this.stream, body);
  }

  private draw(): void {
    if (this.stream.isTTY !== true || this.lines.length === 0) return;
    this.stream.write(this.lines.join("\n"));
  }

  private clear(): void {
    if (this.stream.isTTY !== true || this.lines.length === 0) return;
    if (this.lines.length > 1) this.stream.write(`\u001b[${this.lines.length - 1}A`);
    this.stream.write("\r");
    for (let index = 0; index < this.lines.length; index += 1) {
      this.stream.write("\u001b[2K");
      if (index < this.lines.length - 1) this.stream.write("\n");
    }
    if (this.lines.length > 1) this.stream.write(`\u001b[${this.lines.length - 1}A`);
    this.stream.write("\r");
  }
}
