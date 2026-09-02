import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BindDraftError, preserveBindDraft } from "../src/cli/draft.js";
import { renderBindDraftReceipt } from "../src/cli/render/refusal.js";
import { World, type WorldRoot } from "../src/world.js";

async function draftWorld(): Promise<WorldRoot> {
  return World.at(mkdtempSync(join(tmpdir(), "keiyaku-bind-draft-")));
}

test("bind draft receipts are content-addressed, exact, and idempotent", async () => {
  const world = await draftWorld();
  const firstBytes = "# First\r\n\r\nexact bytes\r\n";
  const secondBytes = "# Second\n\nother bytes\n";

  const first = await preserveBindDraft(world, firstBytes);
  const second = await preserveBindDraft(world, secondBytes);
  const repeated = await preserveBindDraft(world, firstBytes);

  assert.match(first.path ?? "", /^\.keiyaku\/draft\/bind-[0-9a-f]{64}\.md$/u);
  assert.match(second.path ?? "", /^\.keiyaku\/draft\/bind-[0-9a-f]{64}\.md$/u);
  assert.notEqual(first.path, second.path);
  assert.equal(repeated.path, first.path);
  assert.equal(readFileSync(resolve(world, first.path!), "utf8"), firstBytes);
  assert.equal(readFileSync(resolve(world, second.path!), "utf8"), secondBytes);
  assert.equal(readFileSync(resolve(world, ".keiyaku/draft/.gitignore"), "utf8"), "*\n");
});

test("bind draft preservation repairs corrupted content and renews equal receipt custody", async () => {
  const world = await draftWorld();
  const bytes = "same refused input\n";
  const first = await preserveBindDraft(world, bytes);
  if (first.path === undefined) throw new Error(first.warning);
  const path = resolve(world, first.path);
  writeFileSync(path, "corrupt");

  const repaired = await preserveBindDraft(world, bytes);
  assert.equal(repaired.path, first.path);
  assert.equal(readFileSync(path, "utf8"), bytes);

  const now = Date.now();
  const expired = new Date(now - 8 * 24 * 60 * 60 * 1_000);
  utimesSync(path, expired, expired);
  const renewed = await preserveBindDraft(world, bytes, now);
  assert.equal(renewed.path, first.path);
  await preserveBindDraft(world, "another failure\n", now + 1);
  assert.equal(readFileSync(path, "utf8"), bytes);
});

test("a successful draft write sweeps only expired content-addressed bind drafts", async () => {
  const world = await draftWorld();
  const directory = resolve(world, ".keiyaku/draft");
  mkdirSync(directory, { recursive: true });
  const expired = resolve(directory, `bind-${"0".repeat(64)}.md`);
  const unrelated = resolve(directory, "notes.md");
  writeFileSync(expired, "expired");
  writeFileSync(unrelated, "keep");
  const now = Date.now();
  utimesSync(expired, new Date(now - 8 * 24 * 60 * 60 * 1_000), new Date(now - 8 * 24 * 60 * 60 * 1_000));

  const receipt = await preserveBindDraft(world, "fresh\n", now);

  assert.notEqual(receipt.path, undefined);
  assert.equal(existsSync(expired), false);
  assert.equal(readFileSync(unrelated, "utf8"), "keep");
});

test("BindDraftError keeps the combined original message and exact draft receipt", async () => {
  const world = await draftWorld();
  const bytes = "---\r\na: [\r\nb: {\r\n---\r\n";
  const combined = ["first diagnostic", "second diagnostic"].join("\n");
  const original = new TypeError(combined);
  const draft = await preserveBindDraft(world, bytes);
  const error = new BindDraftError(original, draft);

  assert.equal(error.message, combined);
  assert.equal(error.original, original);
  assert.equal(error.draft, draft);
  if (draft.path === undefined) throw new Error(draft.warning);
  assert.equal(readFileSync(resolve(world, draft.path), "utf8"), bytes);
});

test("BindDraftError keeps the original failure when draft custody is a warning", async () => {
  const world = await draftWorld();
  writeFileSync(resolve(world, ".keiyaku/draft"), "not a directory");
  const original = new TypeError("first diagnostic\nsecond diagnostic");
  const draft = await preserveBindDraft(world, "cannot persist\n");
  const error = new BindDraftError(original, draft);

  assert.equal(error.message, original.message);
  assert.equal(error.original, original);
  assert.equal(error.draft.path, undefined);
  assert.match(error.draft.warning ?? "", /could not be preserved/u);
  assert.match(renderBindDraftReceipt(error.draft), /^warning: /u);
});

test("draft custody failures become warnings instead of replacing bind failure", async () => {
  const world = await draftWorld();
  writeFileSync(resolve(world, ".keiyaku/draft"), "not a directory");

  const receipt = await preserveBindDraft(world, "cannot persist\n");

  assert.equal(receipt.path, undefined);
  assert.match(receipt.warning ?? "", /could not be preserved/u);
  assert.match(renderBindDraftReceipt(receipt), /^warning: /u);
});
