import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { invoke as invokeRaw } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { renderText } from "../src/cli/render/text.js";
import type { ContractId } from "../src/core/facts/types.js";
import { repositoryAt } from "../src/git/repository.js";
import { makeGitRepository, observeContract } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";

function executable(argv: readonly string[]) {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("expected command invocation");
  return parsed;
}

function markdown(script: string): string {
  return contractMarkdown("CLI verification", {
    Context: "A CLI result exposes verification owner facts.",
    Objective: "Keep verification and audit adaptation visible.",
    Design: "Invoke the public Contract operation once.",
    Region: "~~~\nsrc/**\n~~~",
    Criteria: `### Check\nThe verification runs.\n\n## Verification\n~~~bash\n${script}\n~~~`,
  });
}

async function bindAndDeliver(script: string) {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  raw.run(["checkout", "--quiet", "-b", "candidate"]);
  writeFileSync(resolve(raw.path, "candidate.txt"), "candidate\n");
  raw.run(["add", "candidate.txt"]);
  raw.run(["commit", "--quiet", "-m", "candidate"]);
  mkdirSync(resolve(raw.path, ".keiyaku"), { recursive: true });
  writeFileSync(resolve(raw.path, ".keiyaku", "settings.json"), JSON.stringify({ gates: { default: { kind: "bundle", gates: ["verified"] } } }));
  const bound = (await invokeRaw(executable(["-C", raw.path, "bind", "--target", "refs/heads/main", "-"]), {
    environment: {},
    readStdin: async () => markdown(script),
  })) as unknown as { kind: string; contract: string };
  assert.equal(bound.kind, "accepted");
  const result = await invokeRaw(executable(["-C", raw.path, "deliver", bound.contract]), {
    environment: { KEIYAKU_ACTOR_ID: "cli-verification-test" },
  });
  return { raw, id: bound.contract as ContractId, result };
}

test("deliver adapts a successful Verification result through the CLI", async () => {
  const { raw, id, result } = await bindAndDeliver("exit 0");
  const delivered = result as unknown as { kind: string; facts: readonly { kind: string }[] };
  assert.equal(delivered.kind, "accepted");
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver", "attestation", "claimed"]);
  const repository = await repositoryAt(raw.path);
  assert.equal((await observeContract(repository, id)).state?.terminal?.kind, "claimed");
});

test("audit renders the Verification summary from its CLI result", async () => {
  const pending = await bindAndDeliver("printf 'verification diagnostic\\n' >&2; exit 1");
  const audit = (await invokeRaw(executable(["-C", pending.raw.path, "audit", pending.id]), {
    environment: { KEIYAKU_ACTOR_ID: "cli-audit-test" },
  })) as unknown as { kind: string; report: { verification: { kind: string; summary?: string } } };
  assert.equal(audit.kind, "accepted");
  assert.equal(audit.report.verification.kind, "unsatisfied");
  assert.match(audit.report.verification.summary ?? "", /verification diagnostic/u);
  assert.match(renderText(audit as never, { columns: 400, color: false }), /verification diagnostic/u);
});
