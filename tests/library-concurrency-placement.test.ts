import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { describe } from "node:test";
import { Keiyaku } from "../src/index.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { privateStatePublicationSeatPath } from "../src/git/private-state-seat.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { reintegrateOperation } from "../src/protocol/reintegrate.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { appointedWorktreePath, cachedRepoAt, cachedRepositoryAt } from "./support/git.js";
import { bind, document, repositoryWithMain } from "./support/library-verbs.js";



function crossProcessAmend(
  input: Readonly<{
    repository: string;
    contractId: string;
    markdown: string;
    source?: unknown;
    waitForRelease?: boolean;
  }>,
) {
  const source = [
    "const { Keiyaku, Repo } = await import(process.env.KEIYAKU_MODULE);",
    "const { repositoryAt } = await import(process.env.KEIYAKU_REPOSITORY_MODULE);",
    "const { privateStatePublicationSeatPath } = await import(process.env.KEIYAKU_SEAT_MODULE);",
    "const { tryAcquireSqliteTransactionLock } = await import(process.env.KEIYAKU_LOCK_MODULE);",
    "const { amendOperation } = await import(process.env.KEIYAKU_AMEND_MODULE);",
    "const { withGitDecodeChannel } = await import(process.env.KEIYAKU_CHANNEL_MODULE);",
    "const { applyAmendDocument } = await import(process.env.KEIYAKU_BODY_AMEND_MODULE);",
    "const { decodeContractDocument } = await import(process.env.KEIYAKU_BODY_DECODE_MODULE);",
    "const { contractTerms, documentDerivation } = await import(process.env.KEIYAKU_INPUT_MODULE);",
    "const capability = { ...(await repositoryAt(process.env.KEIYAKU_REPOSITORY)), onPrivateStateSeatContention: () => process.stdout.write('contended\\n') };",
    "const probe = await tryAcquireSqliteTransactionLock({ path: privateStatePublicationSeatPath(capability), mode: 'immediate' });",
    "if (probe !== null) { probe.close(); throw new Error('shared seat was not held'); }",
    "const contractId = process.env.KEIYAKU_CONTRACT;",
    "const sourceTerms = process.env.KEIYAKU_SOURCE === undefined ? undefined : JSON.parse(process.env.KEIYAKU_SOURCE);",
    "const intent = sourceTerms === undefined ? undefined : (() => {",
    "  const amended = applyAmendDocument(process.env.KEIYAKU_MARKDOWN, decodeContractDocument(sourceTerms.document.bytes));",
    "  const document = decodeContractDocument(amended.document);",
    "  const terms = contractTerms(document, sourceTerms.gates, sourceTerms.after);",
    "  return { source: sourceTerms, deriveAmendment: () => ({ terms, verification: documentDerivation(document, terms.gates, contractId).verification }) };",
    "})();",
    "process.stdout.write(`ready${intent === undefined ? '' : `:${intent.source.document.key}`}\\n`);",
    "if (process.env.KEIYAKU_WAIT_FOR_RELEASE === '1') await new Promise((resolve) => process.stdin.once('data', resolve));",
    "try {",
    "  if (intent === undefined) {",
    "    const contract = await Keiyaku.with().select({ repo: await Repo.at({ path: process.env.KEIYAKU_REPOSITORY }), id: contractId });",
    "    await contract.amend({ markdown: process.env.KEIYAKU_MARKDOWN });",
    "    process.stdout.write('accepted\\n');",
    "  } else {",
    "    const outcome = await withGitDecodeChannel(capability, (channel) => amendOperation({ scope: capability, channel, contractId, ...intent }));",
    "    process.stdout.write(outcome.kind === 'accepted' ? 'accepted\\n' : `failed:${outcome.kind === 'refused' ? outcome.refusal.kind : outcome.reason.kind}\\n`);",
    "  }",
    "} catch (error) { process.stdout.write(`failed:${error.reason?.kind ?? error.refusal?.kind ?? error.name}\\n`); }",
  ].join("\n");
  const child = spawn(
    process.execPath,
    [...(import.meta.url.endsWith(".js") ? [] : ["--import", import.meta.resolve("tsx")]), "--input-type=module", "-e", source],
    {
      env: {
        ...process.env,
        KEIYAKU_MODULE: new URL("../src/index.js", import.meta.url).href,
        KEIYAKU_REPOSITORY_MODULE: new URL("../src/git/repository.js", import.meta.url).href,
        KEIYAKU_SEAT_MODULE: new URL("../src/git/private-state-seat.js", import.meta.url).href,
        KEIYAKU_LOCK_MODULE: new URL("../src/coordination/sqlite-transaction-lock.js", import.meta.url).href,
        KEIYAKU_AMEND_MODULE: new URL("../src/protocol/amend.js", import.meta.url).href,
        KEIYAKU_CHANNEL_MODULE: new URL("../src/git/read-observation.js", import.meta.url).href,
        KEIYAKU_BODY_AMEND_MODULE: new URL("../src/body/amend.js", import.meta.url).href,
        KEIYAKU_BODY_DECODE_MODULE: new URL("../src/body/decode.js", import.meta.url).href,
        KEIYAKU_INPUT_MODULE: new URL("../src/library/input.js", import.meta.url).href,
        KEIYAKU_REPOSITORY: input.repository,
        KEIYAKU_CONTRACT: input.contractId,
        KEIYAKU_MARKDOWN: input.markdown,
        KEIYAKU_WAIT_FOR_RELEASE: input.waitForRelease === true ? "1" : "0",
        ...(input.source === undefined ? {} : { KEIYAKU_SOURCE: JSON.stringify(input.source) }),
      },
      stdio: [input.waitForRelease === true ? "pipe" : "ignore", "pipe", "pipe"],
    },
  );
  if (child.stdout === null || child.stderr === null) throw new Error("cross-process amend is missing output streams");
  const stdout = child.stdout;
  const stderr = child.stderr;
  const { promise: ready, resolve: resolveReady, reject: rejectReady } = promiseBarrier<string>();
  const { promise: contended, resolve: resolveContended } = promiseBarrier<void>();
  const { promise: completed, resolve: resolveCompleted, reject: rejectCompleted } = promiseBarrier<string>();
  let diagnostic = "";
  let output = "";
  let lines = "";
  let becameReady = false;
  let becameContended = false;
  stdout.on("data", (bytes) => {
    const text = bytes.toString("utf8");
    output += text;
    lines += text;
    for (;;) {
      const newline = lines.indexOf("\n");
      if (newline < 0) break;
      const line = lines.slice(0, newline);
      lines = lines.slice(newline + 1);
      const match = /^ready(?::(.+))?$/.exec(line);
      if (match !== null && !becameReady) {
        becameReady = true;
        resolveReady(match[1] ?? "");
      }
      if (line === "contended" && !becameContended) {
        becameContended = true;
        resolveContended();
      }
    }
  });
  stderr.on("data", (bytes) => {
    diagnostic += bytes.toString("utf8");
  });
  child.once("error", (error) => {
    rejectReady(error);
    rejectCompleted(error);
  });
  child.once("exit", (code) => {
    if (!becameReady) rejectReady(new Error("child did not become ready"));
    code === 0
      ? resolveCompleted(output)
      : rejectCompleted(new Error(`cross-process amend exited ${code}: ${diagnostic}`));
  });
  let released = false;
  return {
    ready,
    contended,
    completed,
    release: () => {
      if (released) return;
      released = true;
      if (child.stdin === null) throw new Error("child does not have a release barrier");
      child.stdin.end("release\n");
    },
  };
}

