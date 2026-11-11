import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, basename } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { Keis, Repo } from "../src/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { materializeScratchCandidate, removeCollectableScratchWorktrees } from "../src/git/scratch.js";
import { contractId, snapshotId } from "../src/core/facts/types.js";
import { contractLocator, gitRefLocator } from "../src/git/identity.js";
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

const SELECTED = { index: 1, total: 1, requirement: "fixture" } as const;

function retainedPathFor(
  repository: Awaited<ReturnType<typeof repositoryAt>>,
  contract: ReturnType<typeof contractId>,
): string {
  const requirement = createHash("sha256").update(SELECTED.requirement).digest("hex");
  return join(
    realpathSync(tmpdir()),
    `keiyaku-v4-verify-${gitRefLocator(repository.commonDirectory)}-${contractLocator(contract)}-${requirement}`,
  );
}

function ownershipLockFor(scratch: string): string {
  return join(realpathSync(tmpdir()), `.${basename(scratch)}.owner.sqlite`);
}

test("explicit verification prepares clean candidate scratch without importing worktree symlinks", async (t) => {
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
      const bound = accepted(
        await Keis.of(await Repo.at({ path: raw.path })).bind({
          markdown: document(declaration),
          gates: ["verified", "reviewed"],
        }),
      );
      const source = await appointedWorktreePath(
        await repositoryAt(raw.path),
        present(await bound.kei.state()).id,
      );
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
      const result = await executeVerification({
        repository: await repositoryAt(raw.path),
        candidate: snapshotId(raw.run(["-C", source, "rev-parse", "HEAD"]).trim()),
        contractId: present(await bound.kei.state()).id,
        ...SELECTED,
        declaration: { executor: "bash", script: declaration },
        materializeScratchCandidate,
        projectSettings,
        observe: (event) => observations.push(event),
      });

      assert.ok(result.outcome.kind === "terminal" && result.outcome.verdict === "satisfied", JSON.stringify(result));
      const scratch = observations.find((event) => event.phase === "materialize" && event.cwd)?.cwd;
      assert.ok(scratch);
      assert.notEqual(scratch, source);
      assert.equal(existsSync(scratch), false);
      assert.equal(existsSync(ownershipLockFor(scratch)), false);
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
        ...SELECTED,
        declaration: { executor: "bash", script: "exit 9" },
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
      assert.equal(existsSync(scratch), false);
      assert.equal(existsSync(ownershipLockFor(scratch)), false);
      assert.equal(execution.cleanup, undefined);
      assert.ok(execution.leak?.path);
      assert.equal(existsSync(execution.leak.path), true);
      const removals = await removeCollectableScratchWorktrees(
        await repositoryAt(raw.path),
        new Set([execution.leak.path]),
        contractId("kei/scratch-failure"),
      );
      assert.equal(removals[0]?.retained, false);
    });
  }
});

test("concurrent scratches for one Contract execute independently and dispose only themselves", async () => {
  const raw = repositoryWithMain();
  const git = await repositoryAt(raw.path);
  const candidate = snapshotId(raw.run(["rev-parse", "HEAD"]).trim());
  const id = contractId("kei/concurrent-scratch");
  const first = await materializeScratchCandidate(git, candidate, id, SELECTED.requirement);
  try {
    const second = await materializeScratchCandidate(
      { ...git, signal: AbortSignal.timeout(5_000) },
      candidate,
      id,
      SELECTED.requirement,
    );
    try {
      assert.notEqual(first.cwd, second.cwd);
      assert.match(basename(second.cwd), /^keiyaku-v4-verify-[0-9a-f]{24}$/u);
      assert.equal(existsSync(first.cwd), true);
      assert.deepEqual(await removeCollectableScratchWorktrees(git, new Set([first.cwd, second.cwd]), id), []);
      assert.equal(await first.dispose(), null);
      assert.equal(existsSync(second.cwd), true);
      assert.equal(await second.dispose(), null);
    } finally {
      await second.dispose();
    }
  } finally {
    await first.dispose();
  }
});

