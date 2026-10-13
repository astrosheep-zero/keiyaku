import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { materializeScratchCandidate, removeCollectableScratchWorktrees } from "../src/git/scratch.js";
import { contractId, snapshotId } from "../src/core/facts/types.js";
import { projectSettings } from "../src/settings.js";
import { executeVerification } from "../src/verification/execution.js";
import type { VerificationObservation } from "../src/verification/observation.js";
import { appointedWorktreePath, withGitShim } from "./support/git.js";
import { document, repositoryWithMain, present, accepted } from "./support/library-verbs.js";

/** Recreate a dangling path after every successful `git worktree remove`, as a lost race would. */
const RECREATE_AFTER_REMOVAL_SHIM = [
  'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
  '  "$KEIYAKU_REAL_GIT" "$@"',
  "  status=$?",
  '  if [ "$status" -eq 0 ]; then',
  '    for arg in "$@"; do last="$arg"; done',
  '    ln -s "$KEIYAKU_MISSING_TARGET" "$last"',
  "  fi",
  '  exit "$status"',
  "fi",
  'exec "$KEIYAKU_REAL_GIT" "$@"',
].join("\n");

function ownershipLockFor(scratch: string): string {
  return join(realpathSync(tmpdir()), `.${basename(scratch)}.owner.sqlite`);
}

test("delivery prepares clean candidate scratch without importing worktree symlinks", async (t) => {
  for (const layout of ["external-dependencies", "workspace-self-link"]) {
    await t.test(layout, async () => {
      const raw = repositoryWithMain({
        files: { ".gitignore": "node_modules\nlocal-only.txt\n", "candidate.txt": "target\n" },
      });
      const declaration = [
        'test "$(cat node_modules/@fixture/self/candidate.txt)" = candidate',
        'test "$(readlink node_modules/@fixture/self)" = ../..',
        'printf "declaration-output\\n"',
      ].join(" && ");
      const bound = accepted(await Keiyaku.with().bind({
        repo: await Repo.at({ path: raw.path }),
        markdown: document(declaration),
        workspace: "worktree",
        gates: ["verified", "reviewed"],
      }));
      const source = await appointedWorktreePath(await repositoryAt(raw.path), (present(await bound.value.keiyaku.state())).id);
      const cleanupLog = join(raw.path, "cleanup.log");
      const setup = [
        'const fs = require("node:fs");',
        'const assert = require("node:assert/strict");',
        'assert.equal(fs.existsSync("local-only.txt"), false);',
        'assert.equal(fs.existsSync("node_modules"), false);',
        'assert.equal(fs.readFileSync("candidate.txt", "utf8"), "candidate\\n");',
        'fs.mkdirSync("node_modules/@fixture", { recursive: true });',
        'fs.symlinkSync("../..", "node_modules/@fixture/self", "dir");',
        'console.log("setup-output");',
      ].join("\n");
      const cleanup = [
        'const fs = require("node:fs");',
        'require("node:assert/strict").equal(fs.existsSync("node_modules/@fixture/self/candidate.txt"), true);',
        `fs.appendFileSync(${JSON.stringify(cleanupLog)}, process.cwd() + "\\n");`,
        'console.log("cleanup-output");',
      ].join("\n");
      mkdirSync(join(source, ".keiyaku"), { recursive: true });
      writeFileSync(
        join(source, ".keiyaku/settings.json"),
        JSON.stringify({
          worktree: {
            create: [{ name: "prepare", argv: [process.execPath, "-e", setup], timeoutMs: 5_000 }],
            destroy: [{ name: "retire", argv: [process.execPath, "-e", cleanup], timeoutMs: 5_000 }],
          },
        }),
      );
      writeFileSync(join(source, "candidate.txt"), "candidate\n");
      raw.run(["-C", source, "add", "-f", ".keiyaku/settings.json", "candidate.txt"]);
      raw.run(["-C", source, "commit", "--quiet", "-m", "candidate setup"]);
      writeFileSync(join(source, "local-only.txt"), "source-only\n");
      let sourceLink: string;
      let linkTarget: string;
      if (layout === "external-dependencies") {
        const dependencies = join(raw.path, "node_modules");
        mkdirSync(dependencies);
        writeFileSync(join(dependencies, "sentinel"), "untouched\n");
        sourceLink = join(source, "node_modules");
        linkTarget = relative(source, dependencies);
      } else {
        mkdirSync(join(source, "node_modules/@fixture"), { recursive: true });
        sourceLink = join(source, "node_modules/@fixture/self");
        linkTarget = "../..";
      }
      symlinkSync(linkTarget, sourceLink, "dir");

      const observations: VerificationObservation[] = [];
      const result = accepted(await bound.value.keiyaku.deliver(undefined, {
        observe: (event) => {
          if (event.kind === "verification") observations.push(event.observation);
        },
      }));

      const attestation = (present(await bound.value.keiyaku.state()))?.attestations.at(-1);
      assert.equal(attestation?.data.verdict, "satisfied", JSON.stringify(result));
      const scratch = observations.find((event) => event.phase === "materialize" && event.cwd)?.cwd;
      assert.ok(scratch);
      assert.notEqual(scratch, source);
      assert.equal(existsSync(scratch), false);
      assert.equal(existsSync(ownershipLockFor(scratch)), true);
      assert.equal(raw.run(["worktree", "list", "--porcelain"]).includes(scratch), false);
      assert.equal(readFileSync(cleanupLog, "utf8"), `${scratch}\n`);
      assert.deepEqual(
        [...new Set(observations.map((event) => event.phase))],
        ["materialize", "setup", "declaration", "cleanup"],
      );
      for (const phase of ["setup", "declaration", "cleanup"]) {
        assert.ok(observations.some((event) => event.kind === "output" && event.text.includes(`${phase}-output`)));
      }
      assert.equal(readlinkSync(sourceLink), linkTarget);
      assert.equal(readFileSync(join(source, "local-only.txt"), "utf8"), "source-only\n");
      if (layout === "external-dependencies")
        assert.equal(readFileSync(join(raw.path, "node_modules/sentinel"), "utf8"), "untouched\n");
    });
  }
});

