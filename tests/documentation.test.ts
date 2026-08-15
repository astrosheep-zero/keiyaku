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

type DocumentationSize = "normal" | "warning" | "error";

function documentationSize(lines: number): DocumentationSize {
  if (lines > 500) return "error";
  if (lines > 400) return "warning";
  return "normal";
}

test("formal documentation line thresholds are exact", () => {
  assert.deepEqual(
    [400, 401, 500, 501].map(documentationSize),
    ["normal", "warning", "warning", "error"],
  );
});

test("formal documentation warns after 400 and fails after 500 physical lines", (context) => {
  const measured = markdownFiles(docs)
    .map((path) => ({ path: relative(root, path), lines: physicalLines(path) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const warnings = measured.filter(({ lines }) => documentationSize(lines) === "warning");
  const oversized = measured.filter(({ lines }) => documentationSize(lines) === "error");

  for (const { path, lines } of warnings) {
    context.diagnostic(`warning: formal documentation exceeds 400 lines: ${path}: ${lines}`);
  }
  assert.deepEqual(
    oversized,
    [],
    `formal documentation exceeds 500 lines:\n${oversized
      .map(({ path, lines }) => `${path}: ${lines}`)
      .join("\n")}`,
  );
});
