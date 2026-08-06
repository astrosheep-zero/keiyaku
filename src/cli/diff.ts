import { createTwoFilesPatch } from "diff";

export function unifiedDiff(before: string, after: string): string {
  if (before === after) return "";
  return createTwoFilesPatch("before", "after", before, after, "", "", { context: 3 });
}