test("clean scratch cleanup runs after setup or declaration failure and keeps the scene", async (t) => {
  for (const failure of ["setup", "declaration"]) {
    await t.test(failure, async () => {
      const raw = repositoryWithMain();
      const cleanupLog = join(raw.path, "cleanup.log");
      mkdirSync(join(raw.path, ".keiyaku"));
      writeFileSync(
        join(raw.path, ".keiyaku/settings.json"),
        JSON.stringify({
          worktree: {
            create: [
              {
                name: "prepare",
                argv: ["bash", "-c", failure === "setup" ? "exit 7" : "true"],
                timeoutMs: 5_000,
              },
            ],
            destroy: [
              {
                name: "retire",
                argv: [
                  process.execPath,
                  "-e",
                  `require("node:fs").writeFileSync(${JSON.stringify(cleanupLog)}, process.cwd());`,
                ],
                timeoutMs: 5_000,
              },
            ],
          },
        }),
      );
      raw.run(["add", ".keiyaku/settings.json"]);
      raw.run(["commit", "--quiet", "-m", "scratch failure hooks"]);
      const observations: VerificationObservation[] = [];
      const execution = await executeVerification({
        repository: await repositoryAt(raw.path),
        candidate: snapshotId(raw.run(["rev-parse", "HEAD"]).trim()),
        contractId: contractId("kei/scratch-failure"),
        declarations: [{ executor: "bash", script: "exit 9" }],
        materializeScratchCandidate,
        projectSettings,
        observe: (event) => observations.push(event),
      });

      if (failure === "setup") {
        assert.equal(execution.outcome.kind, "environment-failure");
        assert.ok("name" in execution.outcome && execution.outcome.name === "prepare");
        assert.equal(
          observations.some((event) => event.phase === "declaration"),
          false,
        );
      } else {
        assert.ok(execution.outcome.kind === "terminal" && execution.outcome.verdict === "unsatisfied");
      }
      const scratch = readFileSync(cleanupLog, "utf8");
      assert.equal(existsSync(scratch), true);
      assert.equal(execution.cleanup, undefined);
      assert.equal(execution.leak?.path, scratch);
      const removals = await removeCollectableScratchWorktrees(
        await repositoryAt(raw.path), new Set([scratch]), contractId("kei/scratch-failure"),
      );
      assert.equal(removals[0]?.retained, false);
    });
  }
});

