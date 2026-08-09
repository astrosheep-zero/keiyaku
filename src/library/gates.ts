import { gateWord } from "../core/facts/types.js";
import type { Settings } from "../settings.js";

export type Gate = string;
export type GatesFromInput = Readonly<{ settings: Settings; name?: string }>;

export class SettingsError extends Error {
  readonly kind = "settings";
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function gatesFrom(input: GatesFromInput): readonly Gate[] {
  if (!record(input)) throw new TypeError("gatesFrom input must be an object");
  const name = input.name ?? "default";
  if (!gateWord(name)) throw new SettingsError("gate set name must match ^[a-z][a-z0-9-]{0,63}$");
  const view = input.settings.namespace("gates");
  if (view.kind === "failed") {
    throw new SettingsError(view.failures.map((failure) => `${failure.scope}: ${failure.diagnostic}`).join("; "));
  }
  const selected = view.entries.find((entry) => entry.name === name);
  if (selected === undefined) {
    if (input.name === undefined) return Object.freeze([]);
    throw new SettingsError(`unknown gate set: ${name}`);
  }
  if (!Array.isArray(selected.value)) throw new SettingsError(`gate set '${name}' must be an array`);
  const values = selected.value.map((value) => {
    if (!gateWord(value)) throw new SettingsError(`gate set '${name}' contains an invalid gate word`);
    return value;
  });
  if (new Set(values).size !== values.length) throw new SettingsError(`gate set '${name}' contains duplicate gates`);
  return Object.freeze(values);
}
