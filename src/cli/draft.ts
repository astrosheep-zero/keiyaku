import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { repairDerivedFile, replaceFileDurably } from "../coordination/durable-file.js";
import type { WorldRoot } from "../world.js";
import type { BindDraftReceipt } from "./result.js";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DRAFT_NAME = /^bind-[0-9a-f]{64}\.md$/u;

export class BindDraftError extends Error {
  readonly original: unknown;
  readonly draft: BindDraftReceipt;

  constructor(original: unknown, draft: BindDraftReceipt) {
    super(original instanceof Error ? original.message : String(original));
    this.name = "BindDraftError";
    this.original = original;
    this.draft = draft;
  }
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sweep(directory: string, now: number): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !DRAFT_NAME.test(entry.name)) continue;
    const path = join(directory, entry.name);
    try {
      if (now - lstatSync(path).mtimeMs > RETENTION_MS) unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function preserveBindDraft(
  world: WorldRoot,
  markdown: string,
  now = Date.now(),
): Promise<BindDraftReceipt> {
  const digest = createHash("sha256").update(markdown, "utf8").digest("hex");
  const name = `bind-${digest}.md`;
  const relativePath = `.keiyaku/draft/${name}`;
  const directory = join(world, ".keiyaku", "draft");
  const path = join(directory, name);
  const warnings: string[] = [];

  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    return { warning: `bind draft could not be preserved: ${diagnostic(error)}` };
  }

  try {
    await repairDerivedFile(join(directory, ".gitignore"), "*\n");
  } catch (error) {
    warnings.push(`bind draft ignore could not be maintained: ${diagnostic(error)}`);
  }

  try {
    let equal = false;
    try {
      const status = lstatSync(path);
      equal = status.isFile() && !status.isSymbolicLink() && readFileSync(path).equals(Buffer.from(markdown));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (equal) {
      try {
        const touched = new Date(now);
        utimesSync(path, touched, touched);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await replaceFileDurably(path, markdown);
      }
    } else {
      await replaceFileDurably(path, markdown);
    }
    if (!readFileSync(path).equals(Buffer.from(markdown))) {
      throw new Error(`bind draft bytes do not match their content address: ${relativePath}`);
    }
  } catch (error) {
    warnings.push(`bind draft could not be preserved: ${diagnostic(error)}`);
    return { warning: warnings.join("; ") };
  }

  try {
    sweep(directory, now);
  } catch (error) {
    warnings.push(`bind draft sweep failed: ${diagnostic(error)}`);
  }

  return {
    path: relativePath,
    ...(warnings.length === 0 ? {} : { warning: warnings.join("; ") }),
  };
}
