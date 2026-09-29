import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { executable } from "./support/cli-fixtures.js";
import { invoke } from "../src/cli/invoke.js";
import { renderText } from "../src/cli/render/text.js";
import type { ContractId } from "../src/core/facts/types.js";
import { repositoryAt } from "../src/git/repository.js";
import { makeGitRepository, observeContract } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";

test("amend names the missing Verification declaration required by verified", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await invoke(executable(["-C", raw.path, "bind", "--gates", "", "-"]), {
    environment: {},
    readStdin: async () => contractMarkdown("Without verification", {
      Context: "Test gate requirement.", Objective: "Name absent Verification.",
      Design: "Keep the declaration absent.", Region: "src/**",
      Criteria: "### Gate\nState the reason.",
    }),
  });
  assert.ok("kind" in bound);
  assert.equal(bound.kind, "accepted");
  assert.ok("verb" in bound);
  if (bound.kind !== "accepted") return;
  const result = await invoke(executable(["-C", raw.path, "amend", bound.contract, "--gates", "verified"]), {
    environment: {}, readStdin: async () => { throw new Error("gate-only amend must not read stdin"); },
  });
  assert.ok("kind" in result);
  assert.equal(result.kind, "refused");
  assert.ok("verb" in result);
  if (result.kind !== "refused") return;
  assert.match(renderText(result), /gate 'verified' requires a declared Verification; the Contract declares none/u);
});

test("CLI binds mixed gate selections and amends or binds an explicit empty selection", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  mkdirSync(resolve(raw.path, ".keiyaku"), { recursive: true });
  writeFileSync(
    resolve(raw.path, ".keiyaku", "settings.json"),
    JSON.stringify({
      gates: {
        default: { kind: "bundle", gates: ["verified"] },
        strict: { kind: "bundle", gates: ["reviewed", "verified"] },
      },
    }),
  );
  const repository = await repositoryAt(raw.path);
  const bind = async (selection: string | undefined) => {
    const result = await invoke(
      executable(["-C", raw.path, "bind", ...(selection === undefined ? [] : ["--gates", selection]), "-"]),
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
    assert.ok("kind" in result);
    assert.equal(result.kind, "accepted", JSON.stringify(result));
    assert.ok("verb" in result && result.kind === "accepted");
    return result.contract;
  };
  const gates = async (id: ContractId) => (await observeContract(repository, id)).state?.terms.gates;
  const mixed = await bind("reviewed,strict,security-audited,reviewed");
  assert.deepEqual(await gates(mixed), ["reviewed", "verified", "security-audited"]);

  const amend = await invoke(executable(["-C", raw.path, "amend", mixed, "--gates", ""]), {
    environment: {},
    readStdin: async () => {
      throw new Error("gate-only amend must not read stdin");
    },
  });
  assert.ok("kind" in amend);
  assert.equal(amend.kind, "accepted");
  assert.ok("verb" in amend);
  if (amend.kind === "accepted" && amend.verb === "amend") {
    assert.deepEqual(amend.changes.gates, []);
    assert.match(renderText(amend), /✓ amended[\s\S]*gates  none/u);
    assert.doesNotMatch(renderText(amend), /terms unchanged/u);
  }
  assert.deepEqual(await gates(mixed), []);
  assert.deepEqual(await gates(await bind("")), []);
  assert.deepEqual(await gates(await bind(undefined)), ["verified"]);
});
