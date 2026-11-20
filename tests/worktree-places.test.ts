import { accepted, present, repositoryWithMain } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import { projectSettings } from "../src/settings.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import { Keis, Repo } from "../src/index.js";
import { repositoryAt } from "../src/git/repository.js";

function contractBody(title: string): string {
  return contractMarkdown(title, {
    Context: "Place worktree.",
    Objective: "Keep Place appointments.",
    Design: "Use the appointed Place path.",
    Region: "```\nsrc/**\n```",
    Criteria: "### Result\nThe appointed Place is reused.\n",
  });
}

test("terminal cleanup releases the Place only after hooks and removal succeed", async () => {
  const repository = repositoryWithMain();
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-place-hook-"));
  const attempts = join(directory, "attempts.log");
  const ready = join(directory, "ready");
  const destroy = {
    name: "destroy",
    argv: [
      process.execPath,
      "-e",
      [
        `const fs = require("node:fs");`,
        `fs.appendFileSync(${JSON.stringify(attempts)}, "attempt\\n");`,
        `if (!fs.existsSync(${JSON.stringify(ready)})) process.exit(9);`,
      ].join(" "),
    ],
    timeoutMs: 5_000,
  };
  mkdirSync(join(repository.path, ".keiyaku"), { recursive: true });
  writeFileSync(
    join(repository.path, ".keiyaku", "settings.json"),
    `${JSON.stringify({ worktree: { create: [], destroy: [destroy] } })}\n`,
  );
  const settings = await projectSettings(repository.path);
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(
    await Keis.of(repo, { settings }).bind({
      terms: contractBody("Release order"),
    }),
  );
  const git = await repositoryAt(repository.path);
  const appointment = await readManagedWorktreeAppointment(git, present(await bound.kei.state()).id);
  assert.ok(appointment.kind === "appointed", 'expected appointment.kind = "appointed"');
  const failed = accepted(await bound.kei.abandon({}));
  assert.ok((failed.issues ?? []).length > 0, JSON.stringify(failed));
  assert.equal(existsSync(appointment.path), true);
  assert.deepEqual(await readManagedWorktreeAppointment(git, present(await bound.kei.state()).id), appointment);
  writeFileSync(ready, "ready\n");
  const released = await Keis.of(repo, { settings }).reconcile({
    contract: present(await bound.kei.state()).id,
    retryHooks: true,
  });
  assert.ok(released.kind === "contract");
  assert.equal((released.issues ?? []).length, 0, JSON.stringify(released));
  assert.equal(existsSync(appointment.path), false);
  assert.deepEqual(await readManagedWorktreeAppointment(git, present(await bound.kei.state()).id), {
    kind: "unappointed",
  });
});
