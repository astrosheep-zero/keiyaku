import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { materializeScratchCandidate } from "../src/git/scratch.js";
import { snapshotId } from "../src/core/facts/types.js";
import { projectSettings } from "../src/settings.js";
import { executeVerification } from "../src/verification/execution.js";
import type { VerificationObservation } from "../src/verification/observation.js";
import { appointedWorktreePath } from "./support/git.js";
import { document, repositoryWithMain } from "./support/library-verbs.js";

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
      const bound = await Keiyaku.with().bind({
        repo: await Repo.at({ path: raw.path }),
        markdown: document(declaration),
        workspace: "worktree",
        gates: ["verified", "reviewed"],
      });
      const source = await appointedWorktreePath(await repositoryAt(raw.path), (await bound.keiyaku.state()).id);
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
      const execution = bound.keiyaku.startDelivery();
      for await (const event of execution.progress) {
        if (event.kind === "verification") observations.push(event.observation);
      }
      const result = await execution.result;

      const attestation = (await bound.keiyaku.state()).attestations.at(-1);
      assert.equal(attestation?.data.verdict, "satisfied", JSON.stringify(result));
      const scratch = observations.find((event) => event.phase === "materialize" && event.cwd)?.cwd;
      assert.ok(scratch);
      assert.notEqual(scratch, source);
      assert.equal(existsSync(scratch), false);
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

test("clean scratch cleanup runs after setup or declaration failure without an appointment", async (t) => {
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
      assert.equal(existsSync(scratch), false);
      assert.equal(execution.cleanup, undefined);
      assert.equal(execution.leak, undefined);
    });
  }
});
