import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { makeGitRepository } from "./support/git.js";
import {
  cleanupSpawnCapableFixture,
  removeTempDirectory,
  retainedFixtureRoots,
  temporaryDirectory,
} from "./support/process.js";

/**
 * This file is both the outer observation fixture and its own bounded child
 * runner. The child runs the real support helpers, records the retained roots
 * and their bytes externally, and exits naturally; the outer fixture then proves
 * the evidence outlived the child's owning teardown and that retention without a
 * declared expectation was a named nonzero failure, not a silently passing one.
 */
const CHILD_MODE_ENV = "KEIYAKU_FIXTURE_RETENTION_CHILD";
const CHILD_OBSERVATION_ENV = "KEIYAKU_FIXTURE_RETENTION_OBSERVATION";
const CHILD_TIMEOUT_MS = 60_000;
const MARKER_BYTES = Buffer.from("retained fixture evidence\n", "utf8");
const NESTED_MARKER_BYTES = Buffer.from("nested fixture evidence\n", "utf8");
const DIAGNOSTIC_PREFIX = "[fixture-retention] retained ";

const CHILD_MODES = [
  "retain-nested-git",
  "retain-returned-temporary-directory",
  "retain-unproven-temporary-directory",
  "retain-declared-and-undeclared-temporary-directories",
  "remove-unretained",
] as const;

type ChildMode = (typeof CHILD_MODES)[number];

type RetainedObservation = Readonly<{
  root: string;
  reason: string;
  expected: boolean;
  marker: string;
  markerBase64: string;
  nested: string;
  nestedBase64: string;
}>;

type ControlObservation = Readonly<{ root: string; marker: string; markerBase64: string }>;

type Observation = Readonly<{
  mode: string;
  retained: readonly RetainedObservation[];
  control: ControlObservation;
}>;

type ChildOutcome = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

function isChildMode(value: string): value is ChildMode {
  return CHILD_MODES.some((known) => known === value);
}

/** One temporary root every child run leaves unretained, so ordinary removal stays observable. */
function controlRoot(context: TestContext): ControlObservation {
  const root = temporaryDirectory(context, "keiyaku-v4-fixture-retention-control-");
  const marker = join(root, "control-evidence.bin");
  writeFileSync(marker, MARKER_BYTES);
  return { root, marker, markerBase64: MARKER_BYTES.toString("base64") };
}

/** The helper's returned retained path; no result proves child closure. */
async function cleanupReturned(fixturePath: string, expectRetainedEvidence = false): Promise<void> {
  const cleanup = await cleanupSpawnCapableFixture({
    fixturePath,
    pidReceiptPath: join(fixturePath, "absent-body-pids"),
    timeoutMs: 0,
    operationFailed: true,
    expectRetainedEvidence,
  });
  assert.deepEqual(cleanup, {
    kind: "retained",
    diagnostic: "spawn-capable operation failed before birth proof",
  });
}

/** The helper's throwing path: cleanup could not prove the launch set closed. */
async function cleanupUnproven(fixturePath: string): Promise<void> {
  await assert.rejects(
    cleanupSpawnCapableFixture({
      fixturePath,
      pidReceiptPath: join(fixturePath, "absent-body-pids"),
      timeoutMs: 0,
      operationFailed: false,
    }),
    /missing fixture child pid receipt/u,
  );
}

/** Write one marker at the retained root and one in a nested child, then report both externally. */
function markRetainedRoots(nestedOf: (root: string) => string): readonly RetainedObservation[] {
  return retainedFixtureRoots().map((retention) => {
    const marker = join(retention.path, "retained-evidence.bin");
    writeFileSync(marker, MARKER_BYTES);
    const nested = nestedOf(retention.path);
    writeFileSync(nested, NESTED_MARKER_BYTES);
    return {
      root: retention.path,
      reason: retention.reason,
      expected: retention.expected,
      marker,
      markerBase64: MARKER_BYTES.toString("base64"),
      nested,
      nestedBase64: NESTED_MARKER_BYTES.toString("base64"),
    };
  });
}

