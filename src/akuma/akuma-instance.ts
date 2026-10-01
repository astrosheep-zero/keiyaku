import {
  AkumaOwner,
  admitAkumaCall,
  decodeAskObservation,
  executeAskAkuma,
  executeTellAkuma,
  defaultWaitComplete,
  type InterruptReceipt,
  type KillEvidence,
  type AkumaStatus,
  type AkumaTellResult,
  type AkumaAskResult,
} from "./akuma.js";
import { schemaFromStandard, schemaJsonText, type Schema, type StandardSchemaV1 } from "./schema.js";
import { abortable } from "./abort.js";
import { parseAkuId, type AkuId } from "./identity.js";
import type { AllowedAction } from "./allowed.js";
import type { ActivityHistory } from "./projection.js";
import type { Settings } from "../settings.js";
import type { WorldRoot } from "../world.js";

export type AkumaIdleOptions = Readonly<{ timeoutMs?: number; signal?: AbortSignal }>;
export type AkumaIdleResult = Readonly<{ reason: "completed" | "deadline"; status: AkumaStatus }>;
export type AkumaHistoryOptions = Readonly<{ before?: number; since?: number; limit?: number }>;
export type AkumaSignalOptions = Readonly<{ signal?: AbortSignal }>;

export type AkumaBirthInput = Readonly<{
  root: WorldRoot;
  cwd?: string;
  home?: string;
  settings?: Settings;
  allowed?: readonly AllowedAction[];
}>;

export type AkumaTellOptions = AkumaSignalOptions & Readonly<{ interrupt?: boolean; initiator?: string }>;
export type AkumaAskOptions<T> = AkumaTellOptions &
  Readonly<{ timeoutMs?: number; schema?: Schema<T> | StandardSchemaV1<T> }>;

export type { InterruptReceipt, KillEvidence };
export type { AkumaTellResult, AkumaAskResult };

function signalOption(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
  return value;
}

export class Akuma {
  private constructor(
    readonly id: AkuId,
    private readonly root: WorldRoot,
  ) {
    Object.freeze(this);
  }

  private owner(): AkumaOwner {
    return new AkumaOwner(this.id, this.root);
  }

  static async birth(archetype: string, input: AkumaBirthInput): Promise<Akuma> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new TypeError("Akuma birth input must be an object");
    }
    if (typeof input.root !== "string") throw new TypeError("Akuma birth root must be a WorldRoot");
    const admitted = await admitAkumaCall(
      input.root,
      {
        ...(input.home === undefined ? {} : { home: input.home }),
        ...(input.settings === undefined ? {} : { settings: input.settings }),
      },
      {
        archetype,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.allowed === undefined ? {} : { allowed: input.allowed }),
      },
      {},
    );
    if (admitted.failure !== undefined) throw admitted.failure;
    return new Akuma(admitted.id, input.root);
  }

  static select(root: WorldRoot, selector: string): Akuma {
    if (typeof root !== "string") throw new TypeError("Akuma.select root must be a WorldRoot");
    return new Akuma(parseAkuId(selector).id, root);
  }

  async tell(text: string, options: AkumaTellOptions = {}): Promise<AkumaTellResult> {
    if (typeof text !== "string") throw new TypeError("Akuma tell text must be a string");
    if (typeof options !== "object" || options === null || Array.isArray(options))
      throw new TypeError("Akuma tell options must be an object");
    if ("schema" in options) throw new TypeError("Akuma tell does not accept schema; use ask");
    const unknown = Object.keys(options).find((key) => !["interrupt", "initiator", "signal"].includes(key));
    if (unknown !== undefined) throw new TypeError(`Akuma tell options has unknown field: ${unknown}`);
    const signal = signalOption(options.signal);
    signal?.throwIfAborted();
    return await executeTellAkuma({
      path: this.root,
      id: this.id,
      body: text,
      ...(options.interrupt === true ? { interrupt: true } : {}),
      ...(options.initiator === undefined ? {} : { initiator: options.initiator }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async ask(text: string, options?: AkumaAskOptions<string>): Promise<AkumaAskResult<string>>;
  async ask<T>(
    text: string,
    options: AkumaAskOptions<T> & Readonly<{ schema: Schema<T> | StandardSchemaV1<T> }>,
  ): Promise<AkumaAskResult<T>>;
  async ask<T>(text: string, options: AkumaAskOptions<T> = {}): Promise<AkumaAskResult<string | T>> {
    if (typeof text !== "string") throw new TypeError("Akuma ask text must be a string");
    if (typeof options !== "object" || options === null || Array.isArray(options))
      throw new TypeError("Akuma ask options must be an object");
    const unknown = Object.keys(options).find(
      (key) => !["schema", "timeoutMs", "interrupt", "initiator", "signal"].includes(key),
    );
    if (unknown !== undefined) throw new TypeError(`Akuma ask options has unknown field: ${unknown}`);
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 0)
    )
      throw new TypeError("Akuma ask timeoutMs must be a nonnegative finite millisecond duration");
    const signal = signalOption(options.signal);
    signal?.throwIfAborted();
    const schema = options.schema === undefined ? undefined : schemaFromStandard(options.schema);
    const result = await executeAskAkuma({
      path: this.root,
      id: this.id,
      body: text,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(schema === undefined ? {} : { schemaJson: schemaJsonText(schema) }),
      ...(options.interrupt === true ? { interrupt: true } : {}),
      ...(options.initiator === undefined ? {} : { initiator: options.initiator }),
      ...(signal === undefined ? {} : { signal }),
    });
    return (
      schema === undefined ? result : { ...result, observation: decodeAskObservation(result.observation, schema) }
    ) as AkumaAskResult<string | T>;
  }

  async status(): Promise<AkumaStatus> {
    return await this.owner().status();
  }

  async idle(options: AkumaIdleOptions = {}): Promise<AkumaIdleResult> {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("Akuma idle options must be an object");
    }
    const unknown = Object.keys(options).find((key) => key !== "timeoutMs" && key !== "signal");
    if (unknown !== undefined) throw new TypeError(`Akuma idle options has unknown field: ${unknown}`);
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      throw new TypeError("Akuma idle timeoutMs must be a nonnegative finite millisecond duration");
    }
    const signal = signalOption(options.signal);
    const waited = await this.owner().waitReceipt(defaultWaitComplete, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    });
    return { reason: waited.reason, status: waited.status };
  }

  async history(options: AkumaHistoryOptions = {}): Promise<ActivityHistory> {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("Akuma history options must be an object");
    }
    const unknown = Object.keys(options).find((key) => !["before", "since", "limit"].includes(key));
    if (unknown !== undefined) throw new TypeError(`Akuma history options has unknown field: ${unknown}`);
    if (options.before !== undefined && options.since !== undefined) {
      throw new TypeError("Akuma history before and since are mutually exclusive");
    }
    return (await this.owner().history({
      ...(options.before === undefined ? {} : { before: options.before }),
      ...(options.since === undefined ? {} : { since: options.since }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    })) as ActivityHistory;
  }

  async kill(options: AkumaSignalOptions = {}): Promise<KillEvidence> {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("Akuma kill options must be an object");
    }
    const signal = signalOption(options.signal);
    signal?.throwIfAborted();
    return await abortable(
      this.owner().kill(signal === undefined ? {} : { signal }),
      signal ?? new AbortController().signal,
    );
  }
}
