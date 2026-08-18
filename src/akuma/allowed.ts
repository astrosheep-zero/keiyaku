import { TASK_MUTATION_ACTIONS } from "../task/mutation.js";

export const ALLOWED_ACTIONS = Object.freeze([
  "akuma.call",
  "akuma.kill",
  "akuma.tell",
  "contract.deliver",
  "contract.review",
  ...TASK_MUTATION_ACTIONS,
] as const);

export type AllowedAction = (typeof ALLOWED_ACTIONS)[number];
export type AllowedActions = readonly AllowedAction[];

const ALLOWED_ACTION_SET: ReadonlySet<string> = new Set(ALLOWED_ACTIONS);

export function isAllowedAction(value: unknown): value is AllowedAction {
  return typeof value === "string" && ALLOWED_ACTION_SET.has(value);
}

export function decodeAllowedActions(value: unknown, label = "allowed"): AllowedActions {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const seen = new Set<AllowedAction>();
  for (const action of value) {
    if (!isAllowedAction(action)) throw new TypeError(`${label} contains an unknown action: ${String(action)}`);
    if (seen.has(action)) throw new TypeError(`${label} contains a duplicate action: ${action}`);
    seen.add(action);
  }
  return Object.freeze([...seen].sort());
}

export function effectiveAllowedActions(value: unknown): AllowedActions {
  return value === undefined ? ALLOWED_ACTIONS : decodeAllowedActions(value);
}

export function clipAllowedActions(requested: AllowedActions, parent: AllowedActions): AllowedActions {
  const ceiling = new Set(parent);
  return Object.freeze(requested.filter((action) => ceiling.has(action)));
}
