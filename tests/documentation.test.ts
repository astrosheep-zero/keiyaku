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

test("Task tree law is parent decomposition without DAG residue", () => {
  const task = readFileSync(join(docs, "task.md"), "utf8");
  const cli = readFileSync(join(docs, "cli-task.md"), "utf8");
  assert.match(task, /task\.tree\(\): Promise<TaskDecompositionTree>/u);
  assert.match(task, /children: readonly TaskTreeNode\[\]/u);
  assert.doesNotMatch(task, /TaskDependencyTree/u);
  assert.doesNotMatch(task, /task\.tree\(input\?: \{ full\?: boolean \}\)/u);
  assert.match(cli, /task tree <TaskId> \[--json\]/u);
  assert.doesNotMatch(cli, /task tree <TaskId> \[--full\]/u);
  assert.match(cli, /<mark> <complete TaskId> · P<n> <word>/u);
  assert.doesNotMatch(cli, /TaskId - P<n> -/u);
  assert.doesNotMatch(cli, /JSON\.stringify|refused \$\{JSON/u);
  assert.doesNotMatch(cli, /TaskDependencyTree|full vocabulary|\[--full\]/u);
});

test("Task creation actor is optional createdBy with CLI resolveActor precedence", () => {
  const task = readFileSync(join(docs, "task.md"), "utf8");
  const cli = readFileSync(join(docs, "cli-task.md"), "utf8");
  assert.match(task, /optional `createdBy` when present, `createdAt`/u);
  assert.match(task, /Product creation writes it only from caller `actor`/u);
  assert.match(task, /latest-actor field/u);
  assert.match(task, /tasks\.compose\(input: \{ markdown: string; actor\?: string; signal\?: AbortSignal \}\)/u);
  assert.match(cli, /task add <TITLE>.*\[--actor <actor>\]/su);
  assert.match(cli, /task compose \[--actor <actor>\] \[--json\] -/u);
  assert.match(cli, /KEIYAKU_ACTOR_ID/u);
  assert.match(cli, /persisted `createdBy`\nas `created-by <actor>` when present/u);
  assert.match(cli, /list and query text do not\nrender it/u);
  assert.match(cli, /Update, lifecycle, and settlement commands\ndo not accept `--actor`/u);
  assert.doesNotMatch(cli, /KEIYAKU_PROJECTION_ID/u);
  assert.doesNotMatch(task, /KEIYAKU_PROJECTION_ID/u);
});

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
