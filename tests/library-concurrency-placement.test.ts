import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { decodeContractDocument } from "../src/body/decode.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { privateStatePublicationSeatPath } from "../src/git/private-state-seat.js";
import { Keiyaku, KeiyakuRetry, Repo, type Keiyaku as KeiyakuHandle } from "../src/index.js";
import { appointedWorktreePath, cachedRepoAt, cachedRepositoryAt, withGitShim } from "./support/git.js";
import { bind, document, repositoryWithMain } from "./support/library-verbs.js";
import { fixtureNodeOptions, deferred as promiseBarrier } from "./support/process.js";

type AcceptedDelivery = Exclude<
  Awaited<ReturnType<KeiyakuHandle["deliver"]>>,
  { kind: "integration-conflict-materialized" }
>;

function acceptedDelivery(result: Awaited<ReturnType<KeiyakuHandle["deliver"]>>): AcceptedDelivery {
  if (result.kind === "integration-conflict-materialized") {
    throw new Error(`unexpected integration conflict: ${result.conflictPaths.join(",")}`);
  }
  return result;
}

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
    "    const contract = await Keiyaku.of({ repo: await Repo.at({ path: process.env.KEIYAKU_REPOSITORY }), id: contractId });",
    "    await contract.amend({ markdown: process.env.KEIYAKU_MARKDOWN });",
    "    process.stdout.write('accepted\\n');",
    "  } else {",
    "    const outcome = await withGitDecodeChannel(capability, (channel) => amendOperation({ scope: capability, channel, contractId, ...intent }));",
    "    process.stdout.write(outcome.kind === 'accepted' ? 'accepted\\n' : `failed:${outcome.kind === 'refused' ? outcome.refusal.kind : outcome.reason.kind}\\n`);",
    "  }",
    "} catch (error) { process.stdout.write(`failed:${error.reason?.kind ?? error.refusal?.kind ?? error.name}\\n`); }",
  ].join("\n");
  const child = spawn(process.execPath, [...fixtureNodeOptions, "--input-type=module", "-e", source], {
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
  });
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

test("more independent cross-process mutations than the attempt bound serialize at the private root", async () => {
  const repository = repositoryWithMain();
  const contracts = [];
  for (let index = 0; index < 4; index += 1) contracts.push(await bind(repository));
  const capability = await cachedRepositoryAt(repository.path);
  const held = await acquireSqliteTransactionLock({
    path: privateStatePublicationSeatPath(capability),
    mode: "immediate",
  });
  const contractIds = await Promise.all(contracts.map(async (contract) => (await contract.state()).id));
  const workers = contracts.map((_, index) =>
    crossProcessAmend({
      repository: repository.path,
      contractId: contractIds[index]!,
      markdown: `## Replace: Context\nwriter ${index}\n`,
    }),
  );
  try {
    await Promise.all(workers.map(({ ready }) => ready));
  } finally {
    held.close();
  }
  const outcomes = await Promise.all(workers.map(({ completed }) => completed));
  assert.ok(outcomes.every((outcome) => outcome.includes("accepted")));
  for (const [index, contract] of contracts.entries()) {
    assert.equal(
      decodeContractDocument((await contract.state()).terms.document.bytes).context.trim(),
      `writer ${index}`,
    );
  }
});

test("same-Contract cross-process amends decide from the queued fresh state", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const source = (await contract.state()).terms;
  const capability = await cachedRepositoryAt(repository.path);
  const held = await acquireSqliteTransactionLock({
    path: privateStatePublicationSeatPath(capability),
    mode: "immediate",
  });
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

  const delayed = await bind(repository);
  const delayedSource = (await delayed.state()).terms;
  const delayedHeld = await acquireSqliteTransactionLock({
    path: privateStatePublicationSeatPath(capability),
    mode: "immediate",
  });
  const delayedWorkers = [
    crossProcessAmend({
      repository: repository.path,
      contractId: (await delayed.state()).id,
      markdown: "## Replace: Context\nfirst delayed source terms\n",
      source: delayedSource,
      waitForRelease: true,
    }),
    crossProcessAmend({
      repository: repository.path,
      contractId: (await delayed.state()).id,
      markdown: "## Replace: Objective\nsecond delayed source terms\n",
      source: delayedSource,
      waitForRelease: true,
    }),
  ];
  try {
    try {
      assert.deepEqual(await Promise.all(delayedWorkers.map(({ ready }) => ready)), [
        delayedSource.document.key,
        delayedSource.document.key,
      ]);
    } finally {
      delayedHeld.close();
    }
    delayedWorkers[0]!.release();
    assert.match(await delayedWorkers[0]!.completed, /accepted/);
    delayedWorkers[1]!.release();
    assert.match(await delayedWorkers[1]!.completed, /failed:terms-moved/);
  } finally {
    for (const worker of delayedWorkers) worker.release();
    await Promise.allSettled(delayedWorkers.map(({ completed }) => completed));
  }
  const delayedBody = decodeContractDocument((await delayed.state()).terms.document.bytes);
  assert.equal(delayedBody.context.trim(), "first delayed source terms");
  assert.notEqual(delayedBody.objective.trim(), "second delayed source terms");
});

