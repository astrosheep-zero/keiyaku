import assert from "node:assert/strict";
import test from "node:test";
import { decodeArcDocument } from "../src/body/arc.js";
import { renderContractBody } from "../src/body/render.js";
import { repositoryAt } from "../src/git/repository.js";
import { decodeJournal, encodeEntry } from "../src/core/facts/codec.js";
import { foldJournal } from "../src/core/facts/fold.js";
import {
  contractId,
  entryUlid,
  snapshotId,
  type ContractId,
  type JournalEntry,
} from "../src/core/facts/types.js";
import type { ContractBody } from "../src/body/types.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { decideArc } from "../src/core/verbs/arc.js";
import { invoke } from "../src/cli/invoke.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { makeGitRepository, observeContract } from "./support/git.js";

const id = contractId("kei/arc-test");
const initial = snapshotId("a".repeat(40));
const body: ContractBody = {
  title: "Arc Test",
  context: "context",
  objective: "objective",
  design: "design",
  region: ["src/**"],
  criteria: [{ title: "criterion", body: "criterion" }],
  verification: [],
  extensions: [],
};

function entry<K extends JournalEntry["kind"]>(
  kind: K,
  data: Extract<JournalEntry, { kind: K }>["data"],
  suffix: string,
): Extract<JournalEntry, { kind: K }> {
  return {
    v: 1,
    kind,
    contract: id,
    entry: entryUlid(`01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`),
    at: "2026-08-06T00:00:00Z",
    data,
  } as Extract<JournalEntry, { kind: K }>;
}

function bind(suffix = "AA") {
  const document = decodeContractDocument(contractDocument(body.title));
  return entry("bind", { coordinates: { start: initial, workspace: "here" }, terms: { document: document.document, segments: document.segments, gates: [], after: [] } }, suffix);
}

function arc(seq: number, suffix: string) {
  return entry("arc", { seq, title: `Chapter ${seq}`, objective: `Objective ${seq}`, brief: `Brief ${seq}` }, suffix);
}

function arcDocument(title = "Chapter One"): string {
  return [
    `# ${title}`,
    "",
    "## Objective",
    "Move the coherent work forward.",
    "",
    "## Brief",
    "Dispatch the next bounded implementation.",
    "",
  ].join("\n");
}

function contractDocument(title: string): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "Current facts.",
    "",
    "## Objective",
    "Ship the Arc path.",
    "",
    "## Design",
    "Use the admitted fact path.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### Keeps one lifecycle",
    "Arc remains narrative only.",
    "",
  ].join("\n");
}

function repositoryWithMain() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
}

test("Arc Markdown accepts only a title, Objective, and Brief", () => {
  const decoded = decodeArcDocument(arcDocument());
  assert.equal(decoded.title, "Chapter One");
  assert.equal(decoded.objective.trim(), "Move the coherent work forward.");
  assert.equal(decoded.brief.trim(), "Dispatch the next bounded implementation.");
  assert.throws(
    () => decodeArcDocument(`---\nkind: arc\n---\n${arcDocument()}`),
    (error: unknown) => error instanceof TypeError && error.message.includes("arc document may not contain frontmatter"),
  );
  assert.throws(
    () => decodeArcDocument(`${arcDocument()}## Delivery\nnot allowed\n`),
    (error: unknown) => error instanceof TypeError && error.message.includes("arc document does not allow ## Delivery"),
  );
});

test("Arc facts round trip canonically and fold only exact sequences", () => {
  const first = arc(1, "AB");
  assert.deepEqual(decodeJournal(encodeEntry(first)), [first]);
  assert.throws(() => decodeJournal(encodeEntry(first).replace('"seq":1', '"seq":0')), /data\.arc\.seq/);

  const before = foldJournal(id, [bind()]);
  assert.equal(before.currentArc, undefined);
  const folded = foldJournal(id, [bind(), first, arc(2, "AC")]);
  assert.equal(folded.currentArc?.data.seq, 2);
  assert.throws(() => foldJournal(id, [bind(), arc(2, "AD")]), /arc sequence must be 1/);
  assert.throws(() => foldJournal(id, [bind(), first, arc(3, "AE")]), /arc sequence must be 2/);
});

test("Arc decision refuses terminal contracts", () => {
  const abandoned = entry("abandoned", {}, "AG");
  const entries = [bind(), abandoned];
  const terminal = foldJournal(id, entries);
  const result = decideArc({
    input: {
      contractId: id,
      at: "2026-08-06T00:00:00Z",
      data: { title: "No Chapter", objective: "No objective", brief: "No brief" },
    },
    attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAH")] },
    observation: new Map<ContractId, typeof terminal | null>([[id, terminal]]),
  });
  assert.deepEqual(result, { kind: "refused", refusal: { kind: "terminal", contractId: id } });
});

test("Arc CLI admits explicit chapters without changing the status result shape", async () => {
  assert.deepEqual(parseArgv(["arc", "@chapter", "--json", "-"]), {
    command: { command: "arc", contract: "@chapter", output: "json" },
  });
  assert.throws(() => parseArgv(["arc", "kei/arc-test"]), CliUsageError);

  const repository = repositoryWithMain();
  const runtime = {
    cwd: repository.path,
    environment: {},
  };
  const command = (argv: readonly string[], source = "") => invoke(parseArgv(argv), {
    ...runtime,
    readStdin: () => source,
  });

  const bound = await command(["bind", "-"], contractDocument("Arc CLI"));
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind did not return an accepted contract");
  const contract = bound.contract;
  const before = await command(["status", contract]);
  assert.doesNotMatch(JSON.stringify(before), /currentArc/);

  const admitted = await command(["arc", contract, "-"], arcDocument("CLI Chapter"));
  assert.equal(admitted.kind, "accepted");
  assert.deepEqual(admitted.facts.map((fact) => fact.kind), ["arc"]);
  const state = (await observeContract(await repositoryAt(repository.path), contract)).state;
  assert.equal(state?.currentArc?.data.seq, 1);
  assert.equal(state?.currentArc?.data.title, "CLI Chapter");

  const second = await command(["arc", contract, "-"], arcDocument("CLI Chapter Two"));
  assert.equal(second.kind, "accepted");
  const secondState = (await observeContract(await repositoryAt(repository.path), contract)).state;
  assert.equal(secondState?.currentArc?.data.seq, 2);
  assert.equal(secondState?.currentArc?.data.title, "CLI Chapter Two");

  const after = await command(["status", contract]);
  assert.equal(after.kind, "status");
  if (after.kind === "status" && after.report.contracts.kind === "present") {
    assert.deepEqual(after.report.contracts.value.rows.map((row) => row.id), [contract]);
  }
  assert.match(JSON.stringify(after), new RegExp(contract));
  assert.doesNotMatch(renderContractBody(body), /\n## Arc\n/);
  assert.match(renderContractBody(body, secondState?.currentArc?.data), /## Arc\n\n### Sequence\n\n2/);
  assert.match(renderContractBody(body, secondState?.currentArc?.data), /### Brief\n\nDispatch the next bounded implementation\./);
});
