import { createTwoFilesPatch } from "diff";

export function documentDiff(beforePath: string, afterPath: string, before: string, after: string): string {
  return before === after ? "" : createTwoFilesPatch(beforePath, afterPath, before, after, "", "", { context: 3 });
}
