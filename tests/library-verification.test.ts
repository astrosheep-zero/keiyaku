import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { withGitShim } from "./support/git.js";
import { bind, commitCandidate, document, repositoryWithMain } from "./support/library-verbs.js";

test("public deliver keeps its Verification admission in accepted facts", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 0");
  commitCandidate(repository);

  const delivered = await contract.deliver();
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver", "attestation", "claimed"]);
  assert.equal(delivered.head, (await contract.state()).head);
  assert.equal(delivered.value.integration.predecessor, (await contract.state()).delivery?.data.integration.predecessor);
  assert.equal("verification" in delivered.value, false);
  assert.equal("placement" in delivered.value, false);
  assert.equal((await contract.state()).attestations.at(-1)?.data.verdict, "satisfied");
});

test("status and audit expose only current Verification testimony", async () => {
  const repository = repositoryWithMain();
  const repo = Repo.at({ path: repository.path });
  const bound = await Keiyaku.bind({ repo,
    markdown: document('printf "checked"; printf "warning" >&2'),
    workspace: "here",
    gates: ["reviewed", "verified"],
  });
  commitCandidate(repository);

  const delivered = await bound.keiyaku.deliver();
  const state = await bound.keiyaku.state();
  const expected = {
    verdict: "satisfied" as const,
    summary: "[1 bash exit 0]\nstdout:\nchecked\nstderr:\nwarning",
  };
  const observed = await Keiyaku.observe({ repo, id: state.id });
  assert.equal(observed.kind, "present");
  if (observed.kind !== "present") throw new Error("contract was not observed");
  assert.deepEqual(observed.row.gates, {
    reports: [
      { gate: "reviewed", current: { kind: "missing" } },
      { gate: "verified", current: { kind: "attested", ...expected } },
    ],
    satisfied: false,
  });

  const audited = await bound.keiyaku.audit();
  assert.deepEqual(audited.value.timeline.at(-1)?.attestation, {
    gate: "verified",
    ...expected,
  });

  const amended = await bound.keiyaku.amend({
    markdown: "## Replace: Verification\n~~~bash\nprintf changed\n~~~\n",
  });
  const after = await Keiyaku.observe({ repo, id: state.id });
  assert.equal(after.kind, "present");
  if (after.kind !== "present") throw new Error("contract was not observed");
  assert.deepEqual(after.row.gates, {
    reports: [
      { gate: "reviewed", current: { kind: "missing" } },
      { gate: "verified", current: { kind: "stale", priorVerdict: "satisfied" } },
    ],
    satisfied: false,
  });
});

test("amend preserves untouched Verification bytes and currentness", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }),
    markdown: document("exit 0"),
    workspace: "here",
    gates: ["reviewed", "verified"],
  });
  const verificationSegment = (await bound.keiyaku.state()).terms.segments.at(-1);
  commitCandidate(repository);
  const delivered = await bound.keiyaku.deliver();

  const amended = await bound.keiyaku.amend({ markdown: "## Replace: Objective\nA narrower objective.\n" });
  const after = await bound.keiyaku.state();
  assert.equal(after.terms.segments.at(-1), verificationSegment);
  assert.match(after.terms.document.bytes, /~~~bash\nexit 0\n~~~/);

  const reviewed = await bound.keiyaku.review({ verdict: "satisfied" });
  assert.deepEqual(reviewed.facts.map((fact) => fact.kind), ["attestation", "claimed"]);
});

test("a declaration timeout admits unsatisfied testimony and leaves placement to gates", async () => {
  const openRepository = repositoryWithMain();
  const open = await Keiyaku.bind({ repo: Repo.at({ path: openRepository.path }),
    markdown: document("sleep 1").replace("~~~bash\n", "~~~bash timeout=25ms\n"),
    workspace: "here",
    gates: [],
  });
  commitCandidate(openRepository);
  const openDelivery = await open.keiyaku.deliver();
  assert.deepEqual(openDelivery.facts.map((fact) => fact.kind), ["bound", "deliver", "attestation", "claimed"]);
  assert.equal(openDelivery.facts.find((fact) => fact.kind === "attestation")?.data.verdict, "unsatisfied");
  assert.equal(openDelivery.value.verification, undefined);
  assert.equal(openDelivery.value.placement, undefined);
  assert.equal((await open.keiyaku.state()).terminal?.kind, "claimed");

  const gatedRepository = repositoryWithMain();
  const gated = await Keiyaku.bind({ repo: Repo.at({ path: gatedRepository.path }),
    markdown: document("sleep 1").replace("~~~bash\n", "~~~bash timeout=25ms\n"),
    workspace: "here",
    gates: ["verified"],
  });
  commitCandidate(gatedRepository);
  const gatedDelivery = await gated.keiyaku.deliver();
  assert.deepEqual(gatedDelivery.facts.map((fact) => fact.kind), ["bound", "deliver", "attestation"]);
  assert.equal(gatedDelivery.facts.find((fact) => fact.kind === "attestation")?.data.verdict, "unsatisfied");
  assert.equal(gatedDelivery.value.verification, undefined);
  assert.deepEqual(gatedDelivery.value.placement, {
    refusal: { kind: "gates-unsatisfied", contractId: (await gated.keiyaku.state()).id },
  });
});

function worktreeSettings(create: readonly string[], destroy: readonly string[] = []): string {
  return JSON.stringify({
    worktree: {
      create: create.length === 0 ? [] : [{ argv: create, timeoutMs: 30_000 }],
      destroy: destroy.length === 0 ? [] : [{ argv: destroy, timeoutMs: 30_000 }],
    },
  });
}

