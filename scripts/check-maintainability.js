import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKDOWN_EXCLUDED_DIRECTORIES = new Set([".git", ".keiyaku", ".square", "build", "node_modules", "reference"]);

/** @typedef {{absolute: string, file: string}} FileEntry */

/** @param {string} directory @param {string} relative @param {(name: string) => boolean} matches @param {Set<string>} [excluded] @returns {FileEntry[]} */
function files(directory, relative, matches, excluded = new Set()) {
  if (!existsSync(directory)) return [];
  const found = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!excluded.has(entry.name))
        found.push(
          ...files(path.join(directory, entry.name), path.posix.join(relative, entry.name), matches, excluded),
        );
    } else if (entry.isFile() && matches(entry.name)) {
      found.push({ absolute: path.join(directory, entry.name), file: path.posix.join(relative, entry.name) });
    }
  }
  return found;
}

/** @template {Record<string, unknown>} T @param {string} label @param {ReadonlyArray<T>} findings @param {(finding: T) => string} render */
function reportFindings(label, findings, render) {
  if (findings.length === 0) return;
  console.log(label);
  for (const finding of findings) console.log(`- ${render(finding)}`);
}

/** @param {string} source */
export const markdownCharacterCount = (source) => [...source.replace(/\r\n?|\n/gu, "\n")].length;
/** @param {number} characters @returns {"error" | "warning" | null} */
export const markdownCharacterSeverity = (characters) =>
  characters > 30_000 ? "error" : characters > 20_000 ? "warning" : null;

/** @param {string} [rootDirectory] */
export function markdownCharacterFindings(rootDirectory = root) {
  return files(rootDirectory, "", (name) => name.endsWith(".md"), MARKDOWN_EXCLUDED_DIRECTORIES).flatMap(
    ({ absolute, file }) => {
      const characters = markdownCharacterCount(readFileSync(absolute, "utf8"));
      const severity = markdownCharacterSeverity(characters);
      return severity === null ? [] : [{ file, characters, severity }];
    },
  );
}

async function run() {
  const eslint = new ESLint({ cwd: root });
  const results = await eslint.lintFiles(["src", "scripts"]);
  const output = await (await eslint.loadFormatter("stylish")).format(results);
  if (output.length > 0) console.log(output);
  const markdownFindings = markdownCharacterFindings();
  reportFindings(
    "markdown character limits:",
    markdownFindings,
    (finding) =>
      `${finding.severity}: ${finding.file} has ${finding.characters} characters; limit is ${finding.severity === "error" ? 30_000 : 20_000}`,
  );
  return results.some((result) => result.errorCount > 0) ||
    markdownFindings.some((finding) => finding.severity === "error")
    ? 1
    : 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invoked === fileURLToPath(import.meta.url)) process.exitCode = await run();