test("a hard publication failure is returned without replaying the operation", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const attempts = `${repository.path}/publication-attempts`;

  let retry: KeiyakuRetry | undefined;
  await assert.rejects(
    withGitShim(
      [
        'if [ "$1" = "update-ref" ]; then',
        "  cat >/dev/null",
        '  printf "attempt\\n" >> "$KEIYAKU_ATTEMPTS"',
        '  printf "forced hard publication failure\\n" >&2',
        "  exit 42",
        "fi",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      { KEIYAKU_ATTEMPTS: attempts },
      async (gitPath) =>
        (
          await Keiyaku.of({
            repo: await Repo.at({ path: repository.path, gitPath }),
            id: (await contract.state()).id,
          })
        ).amend({ markdown: "## Replace: Context\nNo coordinate moved.\n" }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof KeiyakuRetry);
      retry = error;
      return true;
    },
  );
  assert.equal(retry?.code, "publication-failed");
  if (retry?.reason.kind === "publication-failed")
    assert.match(retry.reason.diagnostic, /forced hard publication failure/);
  assert.deepEqual(readFileSync(attempts, "utf8").trim().split("\n"), ["attempt"]);
});

test("delivery re-integrates its persisted tender when the target premise moves", async () => {
  const repository = repositoryWithMain();
  repository.run(["branch", "release"]);
  const result = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document(),
    target: "refs/heads/release",
    workspace: "worktree",
    gates: [],
  });
  const worktree = await appointedWorktreePath(
    await cachedRepositoryAt(repository.path),
    (await result.keiyaku.state()).id,
  );
  writeFileSync(resolve(worktree, "candidate.txt"), "captured\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  writeFileSync(resolve(repository.path, "target.txt"), "moved\n");
  repository.run(["add", "target.txt"]);
  repository.run(["commit", "--quiet", "-m", "move target"]);

  const raced = `${repository.path}/target-raced.marker`;
  const delivered = await withGitShim(
    [
      'if [ "$1" = "update-ref" ]; then',
      "  input_file=$(mktemp)",
      '  cat >"$input_file"',
      '  if grep -q "update refs/heads/release" "$input_file" && [ ! -e "$KEIYAKU_TARGET_RACED" ]; then',
      '    "$KEIYAKU_REAL_GIT" update-ref refs/heads/release "$KEIYAKU_TARGET_HEAD"',
      '    printf "changed after capture\\n" > "$KEIYAKU_CANDIDATE_PATH"',
      '    touch "$KEIYAKU_TARGET_RACED"',
      "  fi",
      '  "$KEIYAKU_REAL_GIT" "$@" <"$input_file"',
      "  status=$?",
      '  rm -f "$input_file"',
      '  exit "$status"',
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {
      KEIYAKU_CANDIDATE_PATH: resolve(worktree, "candidate.txt"),
      KEIYAKU_TARGET_HEAD: repository.run(["rev-parse", "HEAD"]).trim(),
      KEIYAKU_TARGET_RACED: raced,
    },
    async (gitPath) =>
      acceptedDelivery(
        await Keiyaku.of({
          repo: await Repo.at({ path: repository.path, gitPath }),
          id: (await result.keiyaku.state()).id,
        }).deliver({ message: "preserve this subject" }),
      ),
  );

  assert.deepEqual(
    delivered.facts.map((fact) => fact.kind),
    ["bound", "deliver", "reintegrated", "claimed"],
  );
  const reintegrated = delivered.facts.find((fact) => fact.kind === "reintegrated");
  assert.ok(reintegrated);
  assert.equal(repository.run(["show", "refs/heads/release:candidate.txt"]), "captured\n");
  assert.equal(readFileSync(resolve(worktree, "candidate.txt"), "utf8"), "changed after capture\n");
  const metadata = ["show", "-s", "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B"] as const;
  assert.equal(
    repository.run([...metadata, reintegrated.data.snapshot]),
    repository.run([...metadata, delivered.value.integration.snapshot]),
  );
  assert.equal(
    repository.run(["show", "-s", "--format=%s", delivered.value.integration.snapshot]).trim(),
    "preserve this subject",
  );
  assert.equal(repository.run(["rev-parse", "refs/heads/release"]).trim(), reintegrated.data.snapshot);
  assert.deepEqual(delivered.value.completion, {
    integration: reintegrated.data.snapshot,
    predecessor: reintegrated.data.predecessor,
    target: "refs/heads/release",
  });
  const current = await result.keiyaku.delivery();
  assert.equal(current?.tenderSnapshot, delivered.value.tenderSnapshot);
  assert.equal(current?.integration.predecessor, reintegrated.data.predecessor);
  assert.equal(current?.integration.snapshot, reintegrated.data.snapshot);
  assert.equal(current?.integration.changeId, delivered.value.integration.changeId);
  assert.match((await current?.diff()) ?? "", /candidate\.txt/u);
});

