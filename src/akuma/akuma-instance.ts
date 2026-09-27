import { canonicalBirthCwd } from "./call-input.js";
import { spawnAkumaBody } from "./body.js";
import { decodeAllowedActions, unionAllowedActions } from "./allowed.js";
import type { AllowedAction } from "./allowed.js";
import { AkumaHandle } from "./akuma-handle.js";
import { decodeAskObservation, executeAskAkuma, executeTellAkuma } from "./selection-execution.js";
import type { AkumaAskResult, AkumaTellResult } from "./selection-observation.js";
import type { AkumaStatus } from "./akuma.js";
import type { KillEvidence } from "./akuma.js";
import { bornStatus, defaultWaitComplete, waitForObservation, type WaitReason } from "./akuma-observe.js";
import { loadArchetype } from "./archetype.js";
import { activitySlice } from "./heart/index.js";
import { parseAkuId, pathsForAkuId, type AkuId, type AkumaPaths } from "./identity.js";
import { birthAkuma, launchAkuma } from "./publication.js";
import { projectTurns, selectHistory, type ActivityHistory } from "./projection.js";
import { settings as readSettings } from "../settings.js";
import type { Settings } from "../settings.js";
import type { WorldRoot } from "../world.js";
import { schemaFromStandard, schemaJsonText, type Schema, type StandardSchemaV1 } from "./schema.js";
import { abortable } from "./abort.js";

const HISTORY_LIMIT = 12;

export type AkumaIdleOptions = Readonly<{ timeoutMs?: number; signal?: AbortSignal }>;
export type AkumaIdleResult = Readonly<{ reason: WaitReason; status: AkumaStatus }>;
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
export type AkumaAskOptions<T> = AkumaTellOptions & Readonly<{ timeoutMs?: number; schema?: Schema<T> | StandardSchemaV1<T> }>;


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

  private get paths(): AkumaPaths {
    return pathsForAkuId(this.root, this.id);
  }

  static async birth(archetype: string, input: AkumaBirthInput): Promise<Akuma> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new TypeError("Akuma birth input must be an object");
    }
    if (typeof input.root !== "string") throw new TypeError("Akuma birth root must be a WorldRoot");
    const name = archetype;
    const home = input.home === undefined ? {} : { home: input.home };
    const settings = input.settings ?? (await readSettings({ root: input.root, ...home }));
    const loaded = await loadArchetype({ name, project: input.root, ...home, settings });
    const allowed =
      input.allowed === undefined
        ? loaded.allowed
        : unionAllowedActions(loaded.allowed, decodeAllowedActions(input.allowed, "Akuma birth allowed"));
    const cwd = input.cwd === undefined ? input.root : await canonicalBirthCwd(input.cwd);
    const allocated = await birthAkuma({ worldPath: input.root, archetype: loaded.name });
    await launchAkuma({
      allocated,
      launch: async (born) =>
        await spawnAkumaBody({
          paths: born.paths,
          seed: {
            id: born.id,
            archetype: born.archetype,
            ...(loaded.description === undefined ? {} : { description: loaded.description }),
            provider: loaded.provider,
            options: loaded.options,
            allowed,
            cwd,
            origin: { kind: "direct" },
          },
        }),
    });
    return new Akuma(allocated.id, input.root);
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
    return executeTellAkuma({
      path: this.root, id: this.id, body: text,
      ...(options.interrupt === true ? { interrupt: true } : {}),
      ...(options.initiator === undefined ? {} : { initiator: options.initiator }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async ask(text: string, options?: AkumaAskOptions<string>): Promise<AkumaAskResult<string>>;
  async ask<T>(text: string, options: AkumaAskOptions<T> & Readonly<{ schema: Schema<T> | StandardSchemaV1<T> }>): Promise<AkumaAskResult<T>>;
  async ask<T>(text: string, options: AkumaAskOptions<T> = {}): Promise<AkumaAskResult<string | T>> {
    if (typeof text !== "string") throw new TypeError("Akuma ask text must be a string");
    if (typeof options !== "object" || options === null || Array.isArray(options))
      throw new TypeError("Akuma ask options must be an object");
    const unknown = Object.keys(options).find((key) => !["schema", "timeoutMs", "interrupt", "initiator", "signal"].includes(key));
    if (unknown !== undefined) throw new TypeError(`Akuma ask options has unknown field: ${unknown}`);
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 0))
      throw new TypeError("Akuma ask timeoutMs must be a nonnegative finite millisecond duration");
    const signal = signalOption(options.signal);
    signal?.throwIfAborted();
    const schema = options.schema === undefined ? undefined : schemaFromStandard(options.schema);
    const result = await executeAskAkuma({
      path: this.root, id: this.id, body: text,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(schema === undefined ? {} : { schemaJson: schemaJsonText(schema) }),
      ...(options.interrupt === true ? { interrupt: true } : {}),
      ...(options.initiator === undefined ? {} : { initiator: options.initiator }),
      ...(signal === undefined ? {} : { signal }),
    });
    return (schema === undefined ? result : { ...result, observation: decodeAskObservation(result.observation, schema) }) as AkumaAskResult<string | T>;
  }

  async status(): Promise<AkumaStatus> {
    return (await bornStatus(this.paths, this.id, { aperture: "monitoring" })).status;
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
    const waited = await waitForObservation({
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(signal === undefined ? {} : { signal }),
      observe: async () => (await bornStatus(this.paths, this.id, { aperture: "monitoring" })).status,
      complete: defaultWaitComplete,
    });
    return { reason: waited.reason, status: waited.value };
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
    for (const [name, value] of [
      ["before", options.before],
      ["since", options.since],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new TypeError(`Akuma history ${name} must be a positive safe integer`);
      }
    }
    const limit = options.limit ?? HISTORY_LIMIT;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 5_000) {
      throw new TypeError("Akuma history limit must be a positive safe integer no greater than 5000");
    }
    const slice = await activitySlice(this.paths);
    return selectHistory(projectTurns(slice.rows, { lowestRetained: slice.lowestRetained, highest: slice.highest }), {
      ...(options.before === undefined ? {} : { before: options.before }),
      ...(options.since === undefined ? {} : { since: options.since }),
      limit,
    });
  }

  async kill(options: AkumaSignalOptions = {}): Promise<KillEvidence> {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("Akuma kill options must be an object");
    }
    const signal = signalOption(options.signal);
    signal?.throwIfAborted();
    return await abortable(
      new AkumaHandle(this.id, this.root).kill(signal === undefined ? {} : { signal }),
      signal ?? new AbortController().signal,
    );
  }
}
