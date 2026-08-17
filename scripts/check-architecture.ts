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
  const diagnostics = [
    ...result.diagnostics,
    ...retiredModelDiagnostics(inputs),
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
