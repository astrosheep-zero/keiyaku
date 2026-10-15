import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { AKUMA_REQUESTS_ENTRY_ENV, AKUMA_REQUESTS_ENV } from "./providers/execution-environment.js";

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
  return Object.freeze({ channel: Object.freeze({ kind: "body-request" as const, directory }) });
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

/** Resolve persistent transport once at private process composition, never during an operation. */
export async function executionForEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<LibraryExecution> {
  signal?.throwIfAborted();
  const directory = environment[AKUMA_REQUESTS_ENV];
  const entry = environment[AKUMA_REQUESTS_ENTRY_ENV];
  if (entry === undefined)
    return directory === undefined ? localExecutionContext() : bodyRequestExecution({ directory });
  if (directory !== undefined) throw new TypeError("AKUMA_REQUESTS and AKUMA_REQUESTS_ENTRY are mutually exclusive");
  if (!isAbsolute(entry) || resolve(entry) !== entry) {
    throw new TypeError("AKUMA_REQUESTS_ENTRY must be an absolute normalized path");
  }
  let serialized: string;
  try {
    serialized = await readFile(entry, { encoding: "utf8", signal });
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`Akuma stable request entry unavailable: no current request channel at ${entry}`, { cause: error });
  }
  signal?.throwIfAborted();
  try {
    const value = valueRecord(JSON.parse(serialized), "body request entry");
    closed(value, ["directory"], "body request entry");
    return bodyRequestExecution({ directory: value.directory as string });
  } catch (error) {
    throw new TypeError(
      `Akuma stable request entry malformed at ${entry}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function executionChannel(context?: ExecutionContext): ExecutionChannel {
  return context?.channel ?? LOCAL_CHANNEL;
}
