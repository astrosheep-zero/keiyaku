import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { terminateProcessTree } from "./run.js";

type Pending = Readonly<{ resolve(value: unknown): void; reject(error: unknown): void }>;
export type LineRpcNotification = Readonly<{ method: string; params?: Readonly<Record<string, unknown>> }>;
export type LineRpcServerRequest = LineRpcNotification & Readonly<{ id: number | string }>;
export type LineRpcExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export class LineRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly notifications = new Set<(value: LineRpcNotification) => void>();
  private readonly serverRequests = new Set<(value: LineRpcServerRequest) => void>();
  private readonly exited: Promise<LineRpcExit>;
  private nextId = 1;
  private stdout = "";
  private stderr = "";
  private closed = false;

  constructor(input: Readonly<{ argv: readonly [string, ...string[]]; cwd: string; env?: NodeJS.ProcessEnv }>) {
    this.child = spawn(input.argv[0], input.argv.slice(1), {
      cwd: input.cwd,
      env: input.env ?? process.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-4_000); });
    this.child.on("error", (error) => this.fail(error));
    this.exited = new Promise((resolve) => this.child.once("close", (code, signal) => {
      this.closed = true;
      this.fail(new Error(`line RPC process exited${code === null ? "" : ` with code ${code}`}`));
      resolve({ code, signal, stderr: this.stderr.trim() });
    }));
  }

  onNotification(listener: (value: LineRpcNotification) => void): void { this.notifications.add(listener); }
  onServerRequest(listener: (value: LineRpcServerRequest) => void): void { this.serverRequests.add(listener); }
  onExit(listener: (value: LineRpcExit) => void): void { void this.exited.then(listener); }

  private consume(chunk: string): void {
    this.stdout += chunk;
    for (;;) {
      const newline = this.stdout.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (line.length > 0) this.receive(line);
    }
  }

  private receive(line: string): void {
    let decoded: unknown;
    try { decoded = JSON.parse(line); } catch { return; }
    const message = object(decoded);
    if (message === undefined) return;
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      const error = object(message.error);
      if (error !== undefined) pending.reject(new Error(text(error.message) ?? "line RPC error"));
      else pending.resolve(message.result);
      return;
    }
    const method = text(message.method);
    if (method === undefined) return;
    const params = object(message.params);
    if (typeof message.id === "number" || typeof message.id === "string") {
      for (const listener of this.serverRequests) listener({ id: message.id, method, ...(params === undefined ? {} : { params }) });
      return;
    }
    for (const listener of this.notifications) listener({ method, ...(params === undefined ? {} : { params }) });
  }

  private fail(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  request(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("line RPC process is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`, (error) => {
        if (error === null || error === undefined) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method: string): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  async close(force = false): Promise<void> {
    if (this.closed) { await this.exited; return; }
    this.closed = true;
    this.fail(new Error("line RPC process is closed"));
    this.child.stdin.end();
    await terminateProcessTree(this.child.pid, force);
    await this.exited;
  }
}
