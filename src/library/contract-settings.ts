/** @architectureCompositionRoot */
import { gate, gateWord, type ActorId, type Gate } from "../core/facts/types.js";
import { EMPTY_WORKTREE_HOOKS, worktreeHooksFrom, type WorktreeHooks } from "../git/hooks.js";
import { SettingsError, gatesFrom, requireBranchesToBeUpToDateFrom, type Settings } from "../settings.js";
import type { LocalContractComposition } from "./contract-types.js";
import { actorOption, requireInput } from "./input.js";
import { KeiyakuError } from "./outcome.js";

/** The one immutable Contract-local composition captured at construction. */
export type LocalContractCompositionCapture = Readonly<{
  settings?: Settings;
  actor?: ActorId;
}>;

/** One scoped Settings lookup: its native failure stays the cause of caller-invalid input. */
function settingsScopedFailure(error: unknown): never {
  if (error instanceof SettingsError) throw new KeiyakuError("invalid-input", error.message, { cause: error });
  throw error;
}

/**
 * Hooks, freshness, and gate bundles are read from the captured Settings only at the operation
 * that consumes them. Bare core (omitted Settings) keeps empty hooks, false freshness, and
 * literal gate words; a broken selected namespace fails before any admission.
 */
export function derivedHooks(composition: LocalContractCompositionCapture): WorktreeHooks {
  if (composition.settings === undefined) return EMPTY_WORKTREE_HOOKS;
  try {
    return worktreeHooksFrom({ settings: composition.settings });
  } catch (error) {
    return settingsScopedFailure(error);
  }
}

function derivedFreshness(composition: LocalContractCompositionCapture): boolean {
  if (composition.settings === undefined) return false;
  try {
    return requireBranchesToBeUpToDateFrom({ settings: composition.settings });
  } catch (error) {
    return settingsScopedFailure(error);
  }
}

/** The two Settings-derived Contract policies one mutating operation may consume. */
export function derivedContractPolicy(composition: LocalContractCompositionCapture): Readonly<{
  hooks: WorktreeHooks;
  requireBranchesToBeUpToDate: boolean;
}> {
  return { hooks: derivedHooks(composition), requireBranchesToBeUpToDate: derivedFreshness(composition) };
}

export function gateNames(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("gates must be an array");
  return value.map((item, index) => {
    if (typeof item !== "string") throw new TypeError(`gates[${index}] must be a string`);
    return item;
  });
}

/** An explicit empty selection needs no bundle lookup; omitted names select the configured default. */
export function derivedGates(
  composition: LocalContractCompositionCapture,
  names: readonly string[] | undefined,
): readonly Gate[] {
  if (names !== undefined && names.length === 0) return Object.freeze([]);
  if (composition.settings === undefined) return literalGates(names);
  try {
    return (
      names === undefined
        ? gatesFrom({ settings: composition.settings })
        : gatesFrom({ settings: composition.settings, names })
    ) as readonly Gate[];
  } catch (error) {
    return settingsScopedFailure(error);
  }
}

function literalGates(names: readonly string[] | undefined): readonly Gate[] {
  if (names === undefined) return Object.freeze([]);
  const selected: Gate[] = [];
  const seen = new Set<string>();
  for (const [index, name] of names.entries()) {
    if (!gateWord(name)) {
      const message = `gates[${index}] must match ^[a-z][a-z0-9-]{0,63}$`;
      throw new KeiyakuError("invalid-input", message, { cause: new TypeError(message) });
    }
    if (seen.has(name)) continue;
    seen.add(name);
    selected.push(gate(name));
  }
  return Object.freeze(selected);
}

export function captureLocalContractComposition(input?: LocalContractComposition): LocalContractCompositionCapture {
  const values = requireInput(input === undefined ? {} : input, "Keiyaku.with input", ["settings", "actor"]);
  const actor = actorOption(values.actor).actor;
  const settings = values.settings;
  if (settings !== undefined && (settings === null || typeof settings !== "object")) {
    throw new TypeError("Keiyaku.with settings must be a Settings value");
  }
  return Object.freeze({
    ...(actor === undefined ? {} : { actor }),
    ...(settings === undefined ? {} : { settings: settings as Settings }),
  });
}