/**
 * Retain nested Git fixture roots through the returned path, the throwing path,
 * and a declared returned path; every request names the nested `<root>/repository`.
 */
async function retainNestedGitEvidence(): Promise<readonly RetainedObservation[]> {
  const returned = makeGitRepository();
  const unproven = makeGitRepository();
  const declared = makeGitRepository();
  await cleanupReturned(returned.path);
  await cleanupUnproven(unproven.path);
  await cleanupReturned(declared.path, true);
  const retained = retainedFixtureRoots();
  assert.equal(retained.length, 3);
  assert.deepEqual(
    retained.map((record) => realpathSync(record.path)).sort(),
    [dirname(returned.path), dirname(unproven.path), dirname(declared.path)].sort(),
  );
  assert.deepEqual(
    retained.map((record) => record.expected).sort(),
    [false, false, true],
  );
  return markRetainedRoots((root) => join(root, "repository", "nested-evidence.bin"));
}

type TemporaryRetentionKind = "returned" | "unproven";

/** Retain exactly one generic temporary directory through one helper path. */
async function retainTemporaryDirectoryEvidence(
  context: TestContext,
  kind: TemporaryRetentionKind,
): Promise<readonly RetainedObservation[]> {
  const root = temporaryDirectory(context, `keiyaku-v4-fixture-retention-${kind}-`);
  if (kind === "unproven") await cleanupUnproven(root);
  else await cleanupReturned(root);
  const retained = retainedFixtureRoots();
  assert.equal(retained.length, 1);
  assert.deepEqual(
    retained.map((record) => record.path),
    [root],
  );
  assert.deepEqual(
    retained.map((record) => record.expected),
    [false],
  );
  return markRetainedRoots((retainedRoot) => join(retainedRoot, "nested-evidence.bin"));
}

/**
 * One declared root and one undeclared root in the same runner: the declaration
 * is a property of one decision, so the undeclared root must still fail by name
 * while the declared root stays byte-intact and unfailed. This is what proves the
 * declaration is not a broad default waiver.
 */
async function retainDeclaredAndUndeclaredEvidence(context: TestContext): Promise<readonly RetainedObservation[]> {
  const declared = temporaryDirectory(context, "keiyaku-v4-fixture-retention-declared-");
  const undeclared = temporaryDirectory(context, "keiyaku-v4-fixture-retention-undeclared-");
  await cleanupReturned(declared, true);
  await cleanupReturned(undeclared);
  const retained = retainedFixtureRoots();
  assert.equal(retained.length, 2);
  assert.deepEqual(
    [...retained.map((record) => record.path)].sort(),
    [declared, undeclared].sort(),
  );
  assert.deepEqual(
    retained.map((record) => record.expected).sort(),
    [false, true],
  );
  return markRetainedRoots((root) => join(root, "nested-evidence.bin"));
}

function readObservation(observationPath: string): Observation {
  return JSON.parse(readFileSync(observationPath, "utf8")) as Observation;
}

/** Spawn this bounded child runner and collect its outcome; only a live owned handle is retired. */
async function runFixtureChild(mode: string, observationPath: string): Promise<ChildOutcome> {
  const entry = fileURLToPath(import.meta.url);
  const loader = entry.endsWith(".ts") ? ["--import", "tsx"] : [];
  const environment: NodeJS.ProcessEnv = { ...process.env, [CHILD_MODE_ENV]: mode, [CHILD_OBSERVATION_ENV]: observationPath };
  // The outer fixture already runs inside a node:test child; a nested run must not
  // inherit that context or the runner would skip the child file instead of running it.
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [...loader, "--test", "--test-reporter=spec", entry], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exited = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let expiry: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      exited,
      new Promise<"expired">((resolve) => {
        expiry = setTimeout(() => resolve("expired"), CHILD_TIMEOUT_MS);
      }),
    ]);
    if (outcome === "expired") {
      throw new Error(`fixture retention child runner ${mode} did not exit within ${CHILD_TIMEOUT_MS}ms`);
    }
    return {
      ...outcome,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
  } finally {
    clearTimeout(expiry);
    if (child.exitCode === null && child.signalCode === null) {
      // Retire the runner this fixture still owns; never a stale pid or a signal by name.
      child.kill("SIGKILL");
      await exited.catch(() => undefined);
    }
  }
}

