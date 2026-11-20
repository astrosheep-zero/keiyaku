import assert from "node:assert/strict";
import test from "node:test";
import { repositoryAt, updateGitTree, writeBlob, type TreeChange } from "../src/git/repository.js";
import { repositoryWithCommit } from "./support/git.js";

test("native private-tree publication preserves unknown leaves and literal paths while pruning empty directories", async () => {
  const raw = repositoryWithCommit();
  const repository = await repositoryAt(raw.path);
  const blob = await writeBlob(repository, "unknown authority\n");
  const replacement = await writeBlob(repository, "new authority\n");
  const commit = raw.run(["rev-parse", "HEAD"]).trim();
  const leaves = new Map<string, TreeChange>([
    ["authority/journal", { oid: blob }],
    ["authority/delete", { oid: blob }],
    ["unknown/executable", { oid: blob, mode: "100755" }],
    ["unknown/symlink", { oid: blob, mode: "120000" }],
    ["unknown/gitlink", { oid: commit, mode: "160000", type: "commit" }],
    ["unknown/tab\tline\nback\\slash", { oid: blob }],
    ["unknown/:(literal)*[name]", { oid: blob }],
  ]);
  const initial = await updateGitTree(repository, null, leaves);
  assert.equal(raw.run(["show", `${initial}:authority/journal`]), "unknown authority\n");
  const empty = raw.run(["mktree"], "").trim();
  const base = raw.run(["mktree", "-z"], raw.run(["ls-tree", "-z", initial]) + `040000 tree ${empty}\tempty\0`).trim();
  const before = raw.run(["ls-tree", "-r", "-z", base]).split("\0").filter(Boolean);
  const result = await updateGitTree(
    repository,
    base,
    new Map([
      ["authority/journal", { oid: replacement }],
      ["authority/delete", null],
      ["unknown/:(literal)*[name]", { oid: replacement, mode: "100755" }],
    ]),
  );
  const after = raw.run(["ls-tree", "-r", "-z", result]).split("\0").filter(Boolean);
  const preserved = (records: readonly string[]) =>
    records.filter((record) => {
      const path = record.slice(record.indexOf("\t") + 1);
      return !["authority/journal", "authority/delete", "unknown/:(literal)*[name]"].includes(path);
    });
  assert.deepEqual(preserved(after), preserved(before));
  assert.equal(raw.run(["show", `${result}:authority/journal`]), "new authority\n");
  assert.equal(
    after.some((record) => record.endsWith("\tauthority/delete")),
    false,
  );
  assert.ok(after.includes(`100755 blob ${replacement}\tunknown/:(literal)*[name]`));
  assert.equal(raw.run(["ls-tree", result, "--", "empty"]), "");
  assert.equal(await updateGitTree(repository, null, new Map()), empty);
});
