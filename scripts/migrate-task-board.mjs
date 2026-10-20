import { cp, lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isMap, isScalar, parse as parseYaml, parseDocument } from "yaml";

const IDENTITY_FIELDS = ["id", "needs", "parent", "supersedes", "relates"];
const REMOVED_STATES = new Map([
  ["in_progress", "open"],
  ["on_hold", "open"],
]);
const FRONT_MATTER = /^(---\r?\n)([\s\S]*?)^(---[^\S\r\n]*(?:\r?\n|$))/m;

/** @param {string} path */
async function absent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Migration destination already exists: ${path}`);
}

/** @param {unknown} text */
function substitute(text) {
  return typeof text === "string" ? text.replace(/(?<![\w./-])task\//gu, "debt/") : text;
}

/** @param {unknown} value */
function convertIdentity(value) {
  if (value === null || typeof value !== "string") return value;
  const converted = substitute(value);
  if (typeof converted !== "string") return converted;
  if (value.startsWith("task/") && !converted.startsWith("debt/"))
    throw new Error(`Identity was not renamed: ${value}`);
  return converted;
}

/**
 * @param {string} field
 * @param {unknown} value
 */
function expectedValue(field, value) {
  if (field === "state") {
    const plain = typeof value === "string" ? value : String(value);
    return REMOVED_STATES.get(plain) ?? value;
  }
  if (field === "needs" || field === "supersedes" || field === "relates") {
    if (!Array.isArray(value)) throw new Error(`${field} is not a sequence`);
    return value.map(convertIdentity);
  }
  return convertIdentity(value);
}

/**
 * Rename one ledger document. Field classification reads the parsed YAML mapping
 * and its source ranges, never a line-shaped guess, so quoted keys and quoted
 * values cannot be mistaken for each other.
 * @param {string} source
 */
function migrateDocument(source) {
  const match = FRONT_MATTER.exec(source);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined)
    throw new Error("Missing ledger front matter");
  const header = match[2];
  const document = parseDocument(header, { strict: true });
  const firstError = document.errors[0];
  if (firstError !== undefined) throw new Error(`Unreadable ledger front matter: ${firstError.message}`);
  const contents = document.contents;
  if (!isMap(contents)) throw new Error("Ledger front matter is not a mapping");

  /** @type {{ start: number, end: number, replacement: string }[]} */
  const edits = [];
  for (const pair of contents.items) {
    const key = pair.key;
    if (!isScalar(key) || typeof key.value !== "string") throw new Error("Ledger front matter has a non-scalar key");
    const field = key.value;
    if (!IDENTITY_FIELDS.includes(field) && field !== "state") continue;
    const range = pair.value?.range;
    if (range === null || range === undefined) continue;
    const text = header.slice(range[0], range[1]);
    if (field === "state") {
      const replacement = text.replace(/^(?<quote>["']?)(?:in_progress|on_hold)\k<quote>$/u, "$1open$1");
      if (replacement !== text) edits.push({ start: range[0], end: range[1], replacement });
      continue;
    }
    if (!text.includes("task/")) continue;
    const replacement = substitute(text);
    if (typeof replacement === "string" && replacement !== text)
      edits.push({ start: range[0], end: range[1], replacement });
  }
  let converted = header;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    converted = converted.slice(0, edit.start) + edit.replacement + converted.slice(edit.end);

  // Prove the conversion before any byte reaches the new board: the parsed
  // result must equal the expected rename of the original, nothing else.
  const before = parseYaml(header);
  const after = parseYaml(converted);
  if (before === null || typeof before !== "object" || after === null || typeof after !== "object")
    throw new Error("Ledger front matter did not parse as a mapping");
  /** @type {Record<string, unknown>} */
  const expected = {};
  for (const [field, value] of Object.entries(before))
    expected[field] = IDENTITY_FIELDS.includes(field) || field === "state" ? expectedValue(field, value) : value;
  const got = /** @type {Record<string, unknown>} */ (after);
  for (const [field, value] of Object.entries(expected)) {
    if (JSON.stringify(got[field]) !== JSON.stringify(value))
      throw new Error(`Conversion changed an unpermitted fact: ${field}`);
  }
  if (Object.keys(got).length !== Object.keys(expected).length) throw new Error("Conversion changed the field set");
  const body = source.slice(match[1].length + header.length + match[3].length);
  return { bytes: match[1] + converted + match[3] + body, after: got };
}

/**
 * A document's authority path is assembled from the names walked to reach it,
 * always slash-separated. Native path syntax never reaches the comparison, so
 * a namespaced board cannot disagree with itself on Windows.
 * @param {string} directory
 * @param {readonly string[]} [ancestors]
 */
async function rewrite(directory, ancestors = []) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Migration refuses symlink: ${path}`);
    if (entry.isDirectory()) count += await rewrite(path, [...ancestors, entry.name]);
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      const { bytes, after } = migrateDocument(await readFile(path, "utf8"));
      const identity = after.id;
      if (typeof identity !== "string" || !identity.startsWith("debt/"))
        throw new Error(`Ledger document has no converted identity: ${path}`);
      const authority = `debt/${[...ancestors, entry.name.replace(/\.md$/u, "")].join("/")}`;
      if (identity !== authority)
        throw new Error(`Ledger identity does not match its authority path: ${path}`);
      await writeFile(path, bytes);
      count++;
    }
  }
  return count;
}

/**
 * Offline upgrade: stop ledger writers first. Copies, converts and proves the
 * whole board, then installs it in one move and keeps the original bytes.
 * @param {string} world
 */
export async function migrateTaskBoard(world) {
  const root = resolve(world, ".keiyaku");
  const source = join(root, "tasks");
  const destination = join(root, "debts");
  const backup = join(root, "tasks.pre-debt");
  const stat = await lstat(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid ledger directory: ${source}`);
  await absent(destination);
  await absent(backup);
  const temporary = await mkdtemp(join(root, ".debt-migration-"));
  try {
    await cp(source, temporary, {
      recursive: true,
      filter: async (path) => {
        if ((await lstat(path)).isSymbolicLink()) throw new Error(`Migration refuses symlink: ${path}`);
        return true;
      },
    });
    const count = await rewrite(temporary);
    await rename(source, backup);
    try {
      await rename(temporary, destination);
    } catch (error) {
      await rename(backup, source);
      throw error;
    }
    return { count, backup };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const world = process.argv[2];
  if (process.argv.length !== 3 || world === undefined)
    throw new Error("usage: node scripts/migrate-task-board.mjs <world-directory>");
  const { count, backup } = await migrateTaskBoard(world);
  console.log(`Migrated ${count} ledger documents; original bytes: ${backup}`);
}
