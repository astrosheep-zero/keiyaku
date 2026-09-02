import { spawnStdioProcess, type StdioProcess, type StdioProcessExit } from "./stdio.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type Pending = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
};
export type LineRpcNotification = Readonly<{ method: string; params?: Readonly<Record<string, unknown>> }>;
export type LineRpcServerRequest = LineRpcNotification & Readonly<{ id: number | string }>;
export type LineRpcExit = StdioProcessExit;

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export class LineRpcProcess {
  private readonly process: StdioProcess;
  private readonly pending = new Map<number, Pending>();
  private readonly notifications = new Set<(value: LineRpcNotification) => void>();
  private readonly serverRequests = new Set<(value: LineRpcServerRequest) => void>();
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private stdout = "";
  private closed = false;

  constructor(
    input: Readonly<{
      argv: readonly [string, ...string[]];
      cwd: string;
      env?: NodeJS.ProcessEnv;
      requestTimeoutMs?: number;
      timeoutMs?: number;
    }>,
  ) {
    this.requestTimeoutMs = input.requestTimeoutMs ?? input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs < 0) {
      throw new TypeError("line RPC request timeout must be a nonnegative finite millisecond duration");
    }
    this.process = spawnStdioProcess(input);
    this.process.output.setEncoding("utf8");
    this.process.output.on("data", (chunk: string) => this.consume(chunk));
    void this.process.exited.then((exit) => {
      this.closed = true;
      this.fail(new Error(`line RPC process exited${exit.code === null ? "" : ` with code ${exit.code}`}`));
    });
  }

  onNotification(listener: (value: LineRpcNotification) => void): void {
    this.notifications.add(listener);
  }
  onServerRequest(listener: (value: LineRpcServerRequest) => void): void {
    this.serverRequests.add(listener);
  }
  onExit(listener: (value: LineRpcExit) => void): void {
    void this.process.exited.then(listener);
  }

  private consume(chunk: string): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      if (newline < 0) {
        this.stdout += chunk.slice(offset);
        return;
      }
      this.stdout += chunk.slice(offset, newline);
      const rawLine = this.stdout;
      this.stdout = "";
      offset = newline + 1;
      const line = rawLine.trim();
      if (line.length > 0) this.receive(line);
      if (this.closed) return;
    }
  }

  private receive(line: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      this.failAndClose(new Error("line RPC protocol received malformed JSON"));
      return;
    }
    const message = object(decoded);
    if (message === undefined) return;
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      const error = object(message.error);
      if (error !== undefined) pending.reject(new Error(text(error.message) ?? "line RPC error"));
      else pending.resolve(message.result);
      return;
    }
    const method = text(message.method);
    if (method === undefined) return;
    const params = object(message.params);
    if (typeof message.id === "number" || typeof message.id === "string") {
      for (const listener of this.serverRequests)
        listener({ id: message.id, method, ...(params === undefined ? {} : { params }) });
      return;
    }
    for (const listener of this.notifications) listener({ method, ...(params === undefined ? {} : { params }) });
  }

  private fail(error: unknown): void {
    for (const pending of this.pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private failAndClose(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(error);
    void this.process.close(true).catch(() => undefined);
  }

  request(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    options: Readonly<{ timeoutMs?: number }> = {},
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("line RPC process is closed"));
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(
        new TypeError("line RPC request timeout must be a nonnegative finite millisecond duration"),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve, reject };
      pending.timer = setTimeout(() => {
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        reject(new Error(`line RPC request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.timer.unref?.();
      this.pending.set(id, pending);
      this.process.input.write(
        `${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`,
        (error) => {
          if (error === null || error === undefined) return;
          this.pending.delete(id);
          if (pending.timer !== undefined) clearTimeout(pending.timer);
          reject(error);
        },
      );
    });
  }

  notify(method: string): void {
    if (!this.closed) this.process.input.write(`${JSON.stringify({ method })}\n`);
  }

  async endInputAndDrain(timeoutMs?: number): Promise<void> {
    if (this.closed) {
      await this.process.exited;
      return;
    }
    this.closed = true;
    this.fail(new Error("line RPC process is closed"));
    await this.process.endInputAndDrain(timeoutMs);
  }

  async close(force = false): Promise<void> {
    if (this.closed) {
      await this.process.exited;
      return;
    }
    this.closed = true;
    this.fail(new Error("line RPC process is closed"));
    await this.process.close(force);
  }
}