test("a prior failed scratch removal stops the next attempt with its leak diagnostic", async () => {
  const raw = repositoryWithMain();
  const git = await repositoryAt(raw.path);
  const id = contractId("kei/removal-failure");
  const candidate = snapshotId(raw.run(["rev-parse", "HEAD"]).trim());
  const scratch = await materializeScratchCandidate(git, candidate, id);
  writeFileSync(join(scratch.cwd, "scene.log"), "retained\n");
  await scratch.dispose(true);
  try {
    await withGitShim(
      'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then echo "removal denied" >&2; exit 7; fi\nexec "$KEIYAKU_REAL_GIT" "$@"',
      {},
      async (gitPath) => {
        const result = await executeVerification({
          repository: await repositoryAt(raw.path, gitPath),
          candidate,
          contractId: id,
          declarations: [{ executor: "bash", script: "touch second-attempt" }],
          materializeScratchCandidate,
          projectSettings,
        });
        assert.equal(result.outcome.kind, "candidate-unavailable");
        assert.equal(result.leak?.path, scratch.cwd);
        assert.match(result.leak?.diagnostic ?? "", /removal denied/u);
        assert.equal(readFileSync(join(scratch.cwd, "scene.log"), "utf8"), "retained\n");
        assert.equal(existsSync(join(scratch.cwd, "second-attempt")), false);
      },
    );
  } finally {
    await removeCollectableScratchWorktrees(git, new Set([scratch.cwd]), id);
  }
});

test("scratch disposal names its bounded removal timeout and keeps ownership evidence", async (context) => {
  const repository = repositoryWithMain();
  const git = await repositoryAt(repository.path);
  const scratch = await materializeScratchCandidate(git, snapshotId(repository.run(["rev-parse", "HEAD"]).trim()));
  const lock = ownershipLockFor(scratch.cwd);
  try {
    context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
      assert.equal(milliseconds, 120_000);
      const controller = new AbortController();
      controller.abort(new Error("TimeoutError"));
      return controller.signal;
    });
    const leak = await scratch.dispose();
    assert.ok(leak !== null);
    assert.match(leak.diagnostic, /scratch worktree removal timed out after 120000ms/u);
    assert.match(leak.diagnostic, /git process cancelled/u);
    assert.equal(existsSync(scratch.cwd), true);
    assert.equal(existsSync(lock), true);
  } finally {
    context.mock.restoreAll();
    repository.run(["worktree", "remove", "--force", scratch.cwd]);
    rmSync(lock, { force: true });
  }
});

test("scratch disposal that leaves a recreated path keeps custody and reports residue", async () => {
  const repository = repositoryWithMain();
  await withGitShim(
    RECREATE_AFTER_REMOVAL_SHIM,
    { KEIYAKU_MISSING_TARGET: join(repository.path, "missing-scratch-target") },
    async (gitPath) => {
      const scratch = await materializeScratchCandidate(
        await repositoryAt(repository.path, gitPath),
        snapshotId(repository.run(["rev-parse", "HEAD"]).trim()),
      );
      const lock = ownershipLockFor(scratch.cwd);
      try {
        const leak = await scratch.dispose();
        assert.ok(leak !== null);
        assert.match(leak.diagnostic, /worktree removal but the path remains/u);
        assert.equal(lstatSync(scratch.cwd).isSymbolicLink(), true);
        assert.equal(existsSync(lock), true);
      } finally {
        rmSync(scratch.cwd, { force: true });
        rmSync(lock, { force: true });
      }
    },
  );
});

test("collectable scratch removal that leaves residue keeps custody and cites the path", async () => {
  const repository = repositoryWithMain();
  const scratch = join(realpathSync(tmpdir()), `keiyaku-v4-verify-${randomBytes(12).toString("hex")}`);
  const lock = ownershipLockFor(scratch);
  repository.run(["worktree", "add", "--detach", scratch, "HEAD"]);
  await withGitShim(
    RECREATE_AFTER_REMOVAL_SHIM,
    { KEIYAKU_MISSING_TARGET: join(repository.path, "missing-scratch-target") },
    async (gitPath) => {
      const removals = await removeCollectableScratchWorktrees(await repositoryAt(repository.path, gitPath), new Set([scratch]));
      assert.deepEqual(removals, [
        {
          path: scratch,
          retained: true,
          diagnostic: `Git reported scratch worktree removal but the path remains: ${scratch}`,
        },
      ]);
      assert.equal(lstatSync(scratch).isSymbolicLink(), true);
      assert.equal(existsSync(lock), true);
    },
  );
  rmSync(scratch, { force: true });
  rmSync(lock, { force: true });
});