test("failed attempts replace only their requirement's detached retained scene", async () => {
  const raw = repositoryWithMain();
  const git = await repositoryAt(raw.path);
  const id = contractId("kei/retained-scratch");
  const retained = retainedPathFor(git, id);
  const firstCandidate = snapshotId(raw.run(["rev-parse", "HEAD"]).trim());
  const first = await materializeScratchCandidate(git, firstCandidate, id, SELECTED.requirement);
  try {
    writeFileSync(join(first.cwd, "scene.log"), "first\n");
    assert.deepEqual(await first.dispose(true), {
      path: retained,
      diagnostic: "failed Verification scratch retained for diagnosis",
    });
    assert.equal(existsSync(first.cwd), false);
    assert.equal(existsSync(ownershipLockFor(first.cwd)), false);
    assert.equal(raw.run(["-C", retained, "rev-parse", "HEAD"]).trim(), firstCandidate);
    assert.match(
      raw.run(["worktree", "list", "--porcelain"]),
      new RegExp(`worktree ${retained}\\nHEAD ${firstCandidate}\\ndetached`, "u"),
    );
    assert.equal(readFileSync(join(retained, "scene.log"), "utf8"), "first\n");
    assert.deepEqual(await removeCollectableScratchWorktrees(git, new Set([retained])), []);

    writeFileSync(join(raw.path, "next.txt"), "next\n");
    raw.run(["add", "next.txt"]);
    raw.run(["commit", "--quiet", "-m", "second candidate"]);
    const secondCandidate = snapshotId(raw.run(["rev-parse", "HEAD"]).trim());
    const second = await materializeScratchCandidate(git, secondCandidate, id, SELECTED.requirement);
    try {
      assert.equal(readFileSync(join(retained, "scene.log"), "utf8"), "first\n");
      writeFileSync(join(second.cwd, "scene.log"), "second\n");
      assert.deepEqual(await second.dispose(true), {
        path: retained,
        diagnostic: "failed Verification scratch retained for diagnosis (replaced the previous retained scratch)",
      });
      assert.equal(existsSync(second.cwd), false);
      assert.equal(existsSync(ownershipLockFor(second.cwd)), false);
      assert.equal(raw.run(["-C", retained, "rev-parse", "HEAD"]).trim(), secondCandidate);
      assert.equal(readFileSync(join(retained, "scene.log"), "utf8"), "second\n");
      assert.deepEqual(
        raw
          .run(["worktree", "list", "--porcelain"])
          .split("\n")
          .filter((line) => line.includes("keiyaku-v4-verify-")),
        [`worktree ${retained}`],
      );
    } finally {
      await second.dispose();
    }
  } finally {
    await first.dispose();
    const removals = await removeCollectableScratchWorktrees(git, new Set([retained]), id);
    assert.equal(removals[0]?.retained, false);
  }
});

