import { z } from "zod";
import { akumaStatusSchema } from "./akuma.js";
import { reportFactWireSchema } from "./heart/facts.js";
import type { AkumaCaller } from "./caller.js";
import type { Settings } from "../settings.js";
import type { WorldRoot } from "../world.js";
import {
  emitPluginSignal,
  outcomePluginObserver,
  stderrPluginDiagnostic,
  withAkumaWaitDeferrals,
} from "../plugin/akuma-signals.js";
import { abortable } from "./abort.js";
import { admitAkumaCall } from "./akuma-call.js";
import { defaultWaitComplete } from "./akuma-observe.js";
import type { AkumaStreamSnapshot } from "./akuma-stream.js";
import { AkumaOwner, type InterruptReceipt } from "./akuma-owner.js";
import { decodeAskObservation, executeAskAkuma, executeTellAkuma } from "./akuma-selection-execution.js";
import { type AkumaStatus } from "./akuma.js";
import { type KillEvidence } from "./heart/index.js";
import type { ReportFact } from "./heart/facts.js";
import { captureAkumaHost, type AkumaHostOptions } from "../body-host.js";
export type { AkumaHostOptions } from "../body-host.js";
import type { BodyLauncher } from "./body-launch.js";
import { parseAkumaId, type AkumaId } from "./identity.js";
import type { ActivityHistory } from "./projection.js";
import { schemaFromStandard, schemaJsonText, type Schema, type StandardSchemaV1 } from "./schema.js";
import { type AkumaAskResult, type AkumaTellResult } from "./selection-observation.js";

export const akumaIdleResultSchema = z
  .strictObject({ reason: z.enum(["completed", "deadline"]), status: akumaStatusSchema })
  .readonly();
export const akumaReportResultSchema = z.union([
  z.strictObject({ kind: z.literal("recorded"), report: reportFactWireSchema }).readonly(),
  z.strictObject({ kind: z.literal("refused"), reason: z.enum(["not-born", "not-executing"]) }).readonly(),
]);

export type AkumaIdleOptions = Readonly<{ timeoutMs?: number; signal?: AbortSignal }>;
export type AkumaIdleResult = Readonly<{ reason: "completed" | "deadline"; status: AkumaStatus }>;
export type AkumaHistoryOptions = Readonly<{ before?: number; since?: number; limit?: number }>;
export type AkumaSignalOptions = Readonly<{ signal?: AbortSignal }>;

/** Capture the observer capability, not the caller's mutable options object. */
export function captureAkumaHostDiagnostic(host: AkumaHostOptions | undefined): AkumaHostOptions["reportDiagnostic"] {
  return captureAkumaHost(host).reportDiagnostic;
}

export type AkumaBirthInput = Readonly<{
  root: WorldRoot;
  cwd?: string;
  home?: string;
  settings?: Settings;
  writableDirectories?: readonly string[];
  bare?: boolean;
  caller?: AkumaCaller;
  initiator?: string;
  host?: AkumaHostOptions;
}>;

export type AkumaReportOptions = AkumaSignalOptions;
export type AkumaReportResult =
  | Readonly<{ kind: "recorded"; report: ReportFact }>
  | Readonly<{ kind: "refused"; reason: "not-born" | "not-executing" }>;

export type AkumaTellOptions = AkumaSignalOptions & Readonly<{ interrupt?: boolean; initiator?: string }>;
export type AkumaAskOptions<T> = AkumaTellOptions &
  Readonly<{ timeoutMs?: number; schema?: Schema<T> | StandardSchemaV1<T> }>;

export type { AkumaAskResult, AkumaTellResult, InterruptReceipt, KillEvidence };

function signalOption(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
  return value;
}

class AkumaHandle {
  constructor(
    readonly id: AkumaId,
    private readonly root: WorldRoot,
    private readonly reportDiagnostic: (message: string) => void,
    private readonly spawn: BodyLauncher,
  ) {
    Object.freeze(this);
  }