function writeCandidateSettings(repository: ReturnType<typeof repositoryWithMain>, settings: string): void {
  mkdirSync(join(repository.path, ".keiyaku"), { recursive: true });
  writeFileSync(join(repository.path, ".keiyaku", "settings.json"), settings);
  writeFileSync(join(repository.path, "package-lock.json"), "{}\n");
  repository.run(["add", ".keiyaku/settings.json", "package-lock.json"]);
  repository.run(["commit", "--quiet", "-m", "candidate settings"]);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("Verification provisions only the candidate Settings environment and destroys it afterward", async () => {
  const repository = repositoryWithMain();
  writeFileSync(join(repository.path, ".gitignore"), "node_modules/\n");
  repository.run(["add", ".gitignore"]);
  repository.run(["commit", "--quiet", "-m", "ignore caller dependencies"]);
  const destroyed = join(repository.path, "destroyed");
  const contract = await bind(repository, "test -f node_modules/candidate-ready && test ! -e node_modules/caller-only");
  const create = [process.execPath, "-e", [
    "const fs = require('node:fs');",
    "if (!fs.existsSync('package-lock.json')) process.exit(1);",
    "fs.mkdirSync('node_modules', { recursive: true });",
    "fs.writeFileSync('node_modules/candidate-ready', 'ready');",
  ].join(" ")];
  const destroy = [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(destroyed)}, 'destroyed')`];
  writeCandidateSettings(repository, worktreeSettings(create, destroy));
  mkdirSync(join(repository.path, "node_modules"), { recursive: true });
  writeFileSync(join(repository.path, "node_modules", "caller-only"), "caller\n");

  const delivered = await contract.deliver();

  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver", "attestation", "claimed"]);
  assert.equal(delivered.facts.find((fact) => fact.kind === "attestation")?.data.verdict, "satisfied");
  assert.equal(existsSync(destroyed), true);
});

test("candidate create failure stops Verification with no attestation and still runs destroy", async () => {
  const repository = repositoryWithMain();
  const destroyed = join(repository.path, "destroyed-after-create-failure");
  const contract = await bind(repository, `require('node:fs').writeFileSync(${JSON.stringify(join(repository.path, "verification-ran"))}, 'ran')`);
  const create = [process.execPath, "-e", "process.exit(17)"];
  const destroy = [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(destroyed)}, 'destroyed')`];
  writeCandidateSettings(repository, worktreeSettings(create, destroy));

  const delivered = await contract.deliver();

  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver"]);
  assert.equal(delivered.value.verification?.failure, "environment-failure");
  assert.equal(existsSync(join(repository.path, "verification-ran")), false);
  assert.equal(existsSync(destroyed), true);
});

test("candidate Settings failure is honest and has no command sentinel", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 0");
  writeCandidateSettings(repository, "{ not-json\n");

  const delivered = await contract.deliver();

  assert.equal(delivered.facts.some((fact) => fact.kind === "attestation"), false);
  assert.deepEqual(delivered.value.verification, {
    failure: "environment-failure",
    diagnostic: delivered.value.verification && "diagnostic" in delivered.value.verification
      ? delivered.value.verification.diagnostic
      : "",
  });
  assert.match(delivered.value.verification && "diagnostic" in delivered.value.verification
    ? delivered.value.verification.diagnostic
    : "", /project:/);
  assert.equal("command" in (delivered.value.verification ?? {}), false);
});

test("caller cancellation admits no attestation and still destroys scratch", async () => {
  const repository = repositoryWithMain();
  const started = join(repository.path, "verification-started");
  const destroyed = join(repository.path, "destroyed-after-cancel");
  const contract = await bind(repository, `${process.execPath} -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(started)}, "started")`)}; sleep 30`);
  writeCandidateSettings(repository, worktreeSettings([], [
    process.execPath,
    "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(destroyed)}, 'destroyed')`,
  ]));
  const controller = new AbortController();
  const pending = contract.deliver({ signal: controller.signal });
  await waitForFile(started);
  controller.abort();

  const delivered = await pending;
  assert.equal(delivered.facts.some((fact) => fact.kind === "attestation"), false);
  assert.deepEqual(delivered.value.verification, { failure: "cancelled" });
  assert.equal(existsSync(destroyed), true);
  assert.equal(repository.run(["worktree", "list", "--porcelain"]).includes("keiyaku-v4-verify-"), false);
});

test("destroy failure is cleanup evidence, not a leak after successful removal", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 0");
  writeCandidateSettings(repository, worktreeSettings([], [process.execPath, "-e", "process.exit(19)"]));

  const delivered = await contract.deliver();

  assert.deepEqual(delivered.value.cleanup, {
    phase: "destroy",
    command: 0,
    detail: { kind: "exit", code: 19, stdout: "", stderr: "", truncated: false },
  });
  assert.equal(delivered.value.leak, undefined);
  assert.equal(repository.run(["worktree", "list", "--porcelain"]).includes("keiyaku-v4-verify-"), false);
});

test("public deliver preserves admission when Verification cleanup leaks a worktree", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository, "exit 0");
  commitCandidate(repository);
  const delivered = await withGitShim(
    [
      "if [ \"$1\" = \"worktree\" ] && [ \"$2\" = \"remove\" ]; then",
      "  printf 'forced verification cleanup failure\\n' >&2",
      "  exit 17",
      "fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    {},
    () => contract.deliver(),
  );
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver", "attestation", "claimed"]);
  assert.equal(delivered.value.leak?.path.startsWith("/"), true);
  assert.match(delivered.value.leak?.diagnostic ?? "", /worktree remove --force .*forced verification cleanup failure/);
  repository.run(["worktree", "remove", "--force", delivered.value.leak!.path]);
});