test("selected declarations get independent scenes with setup and cleanup for each", async () => {
  const raw = repositoryWithMain();
  const cleanupLog = join(raw.path, "scratch-cleanup.log");
  mkdirSync(join(raw.path, ".keiyaku"));
  writeFileSync(
    join(raw.path, ".keiyaku/settings.json"),
    JSON.stringify({
      worktree: {
        create: [{ name: "prepare", argv: ["bash", "-c", "touch setup-ready"], timeoutMs: 5_000 }],
        destroy: [
          {
            name: "retire",
            argv: [
              process.execPath,
              "-e",
              `require("node:fs").appendFileSync(${JSON.stringify(cleanupLog)}, process.cwd() + "\\n")`,
            ],
            timeoutMs: 5_000,
          },
        ],
      },
    }),
  );
  raw.run(["add", ".keiyaku/settings.json"]);
  raw.run(["commit", "--quiet", "-m", "scratch hooks"]);
  const git = await repositoryAt(raw.path);
  const candidate = snapshotId(raw.run(["rev-parse", "HEAD"]).trim());
  const id = contractId("kei/independent-declarations");
  const scenes: string[] = [];
  const retained: string[] = [];
  try {
    for (const [position, script] of [
      "test -f setup-ready && touch build-output",
      "test -f setup-ready && test ! -e build-output",
      "test -f build-output",
    ].entries()) {
      const result = await executeVerification({
        repository: git,
        candidate,
        contractId: id,
        requirement: `check-${position}`,
        index: position + 1,
        total: 3,
        declaration: { executor: "bash", script },
        materializeScratchCandidate,
        projectSettings,
        observe: (event) => {
          if (event.phase === "materialize" && event.cwd) scenes.push(event.cwd);
        },
      });
      assert.ok(result.outcome.kind === "terminal");
      assert.equal(result.outcome.verdict, position < 2 ? "satisfied" : "unsatisfied");
      if (result.leak?.path) retained.push(result.leak.path);
    }
    assert.equal(new Set(scenes).size, 3);
    assert.deepEqual(readFileSync(cleanupLog, "utf8").trim().split("\n"), scenes);
    for (const scene of scenes) assert.equal(existsSync(scene), false);
    assert.equal(retained.length, 1);
    assert.equal(existsSync(retained[0]!), true);
  } finally {
    await removeCollectableScratchWorktrees(git, new Set(retained), id);
  }
});

test("retention and terminal collection preserve other requirements and Contracts", async () => {
  const raw = repositoryWithMain();
  const git = await repositoryAt(raw.path);
  const candidate = snapshotId(raw.run(["rev-parse", "HEAD"]).trim());
  const id = contractId("kei/multiple-retained-scenes");
  const other = contractId("kei/other-retained-scene");
  const retained = new Set<string>();
  async function fail(contract: ReturnType<typeof contractId>, requirement: string, contents: string): Promise<string> {
    const scratch = await materializeScratchCandidate(git, candidate, contract, requirement);
    writeFileSync(join(scratch.cwd, "scene.log"), contents);
    const leak = await scratch.dispose(true);
    assert.ok(leak?.path);
    retained.add(leak.path);
    return leak.path;
  }
  try {
    const alpha = await fail(id, "opaque/alpha", "alpha original");
    const beta = await fail(id, "opaque/beta", "beta original");
    const foreign = await fail(other, "opaque/alpha", "other contract");
    assert.notEqual(alpha, beta);
    assert.notEqual(alpha, foreign);
    assert.equal(await fail(id, "opaque/alpha", "alpha replacement"), alpha);
    assert.equal(readFileSync(join(alpha, "scene.log"), "utf8"), "alpha replacement");
    assert.equal(readFileSync(join(beta, "scene.log"), "utf8"), "beta original");
    assert.deepEqual(await removeCollectableScratchWorktrees(git, new Set(retained)), []);
    const owner = new DatabaseSync(ownershipLockFor(beta));
    owner.exec("BEGIN EXCLUSIVE");
    try {
      const removals = await removeCollectableScratchWorktrees(git, new Set(retained), id);
      assert.deepEqual(
        removals.map((removal) => ({ path: removal.path, retained: removal.retained })),
        [{ path: alpha, retained: false }],
      );
      assert.equal(existsSync(beta), true);
      assert.equal(existsSync(foreign), true);
    } finally {
      owner.exec("ROLLBACK");
      owner.close();
    }
    const retired = await removeCollectableScratchWorktrees(git, new Set([beta, foreign]), id);
    assert.deepEqual(
      retired.map((removal) => ({ path: removal.path, retained: removal.retained })),
      [{ path: beta, retained: false }],
    );
    assert.equal(existsSync(beta), false);
    assert.equal(readFileSync(join(foreign, "scene.log"), "utf8"), "other contract");
  } finally {
    await removeCollectableScratchWorktrees(git, new Set(retained), id);
    await removeCollectableScratchWorktrees(git, new Set(retained), other);
  }
});