const retentionDiagnosticLine = (retained: RetainedObservation): string =>
  retained.expected
    ? `${DIAGNOSTIC_PREFIX}${retained.root} as declared evidence: ${retained.reason}`
    : `${DIAGNOSTIC_PREFIX}${retained.root}: ${retained.reason}`;

const unexpectedFailureLine = (retained: RetainedObservation): string =>
  `unexpectedly retained ${retained.root}: ${retained.reason}`;

function retentionDiagnostics(outcome: ChildOutcome): readonly string[] {
  // The runner captures a child file's stderr and forwards it through the reporter,
  // so the root-level diagnostic is read from either stream as reported.
  return `${outcome.stdout}\n${outcome.stderr}`
    .split("\n")
    .filter((line) => line.startsWith(DIAGNOSTIC_PREFIX));
}

function assertRetainedEvidence(retained: RetainedObservation): void {
  assert.equal(existsSync(retained.root), true, `retained root ${retained.root} must survive the runner`);
  assert.equal(readFileSync(retained.marker).toString("base64"), retained.markerBase64);
  assert.equal(existsSync(retained.nested), true, `nested fixture ${retained.nested} must survive the runner`);
  assert.equal(readFileSync(retained.nested).toString("base64"), retained.nestedBase64);
}

/** Run one child mode, inspect it, then clean retained probe evidence only after child closure. */
async function withChildRun(
  mode: string,
  inspect: (outcome: ChildOutcome, observation: Observation) => void,
): Promise<void> {
  const observationRoot = mkdtempSync(join(tmpdir(), "keiyaku-v4-fixture-retention-observation-"));
  const observationPath = join(observationRoot, "observation.json");
  let observation: Observation | undefined;
  try {
    const outcome = await runFixtureChild(mode, observationPath);
    observation = readObservation(observationPath);
    inspect(outcome, observation);
  } finally {
    if (observation === undefined && existsSync(observationPath)) observation = readObservation(observationPath);
    for (const retained of observation?.retained ?? []) await removeTempDirectory(retained.root);
    await removeTempDirectory(observationRoot);
  }
}

/** A returned-only or throwing-only generic temporary directory must fail its owning teardown. */
async function assertUnexpectedTemporaryDirectory(mode: ChildMode): Promise<void> {
  await withChildRun(mode, (outcome, observation) => {
    assert.equal(outcome.signal, null, outcome.stdout);
    assert.equal(outcome.code, 1, outcome.stdout);
    assert.equal(observation.retained.length, 1);
    const retained = observation.retained[0];
    assert.ok(retained !== undefined);
    assert.equal(retained.expected, false);
    assertRetainedEvidence(retained);
    assert.deepEqual([...retentionDiagnostics(outcome)], [retentionDiagnosticLine(retained)]);
    assert.ok(
      outcome.stdout.includes(`unexpectedly retained fixture ${retained.root}: ${retained.reason}`),
      outcome.stdout,
    );
    assert.equal(existsSync(observation.control.root), false, "the unretained control root must be removed");
  });
}

