import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Keiyaku, KeiyakuRetry, Repo, type Keiyaku as KeiyakuHandle } from "../src/index.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { encodeEntry } from "../src/core/facts/codec.js";
import { entryUlid, type JournalEntry } from "../src/core/facts/types.js";
import { contractJournalPath } from "../src/git/identity.js";
import { privateStatePublicationSeatPath } from "../src/git/private-state-seat.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { reintegrateOperation } from "../src/protocol/reintegrate.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { appointedWorktreePath, cachedRepoAt, cachedRepositoryAt, withGitShim } from "./support/git.js";
import { bind, commitCandidate, document, repositoryWithMain } from "./support/library-verbs.js";

type AcceptedDelivery = Exclude<Awaited<ReturnType<KeiyakuHandle["deliver"]>>, { kind: "integration-conflict-materialized" }>;

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
  const child = spawn(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", source],
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
  let resolveReady: (key: string) => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveContended: () => void;
  const contended = new Promise<void>((resolve) => {
    resolveContended = resolve;
  });
  let resolveCompleted: (output: string) => void;
  let rejectCompleted: (error: Error) => void;
  const completed = new Promise<string>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
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
  const held = await acquireSqliteTransactionLock({ path: privateStatePublicationSeatPath(capability), mode: "immediate" });
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
    assert.equal(decodeContractDocument((await contract.state()).terms.document.bytes).context.trim(), `writer ${index}`);
  }
});

test("public amend returns the recovered journal head after unknown recovery", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const prior = await contract.state();
  const replacement = "## Replace: Context\nRecovered replacement.\n\n";
  const concurrent: JournalEntry = {
    v: 1,
    kind: "arc",
    contract: prior.id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB1"),
    at: "2026-08-06T00:00:02Z",
    data: { seq: 1, title: "Recovered race", objective: "Race", brief: "Append before recovery observes." },
  };
  const marker = `${repository.path}/unknown-recovery.marker`;

  const amended = await withGitShim(
    [
      'if [ "$1" = "update-ref" ] && [ ! -e "$KEIYAKU_MARKER" ]; then',
      '  "$KEIYAKU_REAL_GIT" "$@" || exit $?',
      '  current=$("$KEIYAKU_REAL_GIT" rev-parse refs/heads/keiyaku-state)',
      '  tree=$("$KEIYAKU_REAL_GIT" rev-parse "$current^{tree}")',
      '  line=$("$KEIYAKU_REAL_GIT" ls-tree "$tree" -- "$KEIYAKU_CONTRACT_PATH")',
      "  oid=$(printf '%s\\n' \"$line\" | awk '{print $3}')",
      "  journal=$(mktemp)",
      '  "$KEIYAKU_REAL_GIT" cat-file blob "$oid" > "$journal"',
      '  printf \'%s\' "$KEIYAKU_EXTRA_ENTRY" >> "$journal"',
      '  next=$("$KEIYAKU_REAL_GIT" hash-object -w --stdin < "$journal")',
      "  index=$(mktemp)",
      '  rm -f "$index"',
      '  GIT_INDEX_FILE="$index" "$KEIYAKU_REAL_GIT" read-tree "$tree"',
      '  printf \'100644 blob %s\\t%s\\n\' "$next" "$KEIYAKU_CONTRACT_PATH" | GIT_INDEX_FILE="$index" "$KEIYAKU_REAL_GIT" update-index --index-info',
      '  next_tree=$(GIT_INDEX_FILE="$index" "$KEIYAKU_REAL_GIT" write-tree)',
      '  next_commit=$("$KEIYAKU_REAL_GIT" commit-tree "$next_tree" -p "$current" < /dev/null)',
      '  "$KEIYAKU_REAL_GIT" update-ref refs/heads/keiyaku-state "$next_commit" "$current"',
      '  rm -f "$journal" "$index"',
      '  touch "$KEIYAKU_MARKER"',
      "  kill -TERM $$",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {
      KEIYAKU_MARKER: marker,
      KEIYAKU_CONTRACT_PATH: contractJournalPath(prior.id),
      KEIYAKU_EXTRA_ENTRY: encodeEntry(concurrent),
    },
    async (gitPath) =>
      (
        await Keiyaku.of({
          repo: await Repo.at({ path: repository.path, gitPath }),
          id: (await contract.state()).id,
        })
      ).amend({ markdown: replacement }),
  );
  assert.deepEqual(
    amended.facts.map((fact) => fact.kind),
    ["amend"],
  );
  const live = await contract.state();
  assert.equal(live.currentArc?.data.title, "Recovered race");
  assert.equal(amended.head, live.head);
});

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

  const delayed = await bind(repository);
  const delayedSource = (await delayed.state()).terms;
  const delayedHeld = await acquireSqliteTransactionLock({ path: privateStatePublicationSeatPath(capability), mode: "immediate" });
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
      assert.deepEqual(
        await Promise.all(delayedWorkers.map(({ ready }) => ready)),
        [delayedSource.document.key, delayedSource.document.key],
      );
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