  private owner(observing = false): AkumaOwner {
    return new AkumaOwner(
      this.id,
      this.root,
      observing ? outcomePluginObserver({ world: this.root, reportDiagnostic: this.reportDiagnostic }) : undefined,
    );
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
      spawn: this.spawn,
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
    return await withAkumaWaitDeferrals(
      { world: this.root, reportDiagnostic: this.reportDiagnostic },
      { akumaIds: [this.id] },
      signal,
      async () => {
        const result = await executeAskAkuma({
          spawn: this.spawn,
          path: this.root,
          id: this.id,
          outcomeObserved: outcomePluginObserver({ world: this.root, reportDiagnostic: this.reportDiagnostic }),
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
      },
    );
  }

  async report(text: string, options: AkumaReportOptions = {}): Promise<AkumaReportResult> {
    if (typeof text !== "string" || text.trim() === "") throw new TypeError("Akuma report text must be nonblank");
    if (typeof options !== "object" || options === null || Array.isArray(options))
      throw new TypeError("Akuma report options must be an object");
    const unknown = Object.keys(options).find((key) => !["signal"].includes(key));
    if (unknown !== undefined) throw new TypeError(`Akuma report options has unknown field: ${unknown}`);
    const signal = signalOption(options.signal);
    const result = await this.owner().report({ text, at: new Date().toISOString() }, signal);
    if (result.kind !== "recorded") return result;
    const { report, initiator } = result;
    await emitPluginSignal(
      { world: this.root, reportDiagnostic: this.reportDiagnostic },
      {
        kind: "akuma.reported",
        akumaId: this.id,
        bodySequence: report.bodySequence,
        turnSequence: report.turnSequence,
        reportSequence: report.sequence,
        text: report.text,
        at: report.at,
        ...(initiator === undefined ? {} : { initiator }),
      },
    );
    return { kind: "recorded", report };
  }

  async status(): Promise<AkumaStatus> {
    return await this.owner(true).status();
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
    return await withAkumaWaitDeferrals(
      { world: this.root, reportDiagnostic: this.reportDiagnostic },
      { akumaIds: [this.id] },
      signal,
      async () => {
        const waited = await this.owner(true).waitReceipt(defaultWaitComplete, {
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(signal === undefined ? {} : { signal }),
        });
        return { reason: waited.reason, status: waited.status };
      },
    );
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
    return (await this.owner(true).history({
      ...(options.before === undefined ? {} : { before: options.before }),
      ...(options.since === undefined ? {} : { since: options.since }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    })) as ActivityHistory;
  }

  stream(options: AkumaSignalOptions = {}): AsyncIterable<AkumaStreamSnapshot> {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("Akuma stream options must be an object");
    }
    const unknown = Object.keys(options).find((key) => key !== "signal");
    if (unknown !== undefined) throw new TypeError(`Akuma stream options has unknown field: ${unknown}`);
    const signal = signalOption(options.signal);
    return this.owner(true).stream(signal === undefined ? {} : { signal });
  }

  async kill(options: AkumaSignalOptions = {}): Promise<KillEvidence> {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("Akuma kill options must be an object");
    }
    const signal = signalOption(options.signal);
    signal?.throwIfAborted();
    return await abortable(
      this.owner().kill(this.spawn, signal === undefined ? {} : { signal }),
      signal ?? new AbortController().signal,
    );
  }
}

export class Akuma extends AkumaHandle {
  private constructor(id: AkumaId, root: WorldRoot, reportDiagnostic: (message: string) => void, spawn: BodyLauncher) {
    super(id, root, reportDiagnostic, spawn);
  }

  static async birth(akumaName: string, input: AkumaBirthInput): Promise<Akuma> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new TypeError("Akuma birth input must be an object");
    }
    const unknown = Object.keys(input).find(
      (key) =>
        !["root", "cwd", "home", "settings", "writableDirectories", "bare", "caller", "initiator", "host"].includes(
          key,
        ),
    );
    if (unknown !== undefined) throw new TypeError(`Akuma birth input has unknown field: ${unknown}`);
    if (typeof input.root !== "string") throw new TypeError("Akuma birth root must be a WorldRoot");
    const { spawn, reportDiagnostic = stderrPluginDiagnostic } = captureAkumaHost(input.host);
    const admitted = await admitAkumaCall(
      input.root,
      {
        ...(input.home === undefined ? {} : { home: input.home }),
        ...(input.settings === undefined ? {} : { settings: input.settings }),
      },
      {
        akumaName,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.writableDirectories === undefined ? {} : { writableDirectories: input.writableDirectories }),
        ...(input.bare === undefined ? {} : { bare: input.bare }),
        ...(input.caller === undefined ? {} : { caller: input.caller }),
        ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
      },
      {},
      spawn,
    );
    if (admitted.failure !== undefined) throw admitted.failure;
    return new Akuma(admitted.id, input.root, reportDiagnostic, spawn);
  }

  static select(root: WorldRoot, selector: string, host?: AkumaHostOptions): Akuma {
    if (typeof root !== "string") throw new TypeError("Akuma.select root must be a WorldRoot");
    const { spawn, reportDiagnostic = stderrPluginDiagnostic } = captureAkumaHost(host);
    return new Akuma(parseAkumaId(selector).id, root, reportDiagnostic, spawn);
  }
}

/** Internal product composition; hosting is captured independently of public operation inputs. */
export function akumaWithLauncher(
  root: WorldRoot,
  selector: string,
  spawn: BodyLauncher,
  host?: AkumaHostOptions,
): Akuma {
  if (typeof root !== "string") throw new TypeError("Akuma.select root must be a WorldRoot");
  const reportDiagnostic = captureAkumaHostDiagnostic(host) ?? stderrPluginDiagnostic;
  return new AkumaHandle(parseAkumaId(selector).id, root, reportDiagnostic, spawn);
}
