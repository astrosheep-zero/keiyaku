import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@typescript-eslint/parser";
import { ESLint } from "eslint";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKDOWN_EXCLUDED_DIRECTORIES = new Set([".git", ".keiyaku", ".square", "build", "node_modules", "reference"]);
const LINE_LIMIT = 500;
const MAX_LINES_RULE = /(?:^|[\s,])max-lines(?=$|[\s,])/u;

export const FILE_LINE_EXCEPTIONS = Object.freeze([
  {
    file: "src/akuma/body.ts",
    ceiling: 531,
    reason: "Akuma Body owns its command lifecycle, event stream, and process custody together.",
  },
  {
    file: "src/akuma/projection.ts",
    ceiling: 518,
    reason: "Akuma projection owns activity decoding and its strict public projection boundary.",
  },
  {
    file: "src/akuma/provider.ts",
    ceiling: 672,
    reason: "Provider custody owns the provider protocol, resume, and restraint boundary as one unit.",
  },
  {
    file: "src/akuma/turn-drive.ts",
    ceiling: 523,
    reason: "Turn drive owns the ordered setup and consumption lifecycle transaction.",
  },
  {
    file: "src/cli/invoke.ts",
    ceiling: 522,
    reason: "Root CLI invocation owns command dispatch across world, context, forwarding, and execution.",
  },
  {
    file: "src/git/repository.ts",
    ceiling: 573,
    reason: "Repository access owns Git discovery, ownership checks, and physical effects together.",
  },
  {
    file: "src/git/target-placement.ts",
    ceiling: 550,
    reason: "Target placement owns delivery target inspection and its placement transaction.",
  },
  {
    file: "src/library/contract-forwarding-result.ts",
    ceiling: 560,
    reason: "Contract forwarding results own journal decoding and public result translation together.",
  },
  {
    file: "src/library/fleet.ts",
    ceiling: 737,
    reason: "Fleet owns the unified public Contract and Akuma operation surface.",
  },
]);

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

const productionFiles = (rootDirectory) =>
  ["src", "scripts"]
    .flatMap((directory) =>
      files(path.join(rootDirectory, directory), directory, (name) => /\.(?:ts|js|mjs)$/u.test(name)),
    )
    .sort((left, right) => left.file.localeCompare(right.file));

export const physicalLineCount = (source) =>
  source.length === 0 ? 0 : source.split(/\r\n?|\n/u).length - Number(/(?:\r\n?|\n)$/u.test(source));

export function validateFileLineExceptions(exceptions, knownFiles) {
  const known = new Set(knownFiles.map(({ file }) => file));
  const seen = new Set();
  return exceptions.flatMap((exception, index) => {
    const { file, ceiling, reason } = exception ?? {};
    const valid =
      exception !== null &&
      typeof exception === "object" &&
      typeof file === "string" &&
      Number.isInteger(ceiling) &&
      typeof reason === "string";
    const kind = !valid
      ? "malformed"
      : /[*?\[\]{}]/u.test(file)
        ? "wildcard"
        : seen.has(file)
          ? "duplicate"
          : !known.has(file)
            ? "unknown"
            : ceiling < LINE_LIMIT
              ? "below-limit"
              : reason.trim().length === 0
                ? "malformed"
                : null;
    if (valid) seen.add(file);
    return kind === null ? [] : [{ kind, file: kind === "malformed" ? undefined : file, index }];
  });
}

export function productionFileLineFindings(rootDirectory = root, exceptions = FILE_LINE_EXCEPTIONS) {
  const sourceFiles = productionFiles(rootDirectory);
  const exceptionFindings = validateFileLineExceptions(exceptions, sourceFiles);
  const accepted =
    exceptionFindings.length === 0 ? new Map(exceptions.map((exception) => [exception.file, exception])) : new Map();
  const fileFindings = [];
  const disableFindings = [];
  for (const { absolute, file } of sourceFiles) {
    const source = readFileSync(absolute, "utf8");
    const lines = physicalLineCount(source);
    const exception = accepted.get(file);
    if (lines >= LINE_LIMIT && (exception === undefined || lines > exception.ceiling)) {
      fileFindings.push({ file, lines, ceiling: exception?.ceiling ?? LINE_LIMIT });
    }
    for (const comment of parse(source, { comment: true, loc: true, sourceType: "module" }).comments) {
      const directive = comment.value.trimStart();
      if (/^eslint-disable(?:-next-line|-line)?(?:\s|,)/u.test(directive) && MAX_LINES_RULE.test(directive)) {
        disableFindings.push({ file, line: comment.loc.start.line });
      }
    }
  }
  return { disableFindings, exceptionFindings, fileFindings };
}

function reportFindings(label, findings, render) {
  if (findings.length === 0) return;
  console.log(label);
  for (const finding of findings) console.log(`- ${render(finding)}`);
}

export const markdownCharacterCount = (source) => [...source.replace(/\r\n?|\n/gu, "\n")].length;
export const markdownCharacterSeverity = (characters) =>
  characters > 30_000 ? "error" : characters > 20_000 ? "warning" : null;

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
  const output = (await eslint.loadFormatter("stylish")).format(results);
  if (output.length > 0) console.log(output);
  const checks = productionFileLineFindings();
  reportFindings(
    "production file line exceptions:",
    checks.exceptionFindings,
    (finding) => `${finding.kind}: ${finding.file ?? finding.index}`,
  );
  reportFindings(
    "production file line limits:",
    checks.fileFindings,
    (finding) => `${finding.file} has ${finding.lines} lines; limit is ${finding.ceiling}`,
  );
  reportFindings(
    "source-local max-lines disables:",
    checks.disableFindings,
    (finding) => `${finding.file}:${finding.line}`,
  );
  const markdownFindings = markdownCharacterFindings();
  reportFindings(
    "markdown character limits:",
    markdownFindings,
    (finding) =>
      `${finding.severity}: ${finding.file} has ${finding.characters} characters; limit is ${finding.severity === "error" ? 30_000 : 20_000}`,
  );
  return results.some((result) => result.errorCount > 0) ||
    markdownFindings.some((finding) => finding.severity === "error") ||
    checks.exceptionFindings.length > 0 ||
    checks.fileFindings.length > 0 ||
    checks.disableFindings.length > 0
    ? 1
    : 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invoked === fileURLToPath(import.meta.url)) process.exitCode = await run();
