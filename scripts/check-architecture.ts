import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkArchitecture, type SourceInput } from "./architecture/engine.js";
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

export function runArchitectureCheck(root: string): number {
  const inputs = [
    ...sourceInputs(path.join(root, "src")),
    ...sourceInputs(path.join(root, "scripts"), "scripts"),
  ];
  const result = checkArchitecture(inputs, KEIYAKU_ARCHITECTURE_POLICY);
  if (result.diagnostics.length === 0) {
    const limits = KEIYAKU_ARCHITECTURE_POLICY.limits;
    console.log(`architecture: ok (${result.files.length} files; ${limits.fileLines}/${limits.functionLines}/${limits.complexity}/${limits.nesting}/${limits.parameters})`);
    return 0;
  }
  console.error("architecture: failed");
  for (const diagnostic of result.diagnostics) {
    console.error(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column} [${diagnostic.rule}] ${diagnostic.detail}`);
  }
  return 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  process.exitCode = runArchitectureCheck(path.resolve(process.argv[2] ?? process.cwd()));
}
