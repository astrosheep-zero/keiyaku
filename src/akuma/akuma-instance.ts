import { randomUUID } from "node:crypto";
import { callReadonly, canonicalBirthCwd } from "./call-input.js";
import { spawnAkumaBody, wakeRecordedTell } from "./body.js";
import { decodeAllowedActions, unionAllowedActions } from "./allowed.js";
import type { AllowedAction } from "./allowed.js";
import { AkumaDecodeError, AkumaNotBornError, AkumaProviderError } from "./akuma-errors.js";
import { AkumaHandle } from "./akuma-handle.js";
import { POLL_MS, defaultWaitComplete, killAkumaWithRecovery } from "./akuma.js";
import { bornStatus } from "./akuma-observe.js";
import { loadArchetype } from "./archetype.js";
import { activitySlice, readTell, readTurn, recordTell, type TellFact, type TurnOutcome } from "./heart/index.js";
import { parseAkuId, pathsForAkuId, type AkuId, type AkumaPaths } from "./identity.js";
import { birthAkuma, launchAkuma } from "./publication.js";
import { projectTurns, selectHistory, type ActivityHistory } from "./projection.js";
import { settings as readSettings } from "../settings.js";
import type { Settings } from "../settings.js";
import type { WorldRoot } from "../world.js";
import type { Schema } from "./schema.js";

const HISTORY_LIMIT = 12;

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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function recordPlainTell(paths: AkumaPaths, id: AkuId, body: string, tellId: string): Promise<string> {
  const admitted = await recordTell(paths, { kind: "tell", id: tellId, body, recordedAt: new Date().toISOString() });
  if (admitted.kind === "not-born") throw new AkumaNotBornError(id);
  return admitted.tell.id;
}

async function recordSchemaTell<T>(
  paths: AkumaPaths,
  id: AkuId,
  body: string,
  tellId: string,
  options: AkumaTellOptions<T>,
  root: WorldRoot,
): Promise<string> {
  if (options.interrupt === true) {
    const interrupted = await new AkumaHandle(id, root).interruptSchema(body, options.schema.jsonText);
    return interrupted.admission.tellId;
  }
  const recordedAt = new Date().toISOString();
  const tell = {
    kind: "tell" as const,
    id: tellId,
    body,
    recordedAt,
    schemaJson: options.schema.jsonText,
  };
  const admitted = await recordTell(paths, tell);
  if (admitted.kind === "not-born") throw new AkumaNotBornError(id);
  return admitted.tell.id;
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
  const wake = await wakeRecordedTell(paths, tellId);
  if (wake.wake.kind === "failed") throw new AkumaProviderError(wake.wake.diagnostic);
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
        ? await recordPlainTell(this.paths, this.id, text, tellId)
        : await recordSchemaTell(this.paths, this.id, text, tellId, options, this.root);
    const outcome = await awaitTellOutcome(this.paths, recorded);
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
      return options.schema.parse(parsed);
    } catch (error) {
      throw new AkumaDecodeError(
        error instanceof Error ? error.message : "Answer failed schema decode",
        outcome.answer,
      );
    }
  }

  async idle(): Promise<void> {
    for (;;) {
      const observed = await bornStatus(this.paths, this.id, { aperture: "monitoring" });
      if (defaultWaitComplete(observed.status)) return;
      await wait(POLL_MS);
    }
  }

  async history(): Promise<ActivityHistory> {
    const slice = await activitySlice(this.paths);
    return selectHistory(projectTurns(slice.rows, { lowestRetained: slice.lowestRetained, highest: slice.highest }), {
      limit: HISTORY_LIMIT,
    });
  }

  async kill(): Promise<void> {
    await killAkumaWithRecovery(this.paths);
  }
}
