import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { Keis, Keiyaku, Repo, Settings, World, type ExecutionObservation } from "../src/index.js";
import { assertWireRoundTrip } from "./support/schema-parity.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { verificationRequirement } from "../src/verification/declaration.js";
import type { DeliveryPreviewOutcome } from "../src/index.js";
import type { TestGitRepository } from "./support/git.js";
import { repositoryWithMain } from "./support/library-verbs.js";

function verificationBody(script: string | null = "exit 1"): string {
  return contractMarkdown("Audit", {
    Context: "Exercise the audit reader.",
    Objective: "Keep reports derived and compact.",
    Design: "Run the stored Verification.",
    Region: "~~~\nsrc/**\n~~~",
    Criteria: [
      "### Audit",
      "The report follows the journal.",
      ...(script === null ? [] : ["", "## Verification", "~~~bash timeout=5m", script, "~~~"]),
      "",
    ].join("\n"),
  });
}

function workspaceBytes(directory: string): unknown {
  return readdirSync(directory)
    .sort()
    .filter((name) => name !== ".git")
    .map((name) => {
      const path = join(directory, name);
      const stat = lstatSync(path);
      return [
        name,
        stat.mode,
        stat.isSymbolicLink()
          ? readlinkSync(path)
          : stat.isDirectory()
            ? workspaceBytes(path)
            : readFileSync(path).toString("base64"),
      ];
    });
}

function custodySnapshot(repository: TestGitRepository, worktree: string): unknown {
  const index = (path: string) =>
    readFileSync(resolve(path, repository.run(["-C", path, "rev-parse", "--git-path", "index"]).trim())).toString(
      "base64",
    );
  return {
    refs: repository.run(["for-each-ref", "--format=%(refname) %(objectname)"]),
    registrations: repository.run(["worktree", "list", "--porcelain"]),
    primaryIndex: index(repository.path),
    candidateIndex: index(worktree),
    primary: workspaceBytes(repository.path),
    candidate: workspaceBytes(worktree),
  };
}

test("native, invocation and CLI preview preserve authority, refs, real indexes and bytes without Verification or hooks", async () => {
  const { cliJson } = await import("./support/cli-fixtures.js");
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const verificationMarker = join(repository.path, "verification-ran");
  const hookMarker = join(repository.path, "hook-ran");
  const bound = accepted(
    await Keis.of(repo).bind({
      terms: verificationBody(`touch '${verificationMarker}'`),
      gates: ["reviewed", "verified"],
    }),
  );
  assert.ok(bound.worktreePath);
  const worktree = bound.worktreePath;
  writeFileSync(join(worktree, "candidate.txt"), "staged version\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  writeFileSync(join(worktree, "candidate.txt"), "final unstaged version\n");
  writeFileSync(join(worktree, "untracked.txt"), "untracked\n");
  mkdirSync(join(repository.path, ".keiyaku"), { recursive: true });
  const hook = { name: "marker", argv: ["bash", "-c", `touch '${hookMarker}'`], timeoutMs: 5000 };
  const hookSettings = JSON.stringify({ worktree: { create: [hook], destroy: [hook] } });
  writeFileSync(join(repository.path, ".keiyaku", "settings.json"), hookSettings);
  mkdirSync(join(worktree, ".keiyaku"), { recursive: true });
  writeFileSync(join(worktree, ".keiyaku", "settings.json"), hookSettings);
  repository.run(["-C", worktree, "add", ".keiyaku/settings.json"]);
  const configured = await Settings.load({ cwd: await World.at(repository.path) });
  const native = Keis.of(repo, { settings: configured }).kei({ id: bound.contractId });
  const before = custodySnapshot(repository, worktree);
  const history = await native.history();
  const blocked = await native.previewDelivery();
  assert.ok(blocked.kind === "blocked" && blocked.reason.kind === "dirty-workspace");
  const preview = await native.previewDelivery({ includeDirty: true, showDiff: true });
  assert.ok(preview.kind === "ready");
  assert.ok(preview.diff?.kind === "present");
  assert.match(preview.diff.text, /final unstaged version/u);
  assert.match(preview.diff.text, /untracked/u);
  assert.doesNotMatch(preview.diff.text, /^\+staged version$/mu);
  const requirement = verificationRequirement(
    decodeContractDocument(present(await native.state()).terms.document.bytes).verification[0]!,
  );
  assert.deepEqual(preview.unmetGates?.find((item) => item.gate === "verified"), {
    gate: "verified", requirement, state: "missing",
  });
  assert.equal(preview.target?.kind, "placeable");
  const cli = await cliJson<DeliveryPreviewOutcome>(
    ["-C", repository.path, "deliver", bound.contractId, "--dry-run", "--include-dirty", "--show-diff"],
    { environment: {} },
  );
  assert.equal(cli.exit, 0, cli.stderr);
  assert.deepEqual(cli.value, preview);
  const facet = Keiyaku.for({ cwd: worktree, repo: repository.path, environment: {} });
  const input = { contract: bound.contractId, dryRun: true as const, includeDirty: true, showDiff: true };
  const observations: ExecutionObservation[] = [];
  assert.deepEqual(await facet.deliver(input, { observe: (event) => { observations.push(event); } }), preview);
  assert.deepEqual(observations, [], "a preview emits no admission or mutation progress");
  assertWireRoundTrip(Keiyaku.verbs.deliver.output, preview);
  assert.deepEqual(await native.history(), history);
  assert.deepEqual(custodySnapshot(repository, worktree), before);
  assert.equal(existsSync(verificationMarker), false);
  assert.equal(existsSync(hookMarker), false);
});

test("preview reports integration conflicts without materializing a merge or changing custody", async () => {
  const repository = repositoryWithMain({ files: { "shared.txt": "base\n" } });
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ terms: verificationBody(null), gates: [] }));
  assert.ok(bound.worktreePath);
  const worktree = bound.worktreePath;
  writeFileSync(join(worktree, "shared.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "shared.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  writeFileSync(join(repository.path, "shared.txt"), "target\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "target"]);
  const before = custodySnapshot(repository, worktree);
  const history = await bound.kei.history();
  const result = await bound.kei.previewDelivery({ showDiff: true });
  assert.ok(result.kind === "blocked");
  assert.equal(result.reason.kind, "integration-conflict");
  assert.equal(repository.run(["-C", worktree, "ls-files", "-u"]), "");
  assert.deepEqual(custodySnapshot(repository, worktree), before);
  assert.deepEqual(await bound.kei.history(), history);
});