test("failed retention with no residue reports only its reason and preserves the verdict", async () => {
  const raw = repositoryWithMain();
  const git = await repositoryAt(raw.path);
  const id = contractId("kei/retention-no-residue");
  const retained = retainedPathFor(git, id);
  assert.equal(existsSync(retained), false);
  await withGitShim(
    'if [ "$1" = "worktree" ] && [ "$2" = "move" ]; then echo "move denied" >&2; exit 7; fi\nexec "$KEIYAKU_REAL_GIT" "$@"',
    {},
    async (gitPath) => {
      let executionPath: string | undefined;
      const result = await executeVerification({
        repository: await repositoryAt(raw.path, gitPath),
        candidate: snapshotId(raw.run(["rev-parse", "HEAD"]).trim()),
        contractId: id,
        ...SELECTED,
        declaration: { executor: "bash", script: "false" },
        materializeScratchCandidate,
        projectSettings,
        observe: (event) => {
          if (event.phase === "materialize" && event.cwd) executionPath = event.cwd;
        },
      });
      assert.deepEqual(result.outcome, {
        kind: "terminal",
        verdict: "unsatisfied",
        summary: "[1 bash exit 1]",
      });
      assert.ok(result.leak);
      assert.equal("path" in result.leak, false);
      assert.match(result.leak.diagnostic, /failed Verification scratch could not be retained: .*move denied/su);
      assert.ok(executionPath);
      assert.equal(existsSync(executionPath), false);
      assert.equal(existsSync(ownershipLockFor(executionPath)), false);
      assert.equal(existsSync(retained), false);
      assert.doesNotMatch(raw.run(["worktree", "list", "--porcelain"]), /keiyaku-v4-verify-/u);
    },
  );
});

test("failed retained removal retires only the new scene and preserves its verdict", async () => {
  const raw = repositoryWithMain();
  const git = await repositoryAt(raw.path);
  const id = contractId("kei/removal-failure");
  const candidate = snapshotId(raw.run(["rev-parse", "HEAD"]).trim());
  const scratch = await materializeScratchCandidate(git, candidate, id, SELECTED.requirement);
  writeFileSync(join(scratch.cwd, "scene.log"), "retained\n");
  const retained = await scratch.dispose(true);
  assert.ok(retained?.path);
  const retainedPath = retained.path;
  try {
    await withGitShim(
      'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then\n  for arg in "$@"; do last="$arg"; done\n  if [ "$last" = "$KEIYAKU_RETAINED" ]; then echo "removal denied" >&2; exit 7; fi\nfi\nexec "$KEIYAKU_REAL_GIT" "$@"',
      { KEIYAKU_RETAINED: retained.path },
      async (gitPath) => {
        let executionPath: string | undefined;
        const result = await executeVerification({
          repository: await repositoryAt(raw.path, gitPath),
          candidate,
          contractId: id,
          ...SELECTED,
          declaration: { executor: "bash", script: "touch second-attempt; false" },
          materializeScratchCandidate,
          projectSettings,
          observe: (event) => {
            if (event.phase === "materialize" && event.cwd) executionPath = event.cwd;
          },
        });
        assert.ok(result.outcome.kind === "terminal" && result.outcome.verdict === "unsatisfied");
        assert.ok(result.leak);
        assert.equal("path" in result.leak, false);
        assert.match(
          result.leak?.diagnostic ?? "",
          /failed Verification scratch could not be retained: .*removal denied/su,
        );
        assert.ok(executionPath);
        assert.equal(existsSync(executionPath), false);
        assert.equal(existsSync(ownershipLockFor(executionPath)), false);
        assert.equal(readFileSync(join(retainedPath, "scene.log"), "utf8"), "retained\n");
        assert.equal(existsSync(join(retainedPath, "second-attempt")), false);
      },
    );
  } finally {
    await removeCollectableScratchWorktrees(git, new Set([retained.path]), id);
  }
});

