import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkArchitecture, type Diagnostic, type SourceInput } from "./architecture/engine.js";
import { KEIYAKU_ARCHITECTURE_POLICY } from "./architecture/policy.js";

function sourceInputs(directory: string, prefix = ""): SourceInput[] {
  const inputs: SourceInput[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) inputs.push(...sourceInputs(absolute, relative));
    else if (entry.isFile() && /\.(?:cts|mts|ts|tsx)$/.test(entry.name)) {
      inputs.push({ path: relative, source: readFileSync(absolute, "utf8") });
    }
  }
  return inputs.sort((left, right) => left.path.localeCompare(right.path));
}

const RETIRED_MODEL_NAMES = ["Commit" + "Oid", "Patch" + "Id", "ful" + "filled"] as const;
export const PRODUCTION_LINE_LIMIT = 20_000;

function physicalLines(source: string): number {
  if (source.length === 0) return 0;
  const lines = source.split(/\r\n|\r|\n/).length;
  return /(?:\r\n|\r|\n)$/.test(source) ? lines - 1 : lines;
}

export function productionLineBudgetDiagnostic(
  inputs: readonly SourceInput[],
  limit = PRODUCTION_LINE_LIMIT,
): Diagnostic | null {
  const lines = inputs
    .filter((input) => !input.path.startsWith("scripts/"))
    .reduce((total, input) => total + physicalLines(input.source), 0);
  if (lines <= limit) return null;
  return {
    rule: "architecture/production-line-budget",
    file: "src",
    line: 1,
    column: 1,
    detail: `production TypeScript is ${lines} lines; limit is ${limit}`,
  };
}

function retiredModelDiagnostics(inputs: readonly SourceInput[]): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const input of inputs) {
    for (const name of RETIRED_MODEL_NAMES) {
      const pattern = new RegExp(`\\b${name}\\b`, "g");
      for (const match of input.source.matchAll(pattern)) {
        const offset = match.index;
        if (offset === undefined) continue;
        const before = input.source.slice(0, offset);
        const line = before.split("\n").length;
        const column = offset - before.lastIndexOf("\n");
        diagnostics.push({
          rule: "architecture/retired-model-name",
          file: input.path,
          line,
          column,
          detail: `removed model name: ${name}`,
        });
      }
    }
  }
  return diagnostics;
}

export function runArchitectureCheck(root: string): number {
  const inputs = [
    ...sourceInputs(path.join(root, "src")),
    ...sourceInputs(path.join(root, "scripts"), "scripts"),
  ];
  const result = checkArchitecture(inputs, KEIYAKU_ARCHITECTURE_POLICY);
  const lineBudget = productionLineBudgetDiagnostic(inputs);
  const diagnostics = [
    ...result.diagnostics,
    ...retiredModelDiagnostics(inputs),
    ...(lineBudget === null ? [] : [lineBudget]),
  ];
  if (diagnostics.length === 0) {
    console.log(`architecture: ok (${result.files.length} files)`);
    return 0;
  }
  console.error("architecture: failed");
  for (const diagnostic of diagnostics) {
    console.error(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column} [${diagnostic.rule}] ${diagnostic.detail}`);
  }
  return 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  process.exitCode = runArchitectureCheck(path.resolve(process.argv[2] ?? process.cwd()));
}
