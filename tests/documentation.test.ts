import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const docs = join(root, "docs");

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "drafts" ? [] : markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

function physicalLines(path: string): number {
  const bytes = readFileSync(path, "utf8");
  if (bytes.length === 0) return 0;
  return bytes.endsWith("\n") ? bytes.split("\n").length - 1 : bytes.split("\n").length;
}

test("formal documentation files do not exceed 400 physical lines", () => {
  const oversized = markdownFiles(docs)
    .map((path) => ({ path: relative(root, path), lines: physicalLines(path) }))
    .filter(({ lines }) => lines > 400)
    .sort((left, right) => left.path.localeCompare(right.path));

  assert.deepEqual(
    oversized,
    [],
    `formal documentation exceeds 400 lines:\n${oversized
      .map(({ path, lines }) => `${path}: ${lines}`)
      .join("\n")}`,
  );
});
