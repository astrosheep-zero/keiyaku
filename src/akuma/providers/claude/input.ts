import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}>;

type QueuedInput = Readonly<{ message: SDKUserMessage; pulled: Deferred; onPulled?(): void }>;
type InputWaiter = Readonly<{
  resolve(value: IteratorResult<SDKUserMessage>): void;
  reject(error: unknown): void;
}>;

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function ended(): Error {
  return new Error("Claude input ended before the SDK acknowledged the message");
}

const turnEnded = Symbol("claude-turn-ended");
class ClaudeTurnEndedError extends Error {
  readonly [turnEnded] = true;
}

function turnEndedError(): ClaudeTurnEndedError {
  return new ClaudeTurnEndedError("Claude query ended before the SDK acknowledged the message");
}

export function isClaudeTurnEnded(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { [turnEnded]?: unknown })[turnEnded] === true;
}

export type ClaudeInput = Readonly<{
  iterable: AsyncIterable<SDKUserMessage>;
  get closed(): boolean;
  get pending(): number;
  push(message: SDKUserMessage, onPulled?: () => void): Promise<void>;
  end(): void;
  close(): void;
  fail(error: unknown): void;
}>;

export function claudeUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
}

export function createClaudeInput(): ClaudeInput {
  const queue: QueuedInput[] = [];
  const waiters: InputWaiter[] = [];
  let previous: QueuedInput | undefined;
  let failure: unknown;
  let closed = false;

  const acknowledgePrevious = (): void => {
    previous?.onPulled?.();
    previous?.pulled.resolve();
    previous = undefined;
  };
  const take = (entry: QueuedInput): IteratorResult<SDKUserMessage> => {
    previous = entry;
    return { done: false, value: entry.message };
  };
  const rejectUnresolved = (error: unknown): void => {
    previous?.pulled.reject(error);
    previous = undefined;
    for (const entry of queue.splice(0)) entry.pulled.reject(error);
  };

  return {
    get closed() { return closed; },
    get pending() { return queue.length + (previous === undefined ? 0 : 1); },
    push(message, onPulled) {
      if (closed) return Promise.reject(failure ?? ended());
      const entry = { message, pulled: deferred(), ...(onPulled === undefined ? {} : { onPulled }) };
      const waiter = waiters.shift();
      if (waiter === undefined) queue.push(entry);
      else waiter.resolve(take(entry));
      return entry.pulled.promise;
    },
    end() {
      if (closed) return;
      closed = true;
      rejectUnresolved(turnEndedError());
      for (const waiter of waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
    },
    close() {
      if (closed) return;
      closed = true;
      const error = ended();
      rejectUnresolved(error);
      for (const waiter of waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
    },
    fail(error) {
      if (closed) return;
      closed = true;
      failure = error;
      rejectUnresolved(error);
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            acknowledgePrevious();
            const entry = queue.shift();
            if (entry !== undefined) return Promise.resolve(take(entry));
            if (failure !== undefined) return Promise.reject(failure);
            if (closed) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
          },
        };
      },
    },
  };
}
