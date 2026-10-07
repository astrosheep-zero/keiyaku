/** @architectureCompositionRoot */
import { gate, gateWord, type ActorId, type Gate } from "../core/facts/types.js";
import { EMPTY_WORKTREE_HOOKS, worktreeHooksFrom, type WorktreeHooks } from "../git/hooks.js";
import { SettingsError, type Settings } from "../settings.js";
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
 * built-in gate words; a broken selected namespace fails before any admission.
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
    const view = composition.settings.namespace("git");
    if (view.kind === "failed") namespaceFailure(view);
    for (const entry of view.entries) {
      if (entry.name !== "requireBranchesToBeUpToDate") {
        throw new SettingsError(`git has unknown entry: ${entry.name}`);
      }
    }
    const selected = view.entries.find((entry) => entry.name === "requireBranchesToBeUpToDate");
    if (selected === undefined) return false;
    if (typeof selected.value !== "boolean") {
      throw new SettingsError("git.requireBranchesToBeUpToDate must be a boolean");
    }
    return selected.value;
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

function namespaceFailure(view: Extract<ReturnType<Settings["namespace"]>, { kind: "failed" }>): never {
  throw new SettingsError(view.failures.map((failure) => `${failure.scope}: ${failure.diagnostic}`).join("; "));
}

function gateValue(value: unknown, message: string, configured: boolean): Gate {
  if (!gateWord(value)) {
    if (configured) throw new SettingsError(message);
    throw new KeiyakuError("invalid-input", message, { cause: new TypeError(message) });
  }
  return gate(value);
}

function bundleGates(name: string, value: unknown): readonly Gate[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SettingsError(`gate group '${name}' must be an object`);
  }
  const bundle = value as Record<string, unknown>;
  if (bundle.kind !== "bundle") {
    throw new SettingsError(`gate group '${name}' has unsupported kind: ${String(bundle.kind)}`);
  }
  for (const field of Object.keys(bundle)) {
    if (field !== "kind" && field !== "gates") {
      throw new SettingsError(`gate group '${name}' has unknown field: ${field}`);
    }
  }
  if (!Array.isArray(bundle.gates)) throw new SettingsError(`gate group '${name}'.gates must be an array`);
  return bundle.gates.map((value) => gateValue(value, `gate group '${name}' contains an invalid gate word`, true));
}

/** Built-in words and configured bundles share validation, first-seen accumulation, and freezing. */
export function derivedGates(
  composition: LocalContractCompositionCapture,
  names: readonly string[] | undefined,
): readonly Gate[] {
  const settings = composition.settings;
  const configured = settings !== undefined;
  try {
    const selected = (names ?? (configured ? ["default"] : [])).map((name, index) =>
      gateValue(
        name,
        configured
          ? "gate name must match ^[a-z][a-z0-9-]{0,63}$"
          : `gates[${index}] must match ^[a-z][a-z0-9-]{0,63}$`,
        configured,
      ),
    );
    // Explicit empty selection never looks up a namespace.
    if (selected.length === 0) return Object.freeze([]);
    const view = settings?.namespace("gates");
    if (view?.kind === "failed") namespaceFailure(view);
    const known = [
      ...new Set(["reviewed", "verified", ...(view?.entries.map((entry) => entry.name).filter(gateWord) ?? [])]),
    ];
    const expanded = new Set<Gate>();
    for (const name of selected) {
      const entry = view?.entries.find((entry) => entry.name === name);
      if (entry === undefined) {
        // The implicit default bundle falls back to the built-in review gate.
        const implicit = configured && names === undefined;
        const word = implicit ? gate("reviewed") : name;
        if (word !== "reviewed" && word !== "verified")
          throw new KeiyakuError("invalid-input", `Unknown gate '${word}'. Known gate names: ${known.join(", ")}`);
        expanded.add(word);
        continue;
      }
      for (const value of bundleGates(name, entry.value)) expanded.add(value);
    }
    return Object.freeze([...expanded]);
  } catch (error) {
    return settingsScopedFailure(error);
  }
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
