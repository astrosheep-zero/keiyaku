import { isAbsolute, resolve } from "node:path";

export { AkumaBodyRequestError, requestBodyCommand } from "./request-rendezvous.js";

export type ExecutionChannel = Readonly<{ kind: "local" }> | Readonly<{ kind: "body-request"; directory: string }>;

export type ExecutionContext = Readonly<{ channel: ExecutionChannel }>;
export type LibraryExecution = ExecutionContext;

const LOCAL_CHANNEL: ExecutionChannel = Object.freeze({ kind: "local" });

export function localExecutionContext(): ExecutionContext {
  return Object.freeze({ channel: LOCAL_CHANNEL });
}

export function bodyRequestExecutionContext(directory: unknown): ExecutionContext {
  if (typeof directory !== "string" || !isAbsolute(directory) || resolve(directory) !== directory) {
    throw new Error("AKUMA_REQUESTS must be an absolute normalized path");
  }
  return Object.freeze({ channel: Object.freeze({ kind: "body-request", directory }) });
}

type ValueRecord = Readonly<Record<string, unknown>>;

function valueRecord(value: unknown, label: string): ValueRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as ValueRecord;
}

function closed(value: ValueRecord, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new TypeError(`${label} has unknown field: ${key}`);
  }
}

/** Constructs the one direct-parent route a caller may explicitly compose. */
export function bodyRequestExecution(input: Readonly<{ directory: string }>): LibraryExecution {
  const value = valueRecord(input, "body request execution input");
  closed(value, ["directory"], "body request execution input");
  if (typeof value.directory !== "string") throw new TypeError("body request execution directory must be a string");
  try {
    return bodyRequestExecutionContext(value.directory);
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : String(error));
  }
}

/** Normalizes the public carrier before a composition captures its immutable channel. */
export function libraryExecution(value: unknown): LibraryExecution {
  const context = valueRecord(value, "execution");
  closed(context, ["channel"], "execution");
  const channel = valueRecord(context.channel, "execution channel");
  if (channel.kind === "local") {
    closed(channel, ["kind"], "execution channel");
    return localExecutionContext();
  }
  if (channel.kind === "body-request") {
    closed(channel, ["directory", "kind"], "execution channel");
    if (typeof channel.directory !== "string") throw new TypeError("execution channel directory must be a string");
    return bodyRequestExecution({ directory: channel.directory });
  }
  throw new TypeError("execution channel must be local or body-request");
}

export function libraryExecutionInput(input: unknown): LibraryExecution {
  const value = valueRecord(input, "Keiyaku.withExecution input");
  closed(value, ["execution"], "Keiyaku.withExecution input");
  if (value.execution === undefined) throw new TypeError("Keiyaku.withExecution input requires execution");
  return libraryExecution(value.execution);
}

export function executionChannel(context?: ExecutionContext): ExecutionChannel {
  return context?.channel ?? LOCAL_CHANNEL;
}
