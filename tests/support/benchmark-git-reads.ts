// Run with: node --import tsx tests/support/benchmark-git-reads.ts
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { withGitDecodeChannel, withGitTargetedReadObservation } from "../../src/git/read-observation.js";
import { GIT_FORMAT_BYTES } from "../../src/git/repository.js";
import { Repo } from "../../src/index.js";
import { scopeForRepo } from "../../src/library/repo.js";

const [, , mode, root, gitPath, countArgument] = process.argv;
if (mode === "measure") {
  const count = Number(countArgument);
  const repository = scopeForRepo(await Repo.at({ path: root!, gitPath: gitPath! }));
  const oids = JSON.parse(readFileSync(join(root!, "objects.json"), "utf8")) as string[];
  writeFileSync(join(root!, "commands"), "");
  writeFileSync(join(root!, "requests"), "");
  const started = performance.now();
  await withGitDecodeChannel(repository, async (channel) => {
    if (count > 0) {
      const objects = await channel.readObjects(oids.slice(0, count));
      assert.equal(objects.size, count);
      for (const object of objects.values()) assert.equal(object.kind, "present");
    } else {
      await withGitTargetedReadObservation(repository, channel, { paths: ["selected/00000"] }, async (epoch) => {
        assert.equal(epoch.snapshot.paths.has("foreign/unrelated/00000"), false);
        const entry = epoch.snapshot.paths.get("selected/00000")!;
        const blobs = await epoch.readBlobs([entry.oid]);
        assert.equal(blobs.get(entry.oid)?.kind, "present");
      });
    }
  });
  const elapsedMs = performance.now() - started;
  const commands = readFileSync(join(root!, "commands"), "utf8").trim().split("\n");
  const requested = readFileSync(join(root!, "requests"), "utf8").trim().split("\n");
  console.log(JSON.stringify({
    scenario: count > 0 ? `${count} immutable objects` : "one selected blob in 110000-path private tree",
    gitProcesses: commands.length,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    readerPeakRssKiB: process.resourceUsage().maxRSS,
    requestedObjects: requested.length,
    ...(count > 0 ? {} : { commands }),
  }));
} else {
  const fixture = mkdtempSync(join(tmpdir(), "keiyaku-finite-read-benchmark-"));
  try {
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const git = (args: string[], input?: string) => execFileSync(realGit, ["-C", fixture, ...args], {
      input, encoding: "utf8", maxBuffer: 128 * 1024 * 1024,
    });
    git(["init", "--quiet", "--initial-branch=main"]);
    git(["config", "gc.auto", "0"]);
    const records: string[] = [];
    for (let index = 0; index < 10000; index += 1) {
      const payload = `${index.toString().padStart(8, "0")}\0${"x".repeat(1014)}\n`;
      records.push(`blob\nmark :${index + 1}\ndata ${Buffer.byteLength(payload)}\n${payload}\n`);
    }
    records.push(`blob\nmark :10001\ndata ${Buffer.byteLength(GIT_FORMAT_BYTES)}\n${GIT_FORMAT_BYTES}\n`);
    records.push("commit refs/heads/keiyaku-state\ncommitter Benchmark <bench@localhost> 1700000000 +0000\ndata 0\n");
    records.push("M 100644 :10001 meta/format.json\n");
    for (let index = 0; index < 10000; index += 1)
      records.push(`M 100644 :${index + 1} selected/${index.toString().padStart(5, "0")}\n`);
    for (let index = 0; index < 100000; index += 1)
      records.push(`M 100644 :1 foreign/unrelated/${index.toString().padStart(5, "0")}\n`);
    records.push("\ndone\n");
    git(["fast-import", "--quiet"], records.join(""));
    const oids = git(["ls-tree", "--format=%(objectname)", "refs/heads/keiyaku-state:selected"]).trim().split("\n");
    writeFileSync(join(fixture, "objects.json"), JSON.stringify(oids));
    const shim = join(fixture, "git-benchmark");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(shim, [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${quote(join(fixture, "commands"))}`,
      'if [ "$1 $2" = "cat-file --batch" ]; then',
      `  tee -a ${quote(join(fixture, "requests"))} | ${quote(realGit)} "$@"`,
      "  exit $?",
      "fi",
      `exec ${quote(realGit)} "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });
    for (const count of [1, 10, 100, 10000, 0]) {
      const result = spawnSync(process.execPath, [
        "--import", "tsx", fileURLToPath(import.meta.url), "measure", fixture, shim, String(count),
      ], { encoding: "utf8", timeout: 120000 });
      if (result.status !== 0) throw new Error(result.stderr || String(result.error));
      process.stdout.write(result.stdout);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
