import { randomUUID } from "node:crypto";
import { callReadonly, canonicalBirthCwd } from "./call-input.js";
import { spawnAkumaBody, type TellResult } from "./body.js";
import { decodeAllowedActions, unionAllowedActions } from "./allowed.js";
import type { AllowedAction } from "./allowed.js";
import { AkumaDecodeError, AkumaProviderError } from "./akuma-errors.js";
import { AkumaHandle } from "./akuma-handle.js";
import { POLL_MS, defaultWaitComplete } from "./akuma.js";
import type { AkumaStatus } from "./akuma.js";
import type { InterruptReceipt, KillEvidence } from "./akuma.js";
import { bornStatus } from "./akuma-observe.js";
import { loadArchetype } from "./archetype.js";
import { activitySlice, readTell, readTurn, type TellFact, type TurnOutcome } from "./heart/index.js";
import { parseAkuId, pathsForAkuId, type AkuId, type AkumaPaths } from "./identity.js";
import { birthAkuma, launchAkuma } from "./publication.js";
import { projectTurns, selectHistory, type ActivityHistory } from "./projection.js";
import { settings as readSettings } from "../settings.js";
import type { Settings } from "../settings.js";
import type { WorldRoot } from "../world.js";
import { schemaJsonText, type Schema } from "./schema.js";
import { abortable } from "./abort.js";

const HISTORY_LIMIT = 12;

export type AkumaIdleOptions = Readonly<{ timeoutMs?: number }>;
export type AkumaHistoryOptions = Readonly<{ before?: number; since?: number; limit?: number }>;
export type AkumaSignalOptions = Readonly<{ signal?: AbortSignal }>;

export type AkumaBirthInput = Readonly<{
  root: WorldRoot;
  cwd?: string;
  home?: string;
  settings?: Settings;
  readonly?: true;
  allowed?: readonly AllowedAction[];
}>;

export type AkumaTellOptions<T> = Readonly<{
  schema: Schema<T>;
  interrupt?: boolean;
}>;

type TellAdmission = Readonly<{ tellId: string }>;

function signalOption(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
  return value;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function recordedTell(result: TellResult): TellAdmission {
  if (result.wake.kind === "failed") throw new AkumaProviderError(result.wake.diagnostic);
  return { tellId: result.admission.tellId };
}

async function recordPlainTell(id: AkuId, root: WorldRoot, body: string, tellId: string): Promise<TellAdmission> {
  const admitted = await new AkumaHandle(id, root).tell(body, tellId);
  return recordedTell(admitted);
}

async function recordSchemaTell<T>(
  input: Readonly<{
    id: AkuId;
    body: string;
    tellId: string;
    options: AkumaTellOptions<T>;
    root: WorldRoot;
  }>,
): Promise<TellAdmission> {
  const { id, body, tellId, options, root } = input;
  if (options.interrupt === true) {
    const interrupted = await new AkumaHandle(id, root).interrupt(body, {
      tellId,
      schemaJson: schemaJsonText(options.schema),
    });
    if (interrupted.kind === "unavailable") {
      throw new AkumaProviderError(`schema interrupt unavailable: ${interrupted.evidence}`);
    }
    return recordedTell(interrupted.tell);
  }
  const admitted = await new AkumaHandle(id, root).tell(
    body,
    tellId,
    undefined,
    undefined,
    schemaJsonText(options.schema),
  );
  return recordedTell(admitted);
}
function outcomeError(outcome: TurnOutcome): never {
  if (outcome.kind === "invalid-output") throw new AkumaDecodeError(outcome.diagnostic, outcome.answer);
  if (outcome.kind === "failed") throw new AkumaProviderError(outcome.diagnostic);
  throw new AkumaProviderError("Akuma answered without a value");
}

async function boundOutcome(paths: AkumaPaths, tell: TellFact): Promise<TurnOutcome | null> {
  if (tell.binding === undefined) return null;
  const turn = await readTurn(paths, tell.binding.turnSequence);
  return turn?.end?.outcome ?? null;
}

async function awaitTellOutcome(paths: AkumaPaths, tellId: string): Promise<TurnOutcome> {
  for (;;) {
    const tell = await readTell(paths, tellId);
    if (tell === null) throw new AkumaProviderError(`recorded Tell ${tellId} is missing from Heart`);
    const outcome = await boundOutcome(paths, tell);
    if (outcome !== null) return outcome;
    if (tell.state === "told" && tell.binding === undefined) {
      throw new AkumaProviderError(`recorded Tell ${tellId} reached a terminal delivery without a Turn binding`);
    }
    await wait(POLL_MS);
  }
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
    const readonly = callReadonly(input.readonly, "Akuma birth readonly must be true");
    const loaded = await loadArchetype({ name, project: input.root, ...home, settings, ...readonly });
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
            ...(loaded.readonly === undefined ? {} : { readonly: loaded.readonly }),
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

  async tell(text: string): Promise<string>;
  async tell<T>(text: string, options: AkumaTellOptions<T>): Promise<T>;
  async tell<T>(text: string, options?: AkumaTellOptions<T>): Promise<string | T> {
    if (typeof text !== "string") throw new TypeError("Akuma tell text must be a string");
    const tellId = randomUUID();
    const recorded =
      options === undefined
        ? await recordPlainTell(this.id, this.root, text, tellId)
        : await recordSchemaTell({
            id: this.id,
            body: text,
            tellId,
            options,
            root: this.root,
          });
    const outcome = await awaitTellOutcome(this.paths, recorded.tellId);
    if (outcome.kind !== "answered") outcomeError(outcome);
    if (options === undefined) return outcome.answer;
    const raw = outcome.answerJson ?? outcome.answer;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new AkumaDecodeError(error instanceof Error ? error.message : "Answer is not valid JSON", outcome.answer);
    }
    try {
      return options.schema.decode(parsed);
    } catch (error) {
      throw new AkumaDecodeError(
        error instanceof Error ? error.message : "Answer failed schema decode",
        outcome.answer,
      );
    }
  }

  async status(): Promise<AkumaStatus> {
    return (await bornStatus(this.paths, this.id, { aperture: "monitoring" })).status;
  }

  async interrupt(text: string, options: AkumaSignalOptions = {}): Promise<InterruptReceipt> {
    if (typeof text !== "string") throw new TypeError("Akuma interrupt text must be a string");
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("Akuma interrupt options must be an object");
    }
    const signal = signalOption(options.signal);
    signal?.throwIfAborted();
    const operation = new AkumaHandle(this.id, this.root).interrupt(text, signal === undefined ? {} : { signal });
    return await abortable(operation, signal ?? new AbortController().signal);
  }

  async idle(options: AkumaIdleOptions = {}): Promise<void> {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("Akuma idle options must be an object");
    }
    const unknown = Object.keys(options).find((key) => key !== "timeoutMs");
    if (unknown !== undefined) throw new TypeError(`Akuma idle options has unknown field: ${unknown}`);
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      throw new TypeError("Akuma idle timeoutMs must be a nonnegative finite millisecond duration");
    }
    const deadline = options.timeoutMs === undefined ? undefined : performance.now() + options.timeoutMs;
    for (;;) {
      const observed = await bornStatus(this.paths, this.id, { aperture: "monitoring" });
      if (defaultWaitComplete(observed.status) || (deadline !== undefined && performance.now() >= deadline)) return;
      await wait(deadline === undefined ? POLL_MS : Math.min(POLL_MS, Math.max(0, deadline - performance.now())));
    }
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
