import { gateWord } from "../core/facts/types.js";
import { SettingsError, type Settings } from "../settings.js";
import type { HookCommand, WorktreeHooks } from "../git/hooks.js";
export type { HookCommand, WorktreeHooks } from "../git/hooks.js";

export type Gate = string;
export type GatesFromInput = Readonly<{ settings: Settings; name?: string }>;
export type RequireBranchesToBeUpToDateFromInput = Readonly<{ settings: Settings }>;
export type WorktreeHooksFromInput = Readonly<{ settings: Settings }>;
export { SettingsError };

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function namespaceFailure(view: ReturnType<Settings["namespace"]>): never {
  if (view.kind !== "failed") throw new Error("settings namespace failure expected");
  throw new SettingsError(view.failures.map((failure) => `${failure.scope}: ${failure.diagnostic}`).join("; "));
}

export function gatesFrom(input: GatesFromInput): readonly Gate[] {
  if (!record(input)) throw new TypeError("gatesFrom input must be an object");
  const name = input.name ?? "default";
  if (!gateWord(name)) throw new SettingsError("gate set name must match ^[a-z][a-z0-9-]{0,63}$");
  const view = input.settings.namespace("gates");
  if (view.kind === "failed") namespaceFailure(view);
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

function command(value: unknown, coordinate: string, ErrorType: typeof TypeError | typeof SettingsError): HookCommand {
  if (!record(value)) throw new ErrorType(`${coordinate} must be an object`);
  for (const key of Object.keys(value)) {
    if (key !== "argv" && key !== "timeoutMs") throw new ErrorType(`${coordinate} has unknown field: ${key}`);
  }
  if (!Array.isArray(value.argv) || value.argv.length === 0 || !value.argv.every((item) => typeof item === "string")) {
    throw new ErrorType(`${coordinate}.argv must be a nonempty string array`);
  }
  if (value.argv[0]!.trim().length === 0) throw new ErrorType(`${coordinate}.argv[0] must be nonblank`);
  if (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1 || (value.timeoutMs as number) > 2_147_483_647) {
    throw new ErrorType(`${coordinate}.timeoutMs must be an integer from 1 through 2147483647`);
  }
  return Object.freeze({ argv: Object.freeze([...value.argv]), timeoutMs: value.timeoutMs as number });
}

function commands(value: unknown, coordinate: string, ErrorType: typeof TypeError | typeof SettingsError): readonly HookCommand[] {
  if (!Array.isArray(value)) throw new ErrorType(`${coordinate} must be an array`);
  return Object.freeze(value.map((item, index) => command(item, `${coordinate}[${index}]`, ErrorType)));
}

export function requireBranchesToBeUpToDateFrom(input: RequireBranchesToBeUpToDateFromInput): boolean {
  if (!record(input)) throw new TypeError("requireBranchesToBeUpToDateFrom input must be an object");
  const view = input.settings.namespace("git");
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
}

export function worktreeHooksFrom(input: WorktreeHooksFromInput): WorktreeHooks {
  if (!record(input)) throw new TypeError("worktreeHooksFrom input must be an object");
  const view = input.settings.namespace("worktree");
  if (view.kind === "failed") namespaceFailure(view);
  for (const entry of view.entries) {
    if (entry.name !== "create" && entry.name !== "destroy") {
      throw new SettingsError(`worktree has unknown entry: ${entry.name}`);
    }
  }
  const selected = (phase: "create" | "destroy"): readonly HookCommand[] => {
    const entry = view.entries.find((item) => item.name === phase);
    if (entry === undefined) return Object.freeze([]);
    return commands(entry.value, `worktree.${phase}`, SettingsError);
  };
  return Object.freeze({ create: selected("create"), destroy: selected("destroy") });
}

export function normalizedWorktreeHooks(value: unknown): WorktreeHooks {
  if (!record(value)) throw new TypeError("hooks must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "create" && key !== "destroy") throw new TypeError(`hooks has unknown field: ${key}`);
  }
  return Object.freeze({
    create: commands(value.create, "hooks.create", TypeError),
    destroy: commands(value.destroy, "hooks.destroy", TypeError),
  });
}

export const EMPTY_WORKTREE_HOOKS: WorktreeHooks = Object.freeze({
  create: Object.freeze([]),
  destroy: Object.freeze([]),
});

export function worktreeHooksOption(value: unknown): WorktreeHooks {
  return value === undefined ? EMPTY_WORKTREE_HOOKS : normalizedWorktreeHooks(value);
}
