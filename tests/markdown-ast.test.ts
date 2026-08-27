import assert from "node:assert/strict";
import test from "node:test";
import { lexMarkdown } from "../src/markdown/lex.js";
import { parseToAST } from "../src/markdown/parse.js";
import { directChildren, indexDocument, indexedHeadings, rawSlice, sectionContent } from "../src/markdown/query.js";

test("token spans tile exact BOM and CRLF source", () => {
  const source =
    "\uFEFF---\r\nkind: draft\r\neffortOptions:\r\n  - low\r\n  - high\r\n---\r\n# Title\r\n## Body\r\ntext\r\n";
  const document = parseToAST(source);
  const tokens = lexMarkdown(source);
  let cursor: number = document.bomLength;
  for (const token of tokens) {
    assert.equal(token.span.start, cursor);
    cursor = token.span.end;
  }
  assert.equal(cursor, source.length);
  assert.equal(tokens.map((token) => rawSlice(document, token.span)).join(""), source.slice(document.bomLength));
  assert.deepEqual(document.frontmatter?.entries, { kind: "draft", effortOptions: ["low", "high"] });
});

test("fences keep heading-looking bytes opaque and H1 closes H2", () => {
  const source = [
    "# First",
    "## Design",
    "````markdown",
    "## Not a section",
    "```ts",
    "````",
    "# Second",
    "## Context",
    "body",
  ].join("\n");
  const document = parseToAST(source);
  const index = indexDocument(document);
  assert.equal(indexedHeadings(index, { title: "not a section", level: 2 }).length, 0);
  assert.deepEqual(
    indexedHeadings(index, { level: 1 }).map((node) => (node.type === "section" ? node.title : node.text)),
    ["First", "Second"],
  );
  const design = indexedHeadings(index, { title: "design", level: 2 })[0];
  assert.equal(design?.type, "section");
  if (design?.type !== "section") return;
  assert.equal(directChildren(design, "code_block").length, 1);
});

test("nested lists and blockquotes remain structured while inline bytes stay opaque", () => {
  const listDocument = parseToAST("## Items\n- outer [link](target)\n  - inner **strong**\n");
  const items = indexedHeadings(indexDocument(listDocument), { title: "items", level: 2 })[0];
  assert.equal(items?.type, "section");
  if (items?.type !== "section") return;
  const list = directChildren(items, "list")[0];
  assert.ok(list);
  assert.equal(list.items.length, 1);
  const nested = list.items[0]?.children.find((node) => node.type === "list");
  assert.equal(nested?.type, "list");
  assert.match(
    list.items[0]?.children[0]?.type === "text" ? list.items[0].children[0].value : "",
    /\[link\]\(target\)/,
  );

  const quoteDocument = parseToAST("## Notes\n> quoted [link](target)\n> second line\n");
  const notes = indexedHeadings(indexDocument(quoteDocument), { title: "notes", level: 2 })[0];
  assert.equal(notes?.type, "section");
  if (notes?.type !== "section") return;
  assert.equal(directChildren(notes, "blockquote")[0]?.value, "quoted [link](target)\nsecond line");
});

test("indexed section lookup exposes exact raw content without rendering", () => {
  const source = "# Contract\r\n## Extra Notes\r\nfirst\r\n\r\n- second\r\n";
  const document = parseToAST(source);
  const extra = indexedHeadings(indexDocument(document), { title: "  EXTRA   notes ", level: 2 })[0];
  assert.equal(extra?.type, "section");
  if (extra?.type !== "section") return;
  assert.equal(sectionContent(document, extra), "first\r\n\r\n- second\r\n");
});

test("BOM, CRLF, and astral characters tile exact UTF-16 spans", () => {
  const source = "\uFEFF# 🚀 Start\r\n## 📋 Plan\r\nbody\r\n";
  const document = parseToAST(source);
  const tokens = lexMarkdown(source);
  assert.equal(document.bomLength, 1);
  assert.deepEqual(tokens[0]?.span, { start: 1, end: 13 });
  assert.deepEqual(tokens[1]?.span, { start: 13, end: 25 });
  assert.equal(tokens.map((token) => rawSlice(document, token.span)).join(""), source.slice(document.bomLength));
  const header = tokens[1];
  assert.equal(header?.type, "header");
  if (header?.type !== "header") return;
  assert.equal(header.text, "📋 Plan");
  assert.equal(rawSlice(document, header.span), "## 📋 Plan\r\n");
  const plan = indexedHeadings(indexDocument(document), { title: "📋 plan", level: 2 })[0];
  assert.equal(plan?.type, "section");
  if (plan?.type !== "section") return;
  assert.equal(sectionContent(document, plan), "body\r\n");
});

test("info-bearing and shorter fence lines never close a fence; heading bytes stay opaque", () => {
  const source = ["# Doc", "## Design", "```", "# Fake H1", "## Fake H2", "```ts", "``", "```", "tail"].join("\n");
  const document = parseToAST(source);
  const index = indexDocument(document);
  assert.equal(indexedHeadings(index, { level: 1 }).length, 1);
  assert.equal(indexedHeadings(index, { title: "fake h2", level: 2 }).length, 0);
  const design = indexedHeadings(index, { title: "design", level: 2 })[0];
  assert.equal(design?.type, "section");
  if (design?.type !== "section") return;
  const block = directChildren(design, "code_block")[0];
  assert.equal(block?.closed, true);
  assert.deepEqual(block?.lines, ["```", "# Fake H1", "## Fake H2", "```ts", "``", "```"]);
  assert.equal(directChildren(design, "text")[0]?.value, "tail");
});

test("heading-looking bytes inside blockquotes and list bodies stay structured, never indexed", () => {
  const quoted = parseToAST("## Notes\n> ## Fake Heading\n> more\n");
  const quotedIndex = indexDocument(quoted);
  assert.equal(indexedHeadings(quotedIndex, { title: "fake heading", level: 2 }).length, 0);
  const notes = indexedHeadings(quotedIndex, { title: "notes", level: 2 })[0];
  assert.equal(notes?.type, "section");
  if (notes?.type !== "section") return;
  assert.equal(directChildren(notes, "blockquote")[0]?.value, "## Fake Heading\nmore");

  const listed = parseToAST("## Items\n- ## Fake Heading\n");
  const listedIndex = indexDocument(listed);
  assert.equal(indexedHeadings(listedIndex, { title: "fake heading", level: 2 }).length, 0);
  const items = indexedHeadings(listedIndex, { title: "items", level: 2 })[0];
  assert.equal(items?.type, "section");
  if (items?.type !== "section") return;
  const body = directChildren(items, "list")[0]?.items[0]?.children[0];
  assert.equal(body?.type, "text");
  if (body?.type !== "text") return;
  assert.equal(body.value, "## Fake Heading");
});
