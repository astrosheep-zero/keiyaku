import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import type { ContractId } from "../src/core/facts/types.js";
import { repositoryAt } from "../src/git/repository.js";
import { makeGitRepository, observeContract } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";

test("CLI binds mixed gate selections and amends to an explicit empty selection", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  mkdirSync(resolve(raw.path, ".keiyaku"), { recursive: true });
  writeFileSync(
    resolve(raw.path, ".keiyaku", "settings.json"),
    JSON.stringify({
      gates: {
        default: { kind: "bundle", gates: ["verified"] },
        strict: { kind: "bundle", gates: ["reviewed", "verified"] },
        custom: { kind: "bundle", gates: ["security-audited"] },
      },
    }),
  );
  const repository = await repositoryAt(raw.path);
  const bind = async (selection: string | undefined) => {
    const result = await cliJson<Readonly<{ kind: string; contractId?: string }>>(
      ["-C", raw.path, "bind", ...(selection === undefined ? [] : ["--gates", selection]), "-"],
      {
        environment: {},
        readStdin: async () =>
          contractMarkdown("Gate selection", {
            Context: "Exercise gate selection through the CLI.",
            Objective: "Persist the selected gates without implicit additions.",
            Design: "Resolve the selection before binding or amending.",
            Region: "~~~\nsrc/**\n~~~",
            Criteria: "### Gates\nThe selected obligations are retained.",
            Verification: "~~~bash timeout=5m\nexit 0\n~~~",
          }),
      },
    );
    assert.equal(result.value.kind, "accepted", JSON.stringify(result.value));
    assert.notEqual(result.value.contractId, undefined);
    return result.value.contractId as ContractId;
  };
  const gates = async (id: ContractId) => (await observeContract(repository, id)).state?.terms.gates;
  const mixed = await bind("reviewed,strict,custom,reviewed");
  assert.deepEqual(await gates(mixed), ["reviewed", "verified", "security-audited"]);

  await runCli(["-C", raw.path, "amend", mixed, "--gates", ""], {
    environment: {},
    readStdin: async () => {
      throw new Error("gate-only amend must not read stdin");
    },
  });
  assert.deepEqual(await gates(mixed), []);
});

test("CLI bind rejects unknown gate names without changing Contract authority", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const markdown = async () =>
    contractMarkdown("Gate selection", {
      Context: "Exercise unknown gate rejection.",
      Objective: "Reject unknown names before admission.",
      Design: "Validate gate selections at the public boundary.",
      Region: "src/**",
      Criteria: "### Gates\nUnknown names do not change authority.",
    });
  const environment = { KEIYAKU_HOME: resolve(raw.path, "empty-home") };
  const refs = () => raw.run(["for-each-ref", "--format=%(refname) %(objectname)"]);
  const before = refs();
  const rejected = await runCli(["-C", raw.path, "bind", "--gates", "reveiw", "-"], {
    environment,
    readStdin: markdown,
  });
  assert.notEqual(rejected.exit, 0);
  assert.match(rejected.stdout, /Unknown gate 'reveiw'\. Known gate names: reviewed, verified/u);
  assert.equal(refs(), before);
});