test("satisfied and cancelled attempts remove only their own scenes", async () => {
  const raw = repositoryWithMain();
  const git = await repositoryAt(raw.path);
  const id = contractId("kei/preserved-scratch");
  const candidate = snapshotId(raw.run(["rev-parse", "HEAD"]).trim());
  const scratch = await materializeScratchCandidate(git, candidate, id, SELECTED.requirement);
  writeFileSync(join(scratch.cwd, "scene.log"), "retained\n");
  const retained = await scratch.dispose(true);
  assert.ok(retained?.path);
  const paths: string[] = [];
  const observe = (event: VerificationObservation) => {
    if (event.phase === "materialize" && event.cwd) paths.push(event.cwd);
  };
  const input = {
    repository: git,
    candidate,
    contractId: id,
    ...SELECTED,
    materializeScratchCandidate,
    projectSettings,
    observe,
  };
  try {
    const satisfied = await executeVerification({ ...input, declaration: { executor: "bash", script: "true" } });
    assert.deepEqual(satisfied, { outcome: { kind: "terminal", verdict: "satisfied" } });
    assert.equal(readFileSync(join(retained.path, "scene.log"), "utf8"), "retained\n");
    const controller = new AbortController();
    const cancelled = await executeVerification({
      ...input,
      repository: { ...git, signal: controller.signal },
      signal: controller.signal,
      declaration: { executor: "bash", script: "printf ready; sleep 30" },
      observe: (event) => {
        observe(event);
        if (event.kind === "output" && event.phase === "declaration") controller.abort();
      },
    });
    assert.equal(cancelled.outcome.kind, "cancelled");
    assert.equal(cancelled.leak, undefined);
    assert.equal(paths.length, 2);
    for (const path of paths) {
      assert.equal(existsSync(path), false);
      assert.equal(existsSync(ownershipLockFor(path)), false);
    }
    assert.equal(readFileSync(join(retained.path, "scene.log"), "utf8"), "retained\n");
  } finally {
    await removeCollectableScratchWorktrees(git, new Set([retained.path]), id);
  }
});

test("pre-spawn cancellation releases ownership only after scratch absence is proved", async (t) => {
  for (const observationFails of [false, true]) {
    await t.test(
      observationFails ? "unknown absence retains cleanup diagnostics" : "proved absence is not a leak",
      async (context) => {
        const raw = repositoryWithMain();
        const commands = join(raw.path, "git-commands");
        const deny = join(raw.path, "deny-observation");
        await withGitShim(
          [
            'printf "%s\\n" "$*" >> "$COMMANDS"',
            'if [ -f "$DENY" ] && [ "$1" = "worktree" ]; then',
            '  if [ "$2" = "list" ]; then echo "registration observation denied" >&2; exit 7; fi',
            '  if [ "$2" = "remove" ]; then echo "scratch removal denied" >&2; exit 8; fi',
            "fi",
            'exec "$KEIYAKU_REAL_GIT" "$@"',
          ].join("\n"),
          { COMMANDS: commands, DENY: deny },
          async (gitPath) => {
            const repository = await repositoryAt(raw.path, gitPath);
            rmSync(commands);
            if (observationFails) writeFileSync(deny, "deny\n");
            const controller = new AbortController();
            let lockPath: string | undefined;
            const exec = DatabaseSync.prototype.exec;
            const injection = context.mock.method(
              DatabaseSync.prototype,
              "exec",
              function (this: DatabaseSync, sql: string) {
                const result = exec.call(this, sql);
                if (sql === "BEGIN EXCLUSIVE") {
                  const file = this.prepare("PRAGMA database_list").get()?.file;
                  assert.equal(typeof file, "string");
                  lockPath = String(file);
                  assert.match(basename(lockPath), /^\.keiyaku-v4-verify-[0-9a-f]{24}\.owner\.sqlite$/u);
                  assert.equal(existsSync(lockPath), true);
                  // The ownership transaction is live, but executeGit has not been entered or spawned yet.
                  controller.abort(new Error("cancel before Git spawn"));
                }
                return result;
              },
            );
            try {
              const result = await executeVerification({
                repository: { ...repository, signal: controller.signal },
                candidate: snapshotId(raw.run(["rev-parse", "HEAD"]).trim()),
                contractId: contractId("kei/pre-spawn-cancellation"),
                ...SELECTED,
                declaration: { executor: "bash", script: "false" },
                materializeScratchCandidate,
                projectSettings,
                signal: controller.signal,
              });
              assert.ok(lockPath);
              const scratch = join(realpathSync(tmpdir()), basename(lockPath).slice(1, -".owner.sqlite".length));
              const calls = readFileSync(commands, "utf8");
              assert.doesNotMatch(calls, /worktree add/u);
              assert.equal(existsSync(scratch), false);
              assert.equal(raw.run(["worktree", "list", "--porcelain"]).includes(scratch), false);
              assert.deepEqual(result.outcome, { kind: "cancelled" });
              assert.equal(existsSync(lockPath), observationFails);
              if (observationFails) {
                assert.equal(result.leak?.path, scratch);
                assert.match(result.leak?.diagnostic ?? "", /git process cancelled/u);
                assert.match(result.leak?.diagnostic ?? "", /registration observation denied/u);
                assert.match(result.leak?.diagnostic ?? "", /scratch removal denied/u);
                assert.match(calls, /worktree remove/u);
              } else {
                assert.equal(result.leak, undefined);
                assert.doesNotMatch(calls, /worktree remove/u);
              }
            } finally {
              injection.mock.restore();
              if (lockPath !== undefined) rmSync(lockPath, { force: true });
            }
          },
        );
      },
    );
  }
});