function defineOuterTests(): void {
  test("nested Git fixture roots survive runner exit and every undeclared retention fails by name", async () => {
    await withChildRun("retain-nested-git", (outcome, observation) => {
      assert.equal(outcome.signal, null, outcome.stdout);
      assert.equal(outcome.code, 1, outcome.stdout);
      assert.equal(observation.retained.length, 3);
      for (const retained of observation.retained) assertRetainedEvidence(retained);
      assert.deepEqual(
        [...retentionDiagnostics(outcome)].sort(),
        [...observation.retained.map(retentionDiagnosticLine)].sort(),
      );
      const unexpected = observation.retained.filter((retained) => !retained.expected);
      const declared = observation.retained.filter((retained) => retained.expected);
      assert.equal(unexpected.length, 2);
      assert.equal(declared.length, 1);
      assert.match(outcome.stdout, /fixture directory cleanup failed/u);
      for (const retained of unexpected) {
        assert.ok(outcome.stdout.includes(unexpectedFailureLine(retained)), outcome.stdout);
      }
      assert.equal(
        outcome.stdout.includes(`unexpectedly retained ${declared[0]!.root}: `),
        false,
        "declared evidence must not fail the file",
      );
      assert.equal(existsSync(observation.control.root), false, "the unretained control root must be removed");
    });
  });

  test("a returned-only retained generic temporary directory fails its owning teardown", async () => {
    await assertUnexpectedTemporaryDirectory("retain-returned-temporary-directory");
  });

  test("a throwing-only retained generic temporary directory fails its owning teardown", async () => {
    await assertUnexpectedTemporaryDirectory("retain-unproven-temporary-directory");
  });

  test("a declared retention does not waive unexpected retention for another root", async () => {
    await withChildRun("retain-declared-and-undeclared-temporary-directories", (outcome, observation) => {
      assert.equal(outcome.signal, null, outcome.stdout);
      assert.equal(outcome.code, 1, outcome.stdout);
      assert.equal(observation.retained.length, 2);
      for (const retained of observation.retained) assertRetainedEvidence(retained);
      assert.deepEqual(
        [...retentionDiagnostics(outcome)].sort(),
        [...observation.retained.map(retentionDiagnosticLine)].sort(),
      );
      const declared = observation.retained.filter((retained) => retained.expected);
      const undeclared = observation.retained.filter((retained) => !retained.expected);
      assert.equal(declared.length, 1);
      assert.equal(undeclared.length, 1);
      assert.ok(
        outcome.stdout.includes(`unexpectedly retained fixture ${undeclared[0]!.root}: ${undeclared[0]!.reason}`),
        outcome.stdout,
      );
      assert.ok(outcome.stdout.includes(unexpectedFailureLine(undeclared[0]!)), outcome.stdout);
      assert.equal(
        outcome.stdout.includes(`unexpectedly retained ${declared[0]!.root}: `),
        false,
        "the declared root must stay unfailed while the undeclared root still fails",
      );
      assert.equal(existsSync(observation.control.root), false, "the unretained control root must be removed");
    });
  });

  test("an unretained temporary directory is removed and the runner exits clean", async () => {
    await withChildRun("remove-unretained", (outcome, observation) => {
      assert.equal(outcome.signal, null, outcome.stdout);
      assert.equal(outcome.code, 0, outcome.stdout);
      assert.deepEqual(observation.retained, []);
      assert.deepEqual(retentionDiagnostics(outcome), []);
      assert.equal(existsSync(observation.control.root), false);
      assert.equal(existsSync(observation.control.marker), false);
    });
  });
}

const childMode = process.env[CHILD_MODE_ENV];
if (childMode === undefined) {
  defineOuterTests();
} else {
  test(`fixture retention child runner (${childMode})`, async (context) => {
    const observationPath = process.env[CHILD_OBSERVATION_ENV];
    assert.ok(observationPath !== undefined, "the child fixture retention runner needs an observation path");
    assert.ok(isChildMode(childMode), `unknown fixture retention child mode: ${childMode}`);
    const control = controlRoot(context);
    const retained =
      childMode === "retain-nested-git"
        ? await retainNestedGitEvidence()
        : childMode === "retain-returned-temporary-directory"
          ? await retainTemporaryDirectoryEvidence(context, "returned")
          : childMode === "retain-unproven-temporary-directory"
            ? await retainTemporaryDirectoryEvidence(context, "unproven")
            : childMode === "retain-declared-and-undeclared-temporary-directories"
              ? await retainDeclaredAndUndeclaredEvidence(context)
              : [];
    writeFileSync(observationPath, `${JSON.stringify({ mode: childMode, retained, control }, null, 2)}\n`, "utf8");
  });
}