// Each case owns a separate repository and scoped fault injection, never a process-wide mock.
describe("library-concurrency-placement isolated repositories", { concurrency: 4 }, () => {

  test("same-Contract cross-process amends decide from the queued fresh state", async () => {
    const repository = repositoryWithMain();
    const contract = await bind(repository);
    const source = (await contract.state()).terms;
    const capability = await cachedRepositoryAt(repository.path);
    const held = await acquireSqliteTransactionLock({ path: privateStatePublicationSeatPath(capability), mode: "immediate" });
    const workers = [
      crossProcessAmend({
        repository: repository.path,
        contractId: (await contract.state()).id,
        markdown: "## Replace: Context\nfirst source terms\n",
        source,
      }),
      crossProcessAmend({
        repository: repository.path,
        contractId: (await contract.state()).id,
        markdown: "## Replace: Objective\nsecond source terms\n",
        source,
      }),
    ];
    try {
      assert.deepEqual(await Promise.all(workers.map(({ ready }) => ready)), [source.document.key, source.document.key]);
      await Promise.race([
        Promise.any(workers.map(({ contended }) => contended)),
        Promise.all(workers.map(({ completed }) => completed)).then(() => {
          throw new Error("cross-process amends completed without private-state seat contention");
        }),
      ]);
    } finally {
      held.close();
    }
    const outcomes = await Promise.all(workers.map(({ completed }) => completed));
    assert.equal(outcomes.filter((outcome) => outcome.includes("accepted")).length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.includes("failed:terms-moved")).length, 1);
    const body = decodeContractDocument((await contract.state()).terms.document.bytes);
    assert.ok(body.context.trim() === "first source terms" || body.objective.trim() === "second source terms");


  });

  test("reintegration observes and publishes only after the shared private-state seat", async () => {
    const repository = repositoryWithMain();
    repository.run(["branch", "release"]);
    const bound = await Keiyaku.with().bind({
      repo: await cachedRepoAt(repository.path),
      markdown: document(),
      target: "refs/heads/release",
      workspace: "worktree",
      gates: ["reviewed"],
    });
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), (await bound.keiyaku.state()).id);
    writeFileSync(resolve(worktree, "candidate.txt"), "captured\n");
    repository.run(["-C", worktree, "add", "candidate.txt"]);
    repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
    await bound.keiyaku.deliver();
    writeFileSync(resolve(repository.path, "target.txt"), "moved\n");
    repository.run(["add", "target.txt"]);
    repository.run(["commit", "--quiet", "-m", "move target"]);
    repository.run(["update-ref", "refs/heads/release", repository.run(["rev-parse", "HEAD"]).trim()]);
    const writers = [];
    for (let index = 0; index < 3; index += 1) writers.push(await bind(repository));
    const before = repository.run(["rev-parse", "refs/heads/keiyaku-state"]).trim();
    const capability = await cachedRepositoryAt(repository.path);
    const held = await acquireSqliteTransactionLock({
      path: privateStatePublicationSeatPath(capability),
      mode: "immediate",
    });
    const writerIds = await Promise.all(writers.map(async (contract) => (await contract.state()).id));
    const racingWriters = writers.map((_, index) =>
      crossProcessAmend({
        repository: repository.path,
        contractId: writerIds[index]!,
        markdown: `## Replace: Context\nracing writer ${index}\n`,
      }),
    );
    const reintegration = withGitDecodeChannel(capability, async (channel) =>
      reintegrateOperation({
        channel,
        repository: capability,
        contractId: (await bound.keiyaku.state()).id,
        target: "refs/heads/release",
      }),
    );
    try {
      await Promise.all(racingWriters.map(({ ready }) => ready));
      assert.equal(repository.run(["rev-parse", "refs/heads/keiyaku-state"]).trim(), before);
    } finally {
      held.close();
    }
    assert.equal((await reintegration).kind, "accepted");
    const outcomes = await Promise.all(racingWriters.map(({ completed }) => completed));
    assert.ok(outcomes.every((outcome) => outcome.includes("accepted")));
  });
});
