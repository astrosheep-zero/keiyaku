import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { FILE_LINE_EXEMPTIONS, FILE_LINES } from "./maintainability/config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  return results.some((result) => result.errorCount > 0) ? 1 : 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invoked === fileURLToPath(import.meta.url)) {
  process.exitCode = await run();
}
