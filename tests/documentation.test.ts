import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const docs = join(root, "docs");

test("owner documents keep Contract history a same-snapshot two-authority projection", () => {
  const model = readFileSync(join(docs, "model.md"), "utf8");
  const dispatch = readFileSync(join(docs, "dispatch.md"), "utf8");
  const api = readFileSync(join(docs, "public-api.md"), "utf8");
  const cli = readFileSync(join(docs, "cli.md"), "utf8");
  const output = readFileSync(join(docs, "cli-output.md"), "utf8");
  assert.match(model, /one `GitReadObservation` of\nkeiyaku-state/u);
  assert.match(model, /journal before Dispatch on equal\ntimestamps/u);
  assert.match(model, /presentation only and asserts no causality/u);
  assert.match(model, /no global cursor, reverse index, or expansion of\nAkuma Heart history/u);
  assert.match(dispatch, /same observation that\nsupplies the selected journal/u);
  assert.match(dispatch, /does not invent a reverse index/u);
  assert.match(api, /keiyaku\.history\(\): Promise<ContractHistory>/u);
  assert.match(api, /needs no WorldRoot or Akuma\nSettings/u);
  assert.match(api, /Static `Keiyaku\.history` remains the unchanged Akuma operation/u);
  assert.match(cli, /history <aku\/\.\.\.\|@alias\|kei\/\.\.\.>/u);
  assert.match(cli, /refuses `--before`, `--since`, `--limit`, and `--last`/u);
  assert.match(cli, /with no Akuma World/u);
  assert.match(output, /history <kei\/\.\.\.> · <J> journal · <D> dispatch/u);
  assert.match(output, /JSON is the exact `ContractHistory` value/u);
});

test("Akuma owner law records the settled snapshot timeline", () => {
  const output = readFileSync(join(docs, "cli-output.md"), "utf8");
  const cli = readFileSync(join(docs, "cli.md"), "utf8");
  assert.match(output, /snapshot/u);
  assert.match(output, /opening stroke/u);
  assert.match(output, /time gutter/u);
  assert.match(output, /Event glyphs/u);
  assert.match(output, /place life/u);
  assert.match(output, /history omit/u);
  assert.match(output, /ordinary single-target wait that observes/u);
  assert.match(output, /unfinished or\nnon-answered single wait/u);
  assert.match(output, /Multi-target wait remains identity-bearing snapshots/u);
  assert.match(output, /explicit exact read independent of waiting/u);
  assert.match(cli, /cli-output\.md/u);
});

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

test("cli-output owns the Contract mutation receipt grammar", () => {
  const text = readFileSync(join(docs, "cli-output.md"), "utf8");
  assert.match(text, /✓ <verb> accepted/);
  assert.match(text, /! <verb> refused/);
  assert.match(text, /\? <verb> retry/);
  assert.match(text, /! claim <typed stop kind and exact scalar facts>/);
  assert.match(text, /~ workspace <N files changed, N insertions\(\+\), N deletions\(-\)>/);
  assert.match(text, /label `claim`/);
  assert.match(text, /mine ~ theirs/);
  assert.match(text, /byte-for-byte the serialization of that same public value/);
  assert.match(text, /closed union discriminated by the\nliteral verbs `bind`, `amend`, `deliver`, `review`, `arc`, `abandon`, and\n`audit`/);
  assert.match(text, /exhaustive on `verb`/);
  assert.match(text, /opaque Contract ID/);
  assert.match(text, /addressed Contract coordinate appears once/);
});

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
