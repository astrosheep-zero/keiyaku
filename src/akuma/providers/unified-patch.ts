export function diffstatFromUnifiedPatch(
  patch: string,
): Readonly<{ added: number; removed: number }> | undefined {
  const lines = patch.split("\n");
  if (!lines.some((line) => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(line))) return undefined;
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}
