import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { applyAmendDocument, prepareAmendDocument } from "../src/body/amend.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { renderContractBody } from "../src/body/render.js";
import type { ContractBody as ContractBodyValue } from "../src/body/types.js";
import { Keiyaku, KeiyakuError, Repo } from "../src/index.js";
import { makeGitRepository } from "./support/git.js";

const body: ContractBodyValue = {
  title: "Current",
  context: "current\n",
  objective: "objective\n",
  design: "design\n",
  region: ["src/**"],
  criteria: [
    { title: "Keep", body: "before\n" },
    { title: "Drop", body: "remove\n" },
  ],
  verification: [{ executor: "bash", script: "true" }],
  extensions: [{ title: "Notes", content: "first\n" }],
};

function applyAmendOperations(source: string, current: ContractBodyValue) {
  const document = decodeContractDocument(renderContractBody(current));
  return decodeContractDocument(applyAmendDocument(source, document).document);
}

test("amend H2 operations form one complete body replacement", () => {
  const amended = applyAmendOperations(
    [
      "## Append: Context",
      "more",
      "",
      "## Replace: Region",
      "~~~",
      "lib/**",
      "~~~",
      "",
      "## Replace: Criteria",
      "### Keep",
      "before",
      "",
      "### Added",
      "added",
      "",
      "## Append: Notes",
      "second",
      "",
      "## Replace: Verification",
      "```zsh timeout=5m",
      "print ok",
      "```",
      "",
    ].join("\n"),
    body,
  );

  assert.equal(amended.context.trim(), "current\n\nmore");
  assert.deepEqual(amended.region, ["lib/**"]);
  assert.deepEqual(
    amended.criteria.map(({ title, body }) => ({ title, body: body.trim() })),
    [
      { title: "Keep", body: "before" },
      { title: "Added", body: "added" },
    ],
  );
  assert.deepEqual(amended.verification, [{ executor: "zsh", script: "print ok", timeoutMs: 300_000 }]);
  assert.deepEqual(
    amended.extensions.map(({ title, content }) => ({ title, content: content.trim() })),
    [{ title: "Notes", content: "first\n\nsecond" }],
  );
});

test("bare amend H2 headings replace existing sections and add new extensions", () => {
  const amended = applyAmendOperations(
    [
      "## Context",
      "bare context",
      "",
      "## Criteria",
      "### Bare criterion",
      "bare criterion body",
      "",
      "## Verification",
      "```bash timeout=5m",
      "echo bare",
      "```",
      "",
      "## Notes",
      "bare notes",
      "",
      "## Fresh notes",
      "new extension",
      "",
    ].join("\n"),
    body,
  );

  assert.equal(amended.context.trim(), "bare context");
  assert.deepEqual(
    amended.criteria.map(({ title, body }) => ({ title, body: body.trim() })),
    [{ title: "Bare criterion", body: "bare criterion body" }],
  );
  assert.deepEqual(amended.verification, [{ executor: "bash", script: "echo bare", timeoutMs: 300_000 }]);
  assert.deepEqual(
    amended.extensions.map(({ title, content }) => ({ title, content: content.trim() })),
    [
      { title: "Notes", content: "bare notes" },
      { title: "Fresh notes", content: "new extension" },
    ],
  );
});

test("amend requires a timeout for new Verification declarations", () => {
  const current = decodeContractDocument(renderContractBody(body));
  assert.throws(
    () => applyAmendDocument("## Replace: Verification\n~~~bash\ntrue\n~~~\n", current),
    /must specify timeout=<duration>/,
  );
});

test("amend keeps criteria and extension collections coherent across ordered mutations", () => {
  const indexedBody: ContractBodyValue = {
    ...body,
    extensions: [...body.extensions, { title: "Archive", content: "archive\n" }],
  };
  const amended = applyAmendOperations(
    [
      "## Replace: Criteria",
      "### Replaced",
      "replacement",
      "",
      "## Append: Criteria",
      "### Appended",
      "appended",
      "",
      "## Add: Criteria",
      "### Added",
      "added",
      "",
      "## Remove: Notes",
      "",
      "## Update: Archive",
      "updated archive",
      "",
      "## Add: Extra",
      "first extra",
      "",
      "## Append: Extra",
      "second extra",
      "",
      "## Update: Extra",
      "updated extra",
      "",
      "## Replace: Extra",
      "replaced extra",
      "",
      "## Remove: Extra",
      "",
    ].join("\n"),
    indexedBody,
  );

  assert.deepEqual(
    amended.criteria.map(({ title, body }) => ({ title, body: body.trim() })),
    [
      { title: "Replaced", body: "replacement" },
      { title: "Appended", body: "appended" },
      { title: "Added", body: "added" },
    ],
  );
  assert.deepEqual(
    amended.extensions.map(({ title, content }) => ({ title, content: content.trim() })),
    [{ title: "Archive", content: "updated archive" }],
  );
});

