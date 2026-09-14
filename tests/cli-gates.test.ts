import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import type { ContractId } from "../src/core/facts/types.js";
import { repositoryAt } from "../src/git/repository.js";
import { makeGitRepository, observeContract } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";

function executable(argv: readonly string[]) {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("expected command invocation");
  return parsed;
}

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
            Verification: "~~~bash\nexit 0\n~~~",
          }),
      },
    );
    assert.equal(result.kind, "accepted", JSON.stringify(result));
    assert.ok("contract" in result);
    return result.contract as ContractId;
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
  assert.equal(amend.kind, "accepted");
  assert.deepEqual(await gates(mixed), []);
  assert.deepEqual(await gates(await bind("")), []);
  assert.deepEqual(await gates(await bind(undefined)), ["verified"]);
});
