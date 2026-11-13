import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Keiyaku } from "../src/index.js";
import { classifyVerb } from "../src/library/keiyaku-classify.js";
import { contractOutcomeDisposition } from "../src/library/outcome.js";
import { createKeiyakuMcpServer } from "../src/mcp/adapter.js";
import type { VerificationCheck } from "../src/protocol/verify.js";
import { cliJson } from "./support/cli-fixtures.js";
import { accepted, commitCandidate, document, repositoryWithMain } from "./support/library-verbs.js";
import { temporaryDirectory } from "./support/process.js";

test("delivery accepts an identical target through native, CLI and MCP outcomes", async (t) => {
  const repository = repositoryWithMain();
  const home = temporaryDirectory(t, "keiyaku-disposition-home-");
  const environment = { HOME: home, USERPROFILE: home, KEIYAKU_HOME: home };
  const facet = Keiyaku.at({ cwd: repository.path, environment, home });
  const bound = accepted(await facet.bind({
    markdown: document(), target: "refs/heads/main", gates: ["reviewed"],
  }));
  assert.ok(bound.worktreePath);
  commitCandidate(repository, bound.worktreePath);
  const input = { contract: bound.contractId };
  const pending = accepted(await facet.deliver(input));
  assert.equal(pending.placement?.kind, "gates-unsatisfied");
  assert.equal(classifyVerb("deliver", input, { kind: "returned", value: pending }), "accepted");

  // The target independently acquires the candidate's tree under a different commit.
  writeFileSync(join(repository.path, "candidate.txt"), "candidate\n");
  repository.run(["add", "candidate.txt"]);
  repository.run(["commit", "--quiet", "-m", "target independently acquires candidate"]);
  const delivered = accepted(await facet.deliver(input));
  assert.equal(delivered.placement?.kind, "target-content-identical");
  assert.equal(classifyVerb("deliver", input, { kind: "returned", value: delivered }), "accepted");
  assert.equal(classifyVerb("deliver", input, { kind: "returned", value: {
    ...delivered,
    placement: {
      kind: "target-moved", target: "refs/heads/main", integration: delivered.integration, observed: null,
    },
  } }), "failed");

  const cli = await cliJson<typeof delivered>(["deliver", bound.contractId], {
    cwd: repository.path, environment,
  });
  assert.equal(cli.exit, 0, cli.stderr);
  assert.equal(cli.value.placement?.kind, "target-content-identical");

  const adapter = createKeiyakuMcpServer({ cwd: repository.path, environment, version: "test" });
  const client = new Client({ name: "contract-disposition", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await adapter.close(); });
  await Promise.all([client.connect(a), adapter.server.connect(b)]);
  const response = await client.callTool({ name: "deliver", arguments: input });
  assert.equal(response.isError, false);
  assert.equal(response._meta?.["keiyaku/disposition"], "accepted");
  assert.match(JSON.stringify(response.content), /target content identical/u);
});

test("verification admission stops retain failure and retry precedence over a negative verdict", () => {
  type Admission = Extract<VerificationCheck, { kind: "terminal" }>["admission"];
  for (const [admission, expected] of [
    ["admitted", "unsatisfied"],
    ["reused", "unsatisfied"],
    ["unrecorded", "unsatisfied"],
    [{ kind: "refused", reason: { kind: "terminal" } }, "failed"],
    [{ kind: "cancelled" }, "failed"],
    [{ kind: "retry", reason: "collision" }, "retryable"],
  ] satisfies readonly (readonly [Admission, string])[]) {
    assert.equal(contractOutcomeDisposition({
      kind: "accepted",
      checks: [{ kind: "terminal", index: 1, requirement: "check", verdict: "unsatisfied", summary: "exit 7", admission }],
    }), expected);
  }
});
