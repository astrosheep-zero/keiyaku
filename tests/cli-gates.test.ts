import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import type { ContractId } from "../src/core/facts/types.js";
import { repositoryAt } from "../src/git/repository.js";
import { makeGitRepository, observeContract } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";

test("amend names the missing Verification declaration required by verified", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await cliJson<Readonly<{ kind: string; contract?: string }>>(
    ["-C", raw.path, "bind", "--gates", "", "-"],
    {
      environment: {},
      readStdin: async () => contractMarkdown("Without verification", {
        Context: "Test gate requirement.", Objective: "Name absent Verification.",
        Design: "Keep the declaration absent.", Region: "src/**",
        Criteria: "### Gate\nState the reason.",
      }),
    },
  );
  assert.equal(bound.value.kind, "accepted");
  if (bound.value.kind !== "accepted" || bound.value.contract === undefined) return;
  const result = await cliJson<Readonly<{ kind: string; refusal?: unknown }>>(
    ["-C", raw.path, "amend", bound.value.contract, "--gates", "verified"],
    { environment: {}, readStdin: async () => { throw new Error("gate-only amend must not read stdin"); } },
  );
  assert.equal(result.value.kind, "refused");
  const rendered = await runCli(["-C", raw.path, "amend", bound.value.contract, "--gates", "verified"], {
    environment: {},
    readStdin: async () => { throw new Error("gate-only amend must not read stdin"); },
  });
  assert.match(rendered.stdout, /gate 'verified' requires a declared Verification; the Contract declares none/u);
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
    const result = await cliJson<Readonly<{ kind: string; contract?: string }>>(
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
    assert.notEqual(result.value.contract, undefined);
    return result.value.contract as ContractId;
  };
  const gates = async (id: ContractId) => (await observeContract(repository, id)).state?.terms.gates;
  const mixed = await bind("reviewed,strict,security-audited,reviewed");
  assert.deepEqual(await gates(mixed), ["reviewed", "verified", "security-audited"]);

  const amendText = await runCli(["-C", raw.path, "amend", mixed, "--gates", ""], {
    environment: {},
    readStdin: async () => { throw new Error("gate-only amend must not read stdin"); },
  });
  assert.match(amendText.stdout, /✓ amended[\s\S]*gates  none/u);
  assert.doesNotMatch(amendText.stdout, /terms unchanged/u);
  assert.deepEqual(await gates(mixed), []);
  assert.deepEqual(await gates(await bind("")), []);
  assert.deepEqual(await gates(await bind(undefined)), ["verified"]);
});

test("bind and amend warn about a gate word with no known producer", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const markdown = async () =>
    contractMarkdown("Gate warning", {
      Context: "Exercise the custom-gate warning.",
      Objective: "Warn on producerless gate words.",
      Design: "Keep the producer outside this World.",
      Region: "src/**",
      Criteria: "### Warning\nThe receipt names the producerless word.",
    });
  type Warned = Readonly<{ kind: string; contract?: string; value?: { gateWarnings?: readonly string[] } }>;
  const bound = await cliJson<Warned>(["-C", raw.path, "bind", "--gates", "reveiw", "-"], {
    environment: {},
    readStdin: markdown,
  });
  assert.equal(bound.value.kind, "accepted", JSON.stringify(bound.value));
  assert.deepEqual(bound.value.value?.gateWarnings, [
    "Gate 'reveiw' has no known producer and stays unsatisfied until a producer attests it",
  ]);

  const quiet = await runCli(["-C", raw.path, "bind", "--gates", "reviewed", "-"], {
    environment: {},
    readStdin: markdown,
  });
  assert.equal(quiet.exit, 0);
  assert.doesNotMatch(quiet.stdout, /gate warning/u);

  const warned = await runCli(["-C", raw.path, "bind", "--gates", "reveiw", "-"], {
    environment: {},
    readStdin: markdown,
  });
  assert.equal(warned.exit, 0);
  assert.match(warned.stdout, /! gate warning[\s\S]*reveiw/u);

  if (bound.value.contract === undefined) return;
  const amended = await cliJson<Warned>(
    ["-C", raw.path, "amend", bound.value.contract, "--gates", "reviewed,reveiw"],
    {
      environment: {},
      readStdin: async () => {
        throw new Error("gate-only amend must not read stdin");
      },
    },
  );
  assert.equal(amended.value.kind, "accepted", JSON.stringify(amended.value));
  assert.deepEqual(amended.value.value?.gateWarnings, [
    "Gate 'reveiw' has no known producer and stays unsatisfied until a producer attests it",
  ]);
});