test("amend has no criterion-level remove operation", () => {
  assert.throws(
    () => applyAmendOperations("## Remove: Criterion Keep\n", body),
    (error: unknown) => error instanceof TypeError && error.message === "unknown extension 'Criterion Keep'",
  );
});

test("amend cannot add a reserved H2 as an extension", () => {
  for (const title of ["Gates", "Pipeline", "After", "Arc", "Fulfillment"]) {
    assert.throws(
      () => applyAmendOperations(`## Add: ${title}\nvalue\n`, body),
      (error: unknown) =>
        error instanceof TypeError && error.message === `${title.toLowerCase()} is not a contract Markdown section`,
    );
  }
});

test("amend rejects a normalized extension-title collision at the operation boundary", () => {
  assert.throws(
    () => applyAmendOperations("## Add: notes\nsecond notes\n", body),
    (error: unknown) => error instanceof TypeError && error.message === "extension already exists 'notes'",
  );
});

test("explicit Replace still refuses a missing extension", () => {
  assert.throws(
    () => applyAmendOperations("## Replace: Fresh notes\nnew extension\n", body),
    (error: unknown) => error instanceof TypeError && error.message === "unknown extension 'Fresh notes'",
  );
});

test("Criteria amendments preserve H3 boundaries and caller-context diagnostics", () => {
  const current = decodeContractDocument(renderContractBody(body));
  const source =
    "## Replace: Criteria\n### Nested bytes\nline\r\n> quote\r\n#### detail\r\n~~~\r\nfenced\r\n~~~\r\ntail\n\n### Last\nlast\n";
  const result = decodeContractDocument(applyAmendDocument(source, current).document);
  assert.deepEqual(result.criteria, [
    { title: "Nested bytes", body: "\nline\r\n> quote\r\n#### detail\r\n~~~\r\nfenced\r\n~~~\r\ntail\n\n" },
    { title: "Last", body: "\nlast\n\n" },
  ]);
  assert.throws(() => applyAmendDocument("## Criteria\nflat\n", current), {
    name: "TypeError",
    message: "Criteria operation must contain one or more H3 entries",
  });
  assert.throws(() => applyAmendDocument("## Criteria\nstray\n### Entry\nbody\n", current), {
    name: "TypeError",
    message: "Criteria operation may contain only H3 entries",
  });
  assert.throws(() => applyAmendDocument("## Criteria\n### Entry\nbody\n### ENTRY\nother\n", current), {
    name: "TypeError",
    message: "criteria operation contains duplicate or empty titles",
  });
  assert.throws(() => applyAmendDocument("## Criteria\n### Empty\n", current), {
    name: "TypeError",
    message: "criterion 'Empty' operation body is empty",
  });
  assert.throws(() => applyAmendDocument("## Add: Criteria\n### KEEP\nnew\n", current), {
    name: "TypeError",
    message: "Add Criteria targets an existing criterion",
  });
});

test("prepared amendments refuse duplicates before application and preserve untouched bytes", () => {
  assert.throws(() => prepareAmendDocument("## Append: Context\nfirst\n## Append: Context\nsecond\n"), {
    name: "TypeError",
    message: "duplicate amend operation 'Append:Context'",
  });
  const current = decodeContractDocument(renderContractBody(body).replace("current\n", "current  \r\n"));
  assert.match(current.document.bytes, /current  \r\n/u);
  const prepared = prepareAmendDocument("## Append: Criteria\n### Added\nadded\n");
  const amended = prepared(current);
  assert.deepEqual([...amended.changedSections], ["criteria"]);
  const start = current.document.bytes.indexOf("## Criteria");
  const end = current.document.bytes.indexOf("## Verification");
  assert.equal(amended.document.slice(0, start), current.document.bytes.slice(0, start));
  assert.equal(amended.document.slice(amended.document.indexOf("## Verification")), current.document.bytes.slice(end));
  assert.deepEqual(prepared(current), amended);
});

test("duplicate amendments retain their native input cause before Git observation", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const log = join(repository.path, "git-observations");
  const previousTrace = process.env.GIT_TRACE;
  // Git's own trace works with the native executable on every platform, unlike a POSIX shell shim.
  process.env.GIT_TRACE = log;
  try {
    const repo = await Repo.at({ path: repository.path });
    const before = readFileSync(log, "utf8");
    assert.match(before, /worktree list/u, "repository discovery proves Git observation tracing is active");
    const contract = Keiyaku.with().select({ repo, id: "kei/missing" as never });
    await assert.rejects(
      () => contract.amend({ markdown: "## Append: Context\nfirst\n## Append: Context\nsecond\n" }),
      (error: unknown) => {
        assert.ok(error instanceof KeiyakuError);
        assert.equal(error.category, "invalid-input");
        assert.ok(error.cause instanceof TypeError);
        assert.equal(error.cause.message, "duplicate amend operation 'Append:Context'");
        return true;
      },
    );
    assert.equal(readFileSync(log, "utf8"), before, "invalid amendment input performs no Git observation");
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previousTrace;
  }
});
