import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint, Linter } from "eslint";
import parser from "@typescript-eslint/parser";
import { FILE_LINE_EXEMPTIONS, FILE_LINES, MARKDOWN_CHARACTERS } from "./maintainability/config.js";
import { effectiveFileLineCount, effectiveFunctionLineCount, functionName, functionVisitor } from "./maintainability/functions.js";

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
  const { file, reason, maxEffectiveLines, functions } = exemption;
  if (typeof file !== "string" || file.length === 0) return `${label} needs a file`;
  if (path.isAbsolute(file) || path.posix.normalize(file) !== file || /[*?[\]{}!]/.test(file)) {
    return `${label} must use one exact normalized relative file path`;
  }
  if (!file.startsWith("src/") && !file.startsWith("scripts/")) return `${label} must target src/ or scripts/`;
  if (seen.has(file)) return `${label} duplicates ${file}`;
  seen.add(file);
  const target = path.join(rootDirectory, file);
  if (!existsSync(target)) return `${label} targets missing file ${file}`;
  if (!statSync(target).isFile()) return `${label} targets non-file path ${file}`;
  if (typeof reason !== "string" || reason.trim().length === 0) return `${label} needs a reason`;
  if (maxEffectiveLines !== undefined && (!Number.isSafeInteger(maxEffectiveLines) || maxEffectiveLines <= FILE_LINES.error)) {
    return `${label} needs a useful maxEffectiveLines cap above ${FILE_LINES.error}`;
  }
  if (maxEffectiveLines === undefined && functions === undefined) {
    return `${label} needs a useful maxEffectiveLines cap above ${FILE_LINES.error}`;
  }
  if (functions !== undefined) {
    if (!Array.isArray(functions) || functions.length === 0) return `${label} functions must be a non-empty array`;
    for (const [functionIndex, functionExemption] of functions.entries()) {
      const functionLabel = `${label} function ${functionIndex + 1}`;
      if (!functionExemption || typeof functionExemption !== "object") return `${functionLabel} must be an object`;
      if (typeof functionExemption.name !== "string" || functionExemption.name.trim().length === 0) {
        return `${functionLabel} needs a name`;
      }
      if (typeof functionExemption.reason !== "string" || functionExemption.reason.trim().length === 0) {
        return `${functionLabel} needs a reason`;
      }
      if (!Number.isSafeInteger(functionExemption.maxEffectiveLines) || functionExemption.maxEffectiveLines <= 80) {
        return `${functionLabel} needs a useful maxEffectiveLines cap above 80`;
      }
    }
  }
  return null;
}

const staleMeasurementBaseConfig = Object.freeze({
  files: ["**/*.js", "**/*.ts"],
  languageOptions: {
    parser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
  plugins: {
    maintainability: { rules: {} },
  },
  rules: {},
});

function staleExemptionErrors(exemptions, rootDirectory) {
  const linter = new Linter();
  return exemptions.flatMap((exemption, index) => {
    const source = readFileSync(path.join(rootDirectory, exemption.file), "utf8");
    let fileLines = null;
    const functionMeasurements = [];
    const measurementRule = {
      meta: { schema: [] },
      create(context) {
        return {
          Program: () => { fileLines = effectiveFileLineCount(context.sourceCode); },
          ...functionVisitor((node) => {
            const name = functionName(node);
            if (name !== null) functionMeasurements.push({ name, lines: effectiveFunctionLineCount(node, context.sourceCode) });
          }),
        };
      },
    };
    const config = {
      ...staleMeasurementBaseConfig,
      plugins: { maintainability: { rules: { "measure-exemptions": measurementRule } } },
      rules: { "maintainability/measure-exemptions": "warn" },
    };
    const messages = linter.verify(source, [config], { filename: exemption.file });
    const parseError = messages.find(({ ruleId }) => ruleId === null);
    if (parseError) return [`maintainability exemption ${index + 1} cannot measure ${exemption.file}: ${parseError.message}`];

    const errors = [];
    if (exemption.maxEffectiveLines !== undefined) {
      if (fileLines <= FILE_LINES.warning) {
        errors.push(`maintainability exemption ${index + 1} file ${exemption.file} is stale at ${fileLines} effective lines; it must exceed ${FILE_LINES.warning}`);
      }
    }
    for (const functionExemption of exemption.functions ?? []) {
      const measurement = functionMeasurements.find(({ name }) => name === functionExemption.name);
      if (measurement === undefined) {
        errors.push(`maintainability exemption ${index + 1} function ${functionExemption.name} was not found in ${exemption.file}`);
      } else if (measurement.lines <= 80) {
        errors.push(`maintainability exemption ${index + 1} function ${functionExemption.name} in ${exemption.file} is stale at ${measurement.lines} effective lines; it must exceed 80`);
      }
    }
    return errors;
  });
}

export function validateExemptions(exemptions, rootDirectory = root) {
  const seen = new Set();
  const errors = exemptions
    .map((exemption, index) => exemptionError(exemption, index, seen, rootDirectory))
    .filter((error) => error !== null);
  return errors.length > 0 ? errors : staleExemptionErrors(exemptions, rootDirectory);
}

function effectiveLineCount(message) {
  if (message.ruleId !== "max-lines" || message.messageId !== "exceed") return null;
  const match = /^File has too many lines \((\d+)\)\./u.exec(message.message);
  return match === null ? null : Number.parseInt(match[1], 10);
}

export function promoteHardLineLimit(results) {
  return results.map((result) => {
    const file = path.relative(root, result.filePath ?? "").split(path.sep).join("/");
    const exemption = FILE_LINE_EXEMPTIONS.find((entry) => entry.file === file);
    const limit = exemption?.maxEffectiveLines ?? FILE_LINES.error;
    const messages = result.messages.map((message) =>
      (effectiveLineCount(message) ?? 0) > limit ? { ...message, severity: 2 } : message);
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
      if (exemption.maxEffectiveLines !== undefined) {
        console.log(`- ${exemption.file}: ${exemption.maxEffectiveLines} max-lines (${exemption.reason})`);
      } else {
        console.log(`- ${exemption.file}: function exemptions (${exemption.reason})`);
      }
      for (const functionExemption of exemption.functions ?? []) {
        console.log(`  - ${functionExemption.name}: ${functionExemption.maxEffectiveLines} max-lines-per-function (${functionExemption.reason})`);
      }
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