test("explicit verification retires a partially materialized scratch after post-checkout cancellation", async (t) => {
  for (const removalFails of [false, true]) {
    await t.test(removalFails ? "removal failure stays visible" : "successful removal leaves no custody", async () => {
      const raw = repositoryWithMain();
      const marker = join(raw.path, "checkout-started");
      const hook = join(raw.path, ".git/hooks/post-checkout");
      await withGitShim(
        [
          'if [ "$1" = "worktree" ] && [ "$2" = "remove" ] && [ "$DENY_REMOVAL" = "yes" ]; then',
          '  echo "cancelled scratch removal denied" >&2; exit 7',
          "fi",
          'exec "$KEIYAKU_REAL_GIT" "$@"',
        ].join("\n"),
        { DENY_REMOVAL: removalFails ? "yes" : "no" },
        async (gitPath) => {
          const bound = accepted(
            await Keis.of(await Repo.at({ path: raw.path, gitPath })).bind({
              markdown: document("touch declaration-ran"),
              gates: ["verified", "reviewed"],
            }),
          );
          const source = await appointedWorktreePath(
            await repositoryAt(raw.path),
            present(await bound.kei.state()).id,
          );
          writeFileSync(
            hook,
            [
              "#!/bin/sh",
              'case "$PWD" in',
              "  */keiyaku-v4-verify-*)",
              `    printf '%s' "$PWD" > '${marker}.tmp'`,
              `    mv '${marker}.tmp' '${marker}'`,
              '    echo "post-checkout interrupted" >&2',
              "    while :; do sleep 1; done ;;",
              "esac",
            ].join("\n"),
            { mode: 0o755 },
          );
          const controller = new AbortController();
          const pending = executeVerification({
            repository: { ...(await repositoryAt(raw.path, gitPath)), signal: controller.signal },
            candidate: snapshotId(raw.run(["-C", source, "rev-parse", "HEAD"]).trim()),
            contractId: present(await bound.kei.state()).id,
            ...SELECTED,
            declaration: { executor: "bash", script: "touch declaration-ran" },
            materializeScratchCandidate,
            projectSettings,
            signal: controller.signal,
          });
          try {
            const deadline = AbortSignal.timeout(10_000);
            while (!existsSync(marker)) {
              deadline.throwIfAborted();
              await setTimeout(10);
            }
            const scratch = readFileSync(marker, "utf8");
            // The hook is still running: add has registered and populated the worktree before it throws.
            assert.equal(existsSync(join(scratch, ".git")), true);
            assert.equal(existsSync(ownershipLockFor(scratch)), true);
            assert.ok(raw.run(["worktree", "list", "--porcelain"]).includes(scratch));
            controller.abort(new Error("cancel during post-checkout"));
            const result = await pending;
            assert.equal(result.outcome.kind, "cancelled", JSON.stringify(result));
            if (removalFails) {
              assert.equal(result.leak?.path, scratch);
              assert.ok(result.leak?.diagnostic.includes(scratch));
              assert.match(result.leak?.diagnostic ?? "", /worktree add --detach.*post-checkout interrupted/su);
              assert.match(result.leak?.diagnostic ?? "", /cancelled scratch removal denied/u);
            } else {
              assert.equal(result.leak, undefined);
            }
            assert.equal(existsSync(scratch), removalFails);
            assert.equal(existsSync(ownershipLockFor(scratch)), removalFails);
            assert.equal(raw.run(["worktree", "list", "--porcelain"]).includes(scratch), removalFails);
            assert.equal(existsSync(join(source, ".git")), true);
            assert.equal(existsSync(join(scratch, "declaration-ran")), false);
            assert.equal(present(await bound.kei.state()).attestations.length, 0);
          } finally {
            controller.abort();
            await pending.catch(() => undefined);
            rmSync(hook, { force: true });
            if (existsSync(marker)) {
              const scratch = readFileSync(marker, "utf8");
              if (existsSync(scratch)) {
                const removals = await removeCollectableScratchWorktrees(
                  await repositoryAt(raw.path),
                  new Set([scratch]),
                );
                assert.equal(removals[0]?.retained, false);
              }
            }
          }
        },
      );
    });
  }
});

