import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import test from "node:test";
import { decodeArcDocument } from "../src/body/arc.js";
import { renderContractBody } from "../src/body/render.js";
import { renderContractHistory } from "../src/cli/render/contract-history.js";
import { renderContractGuidance } from "../src/contract-guidance.js";
import { repositoryAt } from "../src/git/repository.js";
import { decodeJournal, encodeEntry } from "../src/core/facts/codec.js";
import { foldJournal } from "../src/core/facts/fold.js";
import { contractId, entryUlid, snapshotId, type ContractId, type JournalEntry } from "../src/core/facts/types.js";
import type { ContractBody } from "../src/body/types.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { decideArc } from "../src/core/verbs/arc.js";
import { invoke } from "../src/cli/invoke.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import type { AcceptedResult } from "../src/cli/result.js";
import { observeContract } from "./support/git.js";
import { repositoryWithMain } from "./support/library-verbs.js";

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
  return entry(
    "bind",
    {
      coordinates: { start: initial, workspace: "worktree" },
      terms: { document: document.document, segments: document.segments, gates: [], after: [] },
    },
    suffix,
  );
}

function arc(seq: number, suffix: string) {
  return entry("arc", { seq, title: `Chapter ${seq}`, body: `Body ${seq}` }, suffix);
}

const legacyArcBytes =
  '{"at":"2026-08-06T00:00:00Z","contract":"kei/arc-test","data":{"brief":"Brief 1","objective":"Objective 1","seq":1,"title":"Chapter 1"},"entry":"01ARZ3NDEKTSV4RRFFQ69G5FAB","kind":"arc","v":1}\n';

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
  return contractMarkdown(title, {
    Context: "Current facts.",
    Objective: "Ship the Arc path.",
    Design: "Use the admitted fact path.",
    Region: "~~~\nsrc/**\n~~~",
    Criteria: "### Keeps one lifecycle\nArc remains narrative only.\n",
  });
}

test("Arc Markdown accepts a chapter name and arbitrary or empty body", () => {
  const decoded = decodeArcDocument(arcDocument());
  assert.equal(decoded.title, "Chapter One");
  assert.equal(decoded.body, "\n## Objective\nMove the coherent work forward.\n\n## Brief\nDispatch the next bounded implementation.\n");
  assert.deepEqual(decodeArcDocument("# Empty"), { title: "Empty", body: "" });
  assert.deepEqual(decodeArcDocument("# Flexible\nBefore any H2.\n\n## Delivery\nDone.\n"), {
    title: "Flexible", body: "Before any H2.\n\n## Delivery\nDone.\n",
  });
  for (const malformed of ["", "#  \n", "## Section\nbody", "# One\n# Two\n", "before\n# Name", `---\nkind: arc\n---\n${arcDocument()}`]) {
    assert.throws(
      () => decodeArcDocument(malformed),
      (error: unknown) => error instanceof TypeError &&
        error.message.includes("exactly one nonblank H1 chapter name") &&
        error.message.includes("freeform Markdown body (which may be empty)"),
    );
  }
});

