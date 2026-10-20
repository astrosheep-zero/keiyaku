import { DEBT_MUTATION_ACTIONS } from "../debt/mutation.js";
import { z } from "zod";

const AKUMA_MUTATION_ACTIONS = Object.freeze(["akuma.call", "akuma.kill", "akuma.tell"] as const);

export const ALLOWED_ACTIONS = Object.freeze([
  ...AKUMA_MUTATION_ACTIONS,
  "contract.audit",
  "contract.deliver",
  "contract.review",
  ...DEBT_MUTATION_ACTIONS,
] as const);

export type AllowedAction = (typeof ALLOWED_ACTIONS)[number];
export type AllowedActions = readonly AllowedAction[];

export const DEFAULT_ALLOWED_ACTIONS: AllowedActions = Object.freeze([
  ...AKUMA_MUTATION_ACTIONS,
  "contract.audit",
  "contract.deliver",
  ...DEBT_MUTATION_ACTIONS,
]);

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

/** Public codecs retain the Soul's canonical, duplicate-free action membership. */
export const allowedActionsSchema = z.array(z.enum(ALLOWED_ACTIONS)).transform((value, context): AllowedActions => {
  try {
    return decodeAllowedActions(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});

export function historicalAllowedActions(value: unknown): AllowedActions {
  if (value === undefined) return ALLOWED_ACTIONS;
  if (!Array.isArray(value)) return decodeAllowedActions(value);
  // Persisted permissions retain the same surviving capabilities after rename;
  // removed planning/progress operations confer no replacement permission.
  const retired = new Set(["task.compose", "task.start", "task.stop", "task.hold", "task.resume"]);
  return decodeAllowedActions(
    value
      .filter((action) => !retired.has(action))
      .map((action) =>
        typeof action === "string" && action.startsWith("task.") ? `debt.${action.slice("task.".length)}` : action,
      ),
  );
}

export function unionAllowedActions(base: AllowedActions, additions: AllowedActions): AllowedActions {
  const merged = new Set(base);
  for (const action of additions) merged.add(action);
  return Object.freeze([...merged].sort());
}

export function clipAllowedActions(requested: AllowedActions, parent: AllowedActions): AllowedActions {
  const ceiling = new Set(parent);
  return Object.freeze(requested.filter((action) => ceiling.has(action)));
}
