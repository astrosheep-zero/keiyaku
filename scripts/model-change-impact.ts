import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeModelImpact, type FieldSnapshot, type ModelImpactReport, type ModelSource } from "./model-impact/engine.js";
import { MODEL_IMPACT_POLICY } from "./model-impact/policy.js";

type Options = Readonly<{ base: string; head: string; json: boolean }>;

function parseOptions(argv: readonly string[]): Options {
  let base = "HEAD";
  let head = "worktree";
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--json") json = true;
    else if (value === "--base" || value === "--head") {
      const argument = argv[index + 1];
      if (!argument) throw new Error(`${value} requires a value`);
      if (value === "--base") base = argument;
      else head = argument;
      index += 1;
    } else throw new Error(`unknown argument: ${value}`);
  }
  return { base, head, json };
}

function worktreeSources(root: string, directory = "src"): readonly ModelSource[] {
  const absolute = path.join(root, directory);
  const inputs: ModelSource[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) inputs.push(...worktreeSources(root, relative));
    else if (entry.isFile() && /\.(?:cts|mts|ts|tsx)$/.test(entry.name)) {
      inputs.push({ path: relative, source: readFileSync(path.join(root, relative), "utf8") });
    }
  }
  return inputs.sort((left, right) => left.path.localeCompare(right.path));
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function revisionSources(root: string, revision: string): readonly ModelSource[] {
  git(root, ["rev-parse", "--verify", `${revision}^{commit}`]);
  const files = git(root, ["ls-tree", "-r", "--name-only", revision, "--", "src"])
    .split("\n")
    .filter((file) => /\.(?:cts|mts|ts|tsx)$/.test(file));
  return files.map((file) => ({ path: file, source: git(root, ["show", `${revision}:${file}`]) }));
}

function snapshotLines(label: "before" | "after", value: FieldSnapshot | undefined): readonly string[] {
  if (!value) return [];
  const consumers = value.usages.filter((usage) => usage.kind !== "declaration");
  const lines = [`  ${label}: ${value.signature}`];
  for (const usage of consumers) lines.push(`    ${usage.kind.padEnd(11)} ${usage.owner.padEnd(16)} ${usage.file}:${usage.line}:${usage.column}`);
  return lines;
}

export function renderModelImpact(report: ModelImpactReport): string {
  const lines = [`model-impact: ${report.base} -> ${report.head} (${report.fields.length} exported fields changed)`, "report-only: fan-out never changes the exit code"];
  for (const field of report.fields) {
    lines.push("");
    lines.push(`${field.owners.length > 1 ? "!" : "-"} ${field.change} ${field.key}`);
    lines.push(`  reach: ${field.files.length} consumer files / ${field.owners.length} owners${field.owners.length ? ` (${field.owners.join(", ")})` : ""}`);
    lines.push(...snapshotLines("before", field.before));
    lines.push(...snapshotLines("after", field.after));
  }
  return lines.join("\n");
}

export function runModelImpact(root: string, argv: readonly string[]): number {
  try {
    const options = parseOptions(argv);
    const base = revisionSources(root, options.base);
    const head = options.head === "worktree" ? worktreeSources(root) : revisionSources(root, options.head);
    const report = analyzeModelImpact(base, head, { base: options.base, head: options.head }, MODEL_IMPACT_POLICY);
    console.log(options.json ? JSON.stringify(report, null, 2) : renderModelImpact(report));
    return 0;
  } catch (error) {
    console.error(`model-impact: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  process.exitCode = runModelImpact(process.cwd(), process.argv.slice(2));
}
