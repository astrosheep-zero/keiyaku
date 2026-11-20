import { KeiyakuError } from "./errors.js";
import { z } from "zod";

/** Catalogue selection; each product owns the classification of its lifecycle. */
export const lifecycleSelectionSchema = z.enum(["active", "settled", "all"]);
export type LifecycleSelection = z.output<typeof lifecycleSelectionSchema>;

export function lifecycleSelection(value: unknown = undefined): LifecycleSelection {
  if (value === undefined) return "active";
  const parsed = lifecycleSelectionSchema.safeParse(value);
  if (!parsed.success) throw new KeiyakuError("invalid-input", "selection must be active, settled, or all");
  return parsed.data;
}

export const DEFAULT_BOUNDED_LIST_LIMIT = 50;
export const MAX_BOUNDED_LIST_LIMIT = 500;

/** The explicit limit accepted by every bounded catalogue, described where callers discover it. */
export const boundedListLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_BOUNDED_LIST_LIMIT)
  .describe(`Maximum rows to return (1..${MAX_BOUNDED_LIST_LIMIT}).`);

export type BoundedList<Row> = Readonly<{
  rows: readonly Row[];
  hasMore: boolean;
}>;

export function boundedListLimit(value: unknown = undefined): number {
  if (value === undefined) return DEFAULT_BOUNDED_LIST_LIMIT;
  const parsed = boundedListLimitSchema.safeParse(value);
  if (!parsed.success) {
    throw new KeiyakuError("invalid-input", `limit must be an integer from 1 to ${MAX_BOUNDED_LIST_LIMIT}`);
  }
  return parsed.data;
}

export function projectBoundedList<Row>(rows: readonly Row[], limit: number): BoundedList<Row> {
  const projected = rows.slice(0, limit + 1);
  return { rows: projected.slice(0, limit), hasMore: projected.length > limit };
}
