export const DEFAULT_BOUNDED_LIST_LIMIT = 50;
export const MAX_BOUNDED_LIST_LIMIT = 500;

export type BoundedList<Row> = Readonly<{
  rows: readonly Row[];
  hasMore: boolean;
}>;

export function boundedListLimit(value: unknown = undefined): number {
  if (value === undefined) return DEFAULT_BOUNDED_LIST_LIMIT;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_BOUNDED_LIST_LIMIT) {
    throw new TypeError(`limit must be an integer from 1 to ${MAX_BOUNDED_LIST_LIMIT}`);
  }
  return value as number;
}

export function projectBoundedList<Row>(rows: readonly Row[], limit: number): BoundedList<Row> {
  const projected = rows.slice(0, limit + 1);
  return { rows: projected.slice(0, limit), hasMore: projected.length > limit };
}