test("Arc facts round trip canonically and fold only exact sequences", () => {
  const first = arc(1, "AB");
  assert.deepEqual(decodeJournal(encodeEntry(first)), [first]);
  assert.throws(() => decodeJournal(encodeEntry(first).replace('"seq":1', '"seq":0')), /data\.arc\.seq/);

  const freeform = entry("arc", { seq: 2, title: "Freeform", body: "" }, "AC");
  assert.deepEqual(decodeJournal(encodeEntry(freeform)), [freeform]);
  assert.throws(() => decodeJournal(encodeEntry(freeform).replace('"body":""', '"body":"","brief":"extra"')), /unknown field/);
  const before = foldJournal(id, [bind()]);
  assert.equal(before.currentArc, undefined);
  const folded = foldJournal(id, [bind(), first, freeform]);
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
      data: { title: "No Chapter", body: "" },
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
    environment: { KEIYAKU_HOME: `${repository.path}/empty-home` },
  };
  const command = (argv: readonly string[], source = "") => {
    const parsed = parseArgv(argv);
    if (!("command" in parsed)) throw new Error("arc test command did not parse as executable");
    return invoke(parsed, {
      ...runtime,
      readStdin: async () => source,
    });
  };

  const bound = await command(["bind", "-"], contractDocument("Arc CLI"));
  assert.equal("kind" in bound ? bound.kind : undefined, "accepted");
  if (!("kind" in bound) || bound.kind !== "accepted" || !("verb" in bound) || bound.verb !== "bind") {
    throw new Error("bind did not return an accepted contract");
  }
  const contract = (bound as Extract<AcceptedResult, { verb: "bind" }>).contract;
  const before = await command(["status", contract]);
  assert.doesNotMatch(JSON.stringify(before), /currentArc/);

  const admitted = await command(["arc", contract, "-"], "# CLI Chapter\nAny text before a section.\n\n## Delivery\nDone.\n");
  assert.equal("kind" in admitted ? admitted.kind : undefined, "accepted");
  if (!("kind" in admitted) || admitted.kind !== "accepted" || !("verb" in admitted) || admitted.verb !== "arc") {
    throw new Error("arc did not return an accepted result");
  }
  const admittedArc = admitted as Extract<AcceptedResult, { verb: "arc" }>;
  assert.deepEqual(
    admittedArc.facts.map((fact) => fact.kind),
    ["arc"],
  );
  const state = (await observeContract(await repositoryAt(repository.path), contract)).state;
  assert.equal(state?.currentArc?.data.seq, 1);
  assert.equal(state?.currentArc?.data.title, "CLI Chapter");
  assert.deepEqual(state?.currentArc?.data, { seq: 1, title: "CLI Chapter", body: "Any text before a section.\n\n## Delivery\nDone.\n" });
  for (const malformed of ["#  \n", ""]) {
    const invalid = await command(["arc", contract, "-"], malformed);
    assert.equal("kind" in invalid ? invalid.kind : undefined, "refused");
    if ("kind" in invalid && invalid.kind === "refused") {
      assert.deepEqual(invalid.refusal, {
        kind: "invalid-document",
        diagnostic: "arc document requires exactly one nonblank H1 chapter name (# <name>) followed by a freeform Markdown body (which may be empty)",
      });
    }
  }
  const second = await command(["arc", contract, "-"], "# CLI Chapter Two");
  assert.equal("kind" in second ? second.kind : undefined, "accepted");
  if (!("kind" in second) || second.kind !== "accepted" || !("verb" in second) || second.verb !== "arc") {
    throw new Error("second arc did not return an accepted result");
  }
  const secondState = (await observeContract(await repositoryAt(repository.path), contract)).state;
  assert.equal(secondState?.currentArc?.data.seq, 2);
  assert.equal(secondState?.currentArc?.data.title, "CLI Chapter Two");
  assert.deepEqual(secondState?.currentArc?.data, { seq: 2, title: "CLI Chapter Two", body: "" });

  const after = await command(["status", contract]);
  assert.equal("kind" in after ? after.kind : undefined, "status");
  if ("kind" in after && after.kind === "status" && after.report.contracts.kind === "present") {
    assert.deepEqual(
      after.report.contracts.value.rows.map((row) => row.id),
      [contract],
    );
  }
  assert.match(JSON.stringify(after), new RegExp(contract));
  assert.doesNotMatch(renderContractBody(body), /\n## Arc\n/);
  assert.match(renderContractBody(body, secondState?.currentArc?.data), /## Arc\n\n### Sequence\n\n2/);
  assert.match(renderContractBody(body, secondState?.currentArc?.data), /### Body$/m);
  assert.doesNotMatch(renderContractBody(body, secondState?.currentArc?.data), /### Brief/);
});

test("stored old-shape arc bytes normalize at decode and render as one chapter body", () => {
  const legacy = decodeJournal(legacyArcBytes)[0];
  assert.deepEqual(legacy, entry("arc", { seq: 1, title: "Chapter 1", body: "Objective 1\n\nBrief 1" }, "AB"));
  assert.equal(encodeEntry(legacy!), encodeEntry(entry("arc", { seq: 1, title: "Chapter 1", body: "Objective 1\n\nBrief 1" }, "AB")));
  assert.throws(() => decodeJournal(legacyArcBytes.replace('"brief":"Brief 1","objective":"Objective 1"', '"objective":"Objective 1","brief":"Brief 1"')), /not canonical/);
  if (legacy?.kind !== "arc") throw new Error("missing legacy arc");
  const current = foldJournal(id, [bind(), legacy]);
  const guidance = renderContractGuidance(current);
  const rendered = renderContractBody(body, current.currentArc?.data);
  const history = renderContractHistory({ id, state: initial, events: [{ source: "journal", fact: legacy }] });
  for (const text of [guidance.slice(guidance.indexOf("## Arc")), rendered.slice(rendered.indexOf("## Arc")), history]) {
    assert.match(text, /Objective 1[\s\S]*Brief 1/);
    assert.doesNotMatch(text, /## Objective|## Brief/);
  }
  assert.match(history, /  body\n  \u2502 Objective 1/);
  assert.doesNotMatch(history, /\nobjective\n|\nbrief\n|\n\n$/);
});

test("freeform and empty chapters render as one bounded history payload", () => {
  const freeform = entry("arc", { seq: 1, title: "Freeform", body: "\n## Delivery\n\nFirst line.\nSecond line.\n" }, "AB");
  const empty = entry("arc", { seq: 2, title: "Empty", body: "" }, "AC");
  const history = renderContractHistory({
    id, state: initial,
    events: [{ source: "journal", fact: freeform }, { source: "journal", fact: empty }],
  });
  assert.match(history, /  title  Freeform\n  body\n  \u2502 ## Delivery\n  \u2502/);
  assert.match(history, /  \u2502 First line\.\n  \u2502 Second line\./);
  assert.match(history, /  title  Empty$/);
  assert.doesNotMatch(history, /  title  Empty\n  body/);
  assert.doesNotMatch(history, /\n\n\n/);
  assert.match(renderContractGuidance(foldJournal(id, [bind(), freeform])), /### Body\n\n## Delivery/);
});