test("ordinary post-checkout failure removes partial scratch and permits another attempt", async () => {
  const raw = repositoryWithMain();
  const marker = join(raw.path, "checkout-started");
  const hook = join(raw.path, ".git/hooks/post-checkout");
  writeFileSync(hook, `#!/bin/sh\nprintf '%s' "$PWD" > '${marker}'\necho 'checkout failed' >&2\nexit 7\n`, {
    mode: 0o755,
  });
  const input = {
    repository: await repositoryAt(raw.path),
    candidate: snapshotId(raw.run(["rev-parse", "HEAD"]).trim()),
    contractId: contractId("kei/checkout-failure"),
    ...SELECTED,
    declaration: { executor: "bash" as const, script: "true" },
    materializeScratchCandidate,
    projectSettings,
  };
  try {
    const result = await executeVerification(input);
    assert.ok(result.outcome.kind === "candidate-unavailable");
    assert.match(result.outcome.diagnostic, /checkout failed/u);
    assert.equal(result.leak, undefined);
    const scratch = readFileSync(marker, "utf8");
    assert.equal(existsSync(scratch), false);
    assert.equal(existsSync(ownershipLockFor(scratch)), false);
    assert.equal(raw.run(["worktree", "list", "--porcelain"]).includes(scratch), false);
  } finally {
    rmSync(hook, { force: true });
    if (existsSync(marker)) {
      const scratch = readFileSync(marker, "utf8");
      if (existsSync(scratch)) await removeCollectableScratchWorktrees(input.repository, new Set([scratch]));
    }
  }
  assert.deepEqual(await executeVerification(input), {
    outcome: { kind: "terminal", verdict: "satisfied" },
  });
});

test("scratch disposal names its bounded removal timeout and keeps ownership evidence", async (context) => {
  const repository = repositoryWithMain();
  const git = await repositoryAt(repository.path);
  const scratch = await materializeScratchCandidate(
    git,
    snapshotId(repository.run(["rev-parse", "HEAD"]).trim()),
    contractId("kei/removal-timeout"),
    SELECTED.requirement,
  );
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
        contractId("kei/removal-residue"),
        SELECTED.requirement,
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
      const removals = await removeCollectableScratchWorktrees(
        await repositoryAt(repository.path, gitPath),
        new Set([scratch]),
      );
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