test("equivalent external target movement stops without reintegration or claim", async () => {
  const repository = repositoryWithMain();
  repository.run(["branch", "release"]);
  const result = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document(),
    target: "refs/heads/release",
    workspace: "worktree",
    gates: [],
  });
  const worktree = await appointedWorktreePath(
    await cachedRepositoryAt(repository.path),
    (await result.keiyaku.state()).id,
  );
  writeFileSync(resolve(worktree, "candidate.txt"), "captured\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  const raced = `${repository.path}/equivalent-target-raced.marker`;
  const delivered = await withGitShim(
    [
      'if [ "$1" = "update-ref" ]; then',
      "  input_file=$(mktemp)",
      '  cat >"$input_file"',
      '  if grep -q "update refs/heads/release" "$input_file" && [ ! -e "$KEIYAKU_TARGET_RACED" ]; then',
      '    expected=$(awk \'$1 == "update" && $2 == "refs/heads/release" { print $4 }\' "$input_file")',
      '    candidate=$(awk \'$1 == "update" && $2 == "refs/heads/release" { print $3 }\' "$input_file")',
      '    tree=$("$KEIYAKU_REAL_GIT" rev-parse "$candidate^{tree}")',
      '    external=$("$KEIYAKU_REAL_GIT" commit-tree "$tree" -p "$expected" -m "external equivalent")',
      '    "$KEIYAKU_REAL_GIT" update-ref refs/heads/release "$external" "$expected"',
      '    touch "$KEIYAKU_TARGET_RACED"',
      "  fi",
      '  "$KEIYAKU_REAL_GIT" "$@" <"$input_file"',
      "  status=$?",
      '  rm -f "$input_file"',
      '  exit "$status"',
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_TARGET_RACED: raced },
    async (gitPath) =>
      acceptedDelivery(
        await Keiyaku.of({
          repo: await Repo.at({ path: repository.path, gitPath }),
          id: (await result.keiyaku.state()).id,
        }).deliver(),
      ),
  );

  assert.deepEqual(
    delivered.facts.map((fact) => fact.kind),
    ["bound", "deliver"],
  );
  assert.equal(delivered.value.completion, undefined);
  const placement = delivered.value.placement;
  assert.ok(placement);
  if (!("failure" in placement) || placement.failure !== "target-moved")
    assert.fail("expected target-moved placement failure");
  assert.equal(placement.observedTreeEqualsCandidate, true);
  assert.notEqual(placement.observed, null);
  assert.equal(repository.run(["rev-parse", "refs/heads/release"]).trim(), placement.observed);
  assert.equal((await result.keiyaku.state()).terminal, null);
});