test("accepted head excludes an append made after admission", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const prior = await contract.state();
  const replacement = "## Replace: Context\nAccepted replacement.\n\n";
  const concurrent: JournalEntry = {
    v: 1,
    kind: "arc",
    contract: prior.id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB0"),
    at: "2026-08-06T00:00:01Z",
    data: { seq: 1, title: "Concurrent", objective: "Race", brief: "Append after admission." },
  };
  const marker = `${repository.path}/post-admission.marker`;
  const amended = await withGitShim(
    [
      'if [ "$1" = "update-ref" ] && [ ! -e "$KEIYAKU_MARKER" ]; then',
      '  "$KEIYAKU_REAL_GIT" "$@" || exit $?',
      '  current=$("$KEIYAKU_REAL_GIT" rev-parse refs/heads/keiyaku-state)',
      '  tree=$("$KEIYAKU_REAL_GIT" rev-parse "$current^{tree}")',
      '  line=$("$KEIYAKU_REAL_GIT" ls-tree "$tree" -- "$KEIYAKU_CONTRACT_PATH")',
      "  oid=$(printf '%s\\n' \"$line\" | awk '{print $3}')",
      "  journal=$(mktemp)",
      '  "$KEIYAKU_REAL_GIT" cat-file blob "$oid" > "$journal"',
      '  printf \'%s\' "$KEIYAKU_EXTRA_ENTRY" >> "$journal"',
      '  next=$("$KEIYAKU_REAL_GIT" hash-object -w --stdin < "$journal")',
      "  index=$(mktemp)",
      '  rm -f "$index"',
      '  GIT_INDEX_FILE="$index" "$KEIYAKU_REAL_GIT" read-tree "$tree"',
      '  printf \'100644 blob %s\\t%s\\n\' "$next" "$KEIYAKU_CONTRACT_PATH" | GIT_INDEX_FILE="$index" "$KEIYAKU_REAL_GIT" update-index --index-info',
      '  next_tree=$(GIT_INDEX_FILE="$index" "$KEIYAKU_REAL_GIT" write-tree)',
      '  next_commit=$("$KEIYAKU_REAL_GIT" commit-tree "$next_tree" -p "$current" < /dev/null)',
      '  "$KEIYAKU_REAL_GIT" update-ref refs/heads/keiyaku-state "$next_commit" "$current"',
      '  rm -f "$journal" "$index"',
      '  touch "$KEIYAKU_MARKER"',
      "  exit 0",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {
      KEIYAKU_MARKER: marker,
      KEIYAKU_CONTRACT_PATH: contractJournalPath(prior.id),
      KEIYAKU_EXTRA_ENTRY: encodeEntry(concurrent),
    },
    async (gitPath) =>
      (
        await Keiyaku.of({
          repo: await Repo.at({ path: repository.path, gitPath }),
          id: (await contract.state()).id,
        })
      ).amend({ markdown: replacement }),
  );
  assert.deepEqual(
    amended.facts.map((fact) => fact.kind),
    ["amend"],
  );
  assert.equal((await contract.state()).currentArc?.data.title, "Concurrent");
});

test("claim does not mutate eligible dependents", async () => {
  const repository = repositoryWithMain();
  const sourceResult = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document(),
    workspace: "worktree",
    gates: ["reviewed"],
  });
  const source = sourceResult.keiyaku;
  commitCandidate(repository);
  await source.deliver();

  const dependents: Keiyaku[] = [];
  for (let index = 0; index < 4; index += 1) {
    const bound = await Keiyaku.bind({
      repo: await cachedRepoAt(repository.path),
      markdown: document(),
      workspace: "worktree",
      after: [(await source.state()).id],
    });
    dependents.push(bound.keiyaku);
  }

  await source.review({ verdict: "satisfied" });
  assert.equal((await source.state()).terminal?.kind, "claimed");
  for (const dependent of dependents) {
    const state = await dependent.state();
    assert.equal(state.bound, null);
    assert.equal(state.terminal, null);
  }
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
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), (await result.keiyaku.state()).id);
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
  assert.deepEqual(delivered.value.completion, { integration: reintegrated.data.snapshot });
  const current = await result.keiyaku.delivery();
  assert.equal(current?.tenderSnapshot, delivered.value.tenderSnapshot);
  assert.equal(current?.integration.predecessor, reintegrated.data.predecessor);
  assert.equal(current?.integration.snapshot, reintegrated.data.snapshot);
  assert.equal(current?.integration.changeId, delivered.value.integration.changeId);
  assert.match((await current?.diff()) ?? "", /candidate\.txt/u);
});

