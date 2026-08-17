import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { FILE_LINE_EXEMPTIONS, FILE_LINES, MARKDOWN_CHARACTERS } from "./maintainability/config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKDOWN_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".keiyaku",
  ".square",
  "build",
  "node_modules",
  "reference",
]);

function exemptionError(exemption, index, seen, rootDirectory) {
  const label = `maintainability exemption ${index + 1}`;
  if (!exemption || typeof exemption !== "object") return `${label} must be an object`;
  const { file, reason } = exemption;
  if (typeof file !== "string" || file.length === 0) return `${label} needs a file`;
  if (path.isAbsolute(file) || path.posix.normalize(file) !== file || /[*?[\]{}!]/.test(file)) {
    return `${label} must use one exact normalized relative file path`;
  }
  if (!file.startsWith("src/") && !file.startsWith("scripts/")) return `${label} must target src/ or scripts/`;
  if (seen.has(file)) return `${label} duplicates ${file}`;
  seen.add(file);
  if (typeof reason !== "string" || reason.trim().length === 0) return `${label} needs a reason`;
  if (!existsSync(path.join(rootDirectory, file))) return `${label} targets missing file ${file}`;
  return null;
}

export function validateExemptions(exemptions, rootDirectory = root) {
  const seen = new Set();
  return exemptions
    .map((exemption, index) => exemptionError(exemption, index, seen, rootDirectory))
    .filter((error) => error !== null);
}

function effectiveLineCount(message) {
  if (message.ruleId !== "max-lines" || message.messageId !== "exceed") return null;
  const match = /^File has too many lines \((\d+)\)\./u.exec(message.message);
  return match === null ? null : Number.parseInt(match[1], 10);
}

export function promoteHardLineLimit(results) {
  return results.map((result) => {
    const messages = result.messages.map((message) =>
      (effectiveLineCount(message) ?? 0) > FILE_LINES.error ? { ...message, severity: 2 } : message);
    return {
      ...result,
      messages,
      errorCount: messages.filter((message) => message.severity === 2).length,
      warningCount: messages.filter((message) => message.severity === 1).length,
    };
  });
}

export function markdownCharacterCount(source) {
  return [...source.replace(/\r\n?|\n/gu, "\n")].length;
}

export function markdownCharacterSeverity(characters) {
  if (characters > MARKDOWN_CHARACTERS.error) return "error";
  if (characters > MARKDOWN_CHARACTERS.warning) return "warning";
  return null;
}

function markdownFiles(directory, relative = "") {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isDirectory() && MARKDOWN_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(absolute, file));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push({ absolute, file });
  }
  return files;
}

export function markdownCharacterFindings(rootDirectory = root) {
  return markdownFiles(rootDirectory).flatMap(({ absolute, file }) => {
    const characters = markdownCharacterCount(readFileSync(absolute, "utf8"));
    const severity = markdownCharacterSeverity(characters);
    return severity === null ? [] : [{ file, characters, severity }];
  });
}

async function run() {
  const configurationErrors = validateExemptions(FILE_LINE_EXEMPTIONS);
  if (configurationErrors.length > 0) {
    console.error("maintainability: invalid exemptions");
    for (const error of configurationErrors) console.error(`- ${error}`);
    return 2;
  }
  if (FILE_LINE_EXEMPTIONS.length === 0) console.log("maintainability exemptions: none");
  else {
    console.log("maintainability exemptions:");
    for (const exemption of FILE_LINE_EXEMPTIONS) {
      console.log(`- ${exemption.file}: max-lines (${exemption.reason})`);
    }
  }

  const eslint = new ESLint({ cwd: root });
  const results = promoteHardLineLimit(await eslint.lintFiles(["src", "scripts"]));
  const formatter = await eslint.loadFormatter("stylish");
  const output = formatter.format(results);
  if (output.length > 0) console.log(output);

  const markdownFindings = markdownCharacterFindings();
  if (markdownFindings.length > 0) {
    console.log("markdown character limits:");
    for (const finding of markdownFindings) {
      const limit = MARKDOWN_CHARACTERS[finding.severity];
      console.log(`- ${finding.severity}: ${finding.file} has ${finding.characters} characters; limit is ${limit}`);
    }
  }

  const eslintFailed = results.some((result) => result.errorCount > 0);
  const markdownFailed = markdownFindings.some((finding) => finding.severity === "error");
  return eslintFailed || markdownFailed ? 1 : 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invoked === fileURLToPath(import.meta.url)) {
  process.exitCode = await run();
}