test("reintegration observes and publishes only after the shared private-state seat", async () => {
  const repository = repositoryWithMain();
  repository.run(["branch", "release"]);
  const bound = await Keiyaku.bind({
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
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), (await result.keiyaku.state()).id);
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

test("reintegrated delivery does not aggregate Verification from the superseded integration", async () => {
  const repository = repositoryWithMain();
  repository.run(["branch", "release"]);
  const marker = `${repository.path}/first-verification.marker`;
  const result = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document(
      [
        `if [ -f ${JSON.stringify(marker)} ]; then`,
        "  kill -TERM $$",
        "fi",
        `touch ${JSON.stringify(marker)}`,
        'printf "first verification" >&2',
        "exit 1",
      ].join("\n"),
    ),
    target: "refs/heads/release",
    workspace: "worktree",
    gates: [],
  });
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), (await result.keiyaku.state()).id);
  writeFileSync(resolve(worktree, "candidate.txt"), "candidate\n");
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
      KEIYAKU_TARGET_HEAD: repository.run(["rev-parse", "HEAD"]).trim(),
      KEIYAKU_TARGET_RACED: raced,
    },
    async (gitPath) =>
      acceptedDelivery(
        await Keiyaku.of({
          repo: await Repo.at({ path: repository.path, gitPath }),
          id: (await result.keiyaku.state()).id,
        }).deliver(),
      ),
  );

  const reintegrated = delivered.facts.find((fact) => fact.kind === "reintegrated");
  assert.ok(reintegrated);
  assert.equal(delivered.value.completion, undefined);
  assert.equal((await result.keiyaku.state()).currentIntegration?.snapshot, reintegrated.data.snapshot);
  assert.equal((await result.keiyaku.state()).terminal, null);
  assert.deepEqual(delivered.value.verification, { failure: "unknown-exit" });
  assert.equal(delivered.value.verificationSummary, undefined);
});

test("review re-integrates its accepted delivery when the target premise moves", async () => {
  const repository = repositoryWithMain();
  repository.run(["branch", "release"]);
  const result = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document(),
    target: "refs/heads/release",
    workspace: "worktree",
    gates: ["reviewed"],
  });
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), (await result.keiyaku.state()).id);
  writeFileSync(resolve(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  const delivered = acceptedDelivery(await result.keiyaku.deliver());
  writeFileSync(resolve(repository.path, "different-target.txt"), "different target\n");
  repository.run(["add", "different-target.txt"]);
  repository.run(["commit", "--quiet", "-m", "move target differently"]);

  const failed = `${repository.path}/publication-failed.marker`;
  const shim = [
    'if [ "$1" = "update-ref" ]; then',
    "  input_file=$(mktemp)",
    '  cat >"$input_file"',
    '  if grep -q "update refs/heads/release" "$input_file" && [ ! -e "$KEIYAKU_PUBLICATION_FAILED" ]; then',
    '    candidate=$("$KEIYAKU_REAL_GIT" rev-parse HEAD)',
    '    "$KEIYAKU_REAL_GIT" update-ref refs/heads/release "$candidate"',
    '    touch "$KEIYAKU_PUBLICATION_FAILED"',
    "  fi",
    '  "$KEIYAKU_REAL_GIT" "$@" <"$input_file"',
    "  status=$?",
    '  rm -f "$input_file"',
    '  exit "$status"',
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n");
  const reviewed = await withGitShim(
    shim,
    {
      KEIYAKU_PUBLICATION_FAILED: failed,
    },
    async (gitPath) =>
      (
        await Keiyaku.of({
          repo: await Repo.at({ path: repository.path, gitPath }),
          id: (await result.keiyaku.state()).id,
        })
      ).review({ verdict: "satisfied" }),
  );
  assert.equal(reviewed.value.placement, undefined);
  assert.deepEqual(
    reviewed.facts.map((fact) => fact.kind),
    ["attestation", "reintegrated", "claimed"],
  );
  const reintegrated = reviewed.facts.find((fact) => fact.kind === "reintegrated");
  assert.ok(reintegrated);
  assert.deepEqual(reviewed.value.completion, { integration: reintegrated.data.snapshot });
  assert.equal(reintegrated?.data.predecessor, repository.run(["rev-parse", "HEAD"]).trim());
  const state = await result.keiyaku.state();
  assert.equal(state.attestations.at(-1)?.data.verdict, "satisfied");
  assert.equal(state.terminal?.kind, "claimed");
  assert.deepEqual(state.delivery?.data.integration, delivered.value.integration);
  assert.equal(state.currentIntegration?.snapshot, reintegrated?.data.snapshot);
  assert.equal(repository.run(["rev-parse", "refs/heads/release"]).trim(), state.currentIntegration?.snapshot);
});
