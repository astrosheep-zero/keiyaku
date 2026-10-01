import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { TestContext } from "node:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROCESS_EXIT_POLL_MS = 20;
const PROCESS_EXIT_TIMEOUT_MS = 2_000;
const TEMP_DIRECTORY_TIMEOUT_MS = 2_000;
/** Generous fixture budget: real Body, request, and Verification subprocesses can be slow under full-suite load. */
const CONDITION_WAIT_BUDGET_MS = 60_000;
const CONDITION_WAIT_POLL_MS = 5;

function isMissingProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

export async function waitForProcessExit(pid: number, timeoutMs = PROCESS_EXIT_TIMEOUT_MS): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (processExists(pid)) {
    if (performance.now() >= deadline) throw new Error(`process ${pid} survived`);
    await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS));
  }
}

export async function waitForFixtureFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for barrier file: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS));
  }
}

export type WaitForConditionOptions = Readonly<{
  /** Bounded override for focused coverage of the wait itself; call sites keep the generous default. */
  budgetMs?: number;
  /**
   * Names a terminal state of the request, pump, or process behind the awaited condition. A non-null
   * value means the awaited event can no longer arrive, so the wait ends naming that state instead
   * of spinning.
   */
  terminalState?: () => string | null | Promise<string | null>;
}>;

/**
 * Bounded fixture wait over external state (a Heart read, file probe, or process observation).
 * Expiry names what was awaited, the budget, and the elapsed time; a terminal-state probe ends the
 * wait early when a settlement behind the condition makes it unreachable.
 */
export async function waitForCondition(
  description: string,
  condition: () => boolean | Promise<boolean>,
  options: WaitForConditionOptions = {},
): Promise<void> {
  const budgetMs = options.budgetMs ?? CONDITION_WAIT_BUDGET_MS;
  const startedAt = Date.now();
  for (;;) {
    if (await condition()) return;
    const terminalState = await options.terminalState?.();
    const elapsedMs = Date.now() - startedAt;
    if (terminalState !== undefined && terminalState !== null) {
      throw new Error(
        `fixture wait for ${description} ended after ${elapsedMs}ms: reached terminal state ${terminalState}`,
      );
    }
    if (elapsedMs >= budgetMs) {
      throw new Error(`fixture wait for ${description} expired after ${elapsedMs}ms (budget ${budgetMs}ms)`);
    }
    await new Promise((resolve) => setTimeout(resolve, CONDITION_WAIT_POLL_MS));
  }
}

/**
 * Reports how a request, pump, or Body settled so a bounded wait can end on a dead outcome
 * instead of spinning to its budget.
 */
export function settlementProbe<T>(settlement: Promise<T>, describe: (settled: T) => string): () => string | null {
  let terminalState: string | null = null;
  void settlement.then(
    (settled) => {
      terminalState = describe(settled);
    },
    (error: unknown) => {
      terminalState = `failure ${error instanceof Error ? error.message : String(error)}`;
    },
  );
  return () => terminalState;
}

/**
 * Fail with `message` when a Body-driven promise does not settle within the
 * bounded timeout; a settled promise resolves or rejects as itself.
 */
export async function expectBodySettles(body: Promise<unknown>, message: string, timeoutMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      body,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function akumaBodyPidReceiptImport(): string {
  return pathToFileURL(resolve("tests/support/akuma-body-pid-receipt.mjs")).href;
}

export function appendNodeOptionsImport(moduleUrl: string, existing = process.env.NODE_OPTIONS): string {
  const flag = `--import=${moduleUrl}`;
  if (existing === undefined || existing.length === 0) return flag;
  if (existing.split(/\s+/u).includes(flag)) return existing;
  return `${existing} ${flag}`;
}

export function installAkumaBodyPidReceipt(receiptPath: string): () => void {
  const previousReceipt = process.env.KEIYAKU_TEST_AKUMA_BODY_PID_RECEIPT;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.KEIYAKU_TEST_AKUMA_BODY_PID_RECEIPT = receiptPath;
  process.env.NODE_OPTIONS = appendNodeOptionsImport(akumaBodyPidReceiptImport(), previousNodeOptions);
  return () => {
    if (previousReceipt === undefined) delete process.env.KEIYAKU_TEST_AKUMA_BODY_PID_RECEIPT;
    else process.env.KEIYAKU_TEST_AKUMA_BODY_PID_RECEIPT = previousReceipt;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  };
}

export function installAkumaBodyEmptyPublicationBarrier(barrierPath: string): () => void {
  const previousBarrier = process.env.KEIYAKU_TEST_AKUMA_BODY_EMPTY_PUBLICATION_BARRIER;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.KEIYAKU_TEST_AKUMA_BODY_EMPTY_PUBLICATION_BARRIER = barrierPath;
  process.env.NODE_OPTIONS = appendNodeOptionsImport(akumaBodyPidReceiptImport(), previousNodeOptions);
  return () => {
    if (previousBarrier === undefined) delete process.env.KEIYAKU_TEST_AKUMA_BODY_EMPTY_PUBLICATION_BARRIER;
    else process.env.KEIYAKU_TEST_AKUMA_BODY_EMPTY_PUBLICATION_BARRIER = previousBarrier;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  };
}

export function readPidReceipt(path: string): number[] {
  if (!existsSync(path)) return [];
  const seen = new Set<number>();
  const pids: number[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.length === 0) continue;
    if (!/^[1-9][0-9]*$/u.test(line)) throw new Error(`malformed fixture child pid receipt: ${line}`);
    const pid = Number(line);
    if (!Number.isSafeInteger(pid)) throw new Error(`malformed fixture child pid receipt: ${line}`);
    if (seen.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);
  }
  return pids;
}

export type SpawnCapableFixtureCleanup =
  | Readonly<{ kind: "removed" }>
  | Readonly<{ kind: "retained"; diagnostic: string }>;

export type SpawnCapableFixtureCleanupInput = Readonly<{
  fixturePath: string;
  pidReceiptPath: string;
  timeoutMs?: number;
  operationFailed: boolean;
  /**
   * Declare that this test deliberately keeps the fixture's bytes as its own
   * evidence. A returned `kind:"retained"` result is not closure proof, so
   * without this declaration any retention is unexpected and fails its owning
   * teardown by name.
   */
  expectRetainedEvidence?: boolean;
}>;

/** Run the spawn-capable fixture cleanup and report a retained tree through the test context. */
export async function cleanupSpawnCapableFixtureForTest(
  test: TestContext,
  input: SpawnCapableFixtureCleanupInput,
): Promise<void> {
  const cleanup = await cleanupSpawnCapableFixture(input);
  if (cleanup.kind === "retained") test.diagnostic(`retained fixture ${input.fixturePath}: ${cleanup.diagnostic}`);
}

export async function cleanupSpawnCapableFixture(
  input: SpawnCapableFixtureCleanupInput,
): Promise<SpawnCapableFixtureCleanup> {
  const expected = input.expectRetainedEvidence === true;
  try {
    if (input.operationFailed && readPidReceipt(input.pidReceiptPath).length === 0) {
      return retainSpawnCapableFixture(
        input.fixturePath,
        "spawn-capable operation failed before birth proof",
        expected,
      );
    }
    await waitForPidReceiptExit(input.pidReceiptPath, input.timeoutMs, { requireBirth: !input.operationFailed });
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    if (!input.operationFailed) {
      // Cleanup failed while the operation claimed success: no result proves the
      // child closed, so record the retention before the throw and let the owning
      // teardown fail rather than delete evidence a later hook would erase.
      recordRetainedFixtureRoot(input.fixturePath, diagnostic, { expected });
      throw error;
    }
    return retainSpawnCapableFixture(input.fixturePath, diagnostic, expected);
  }
  if (input.operationFailed) {
    return retainSpawnCapableFixture(
      input.fixturePath,
      "spawn-capable operation failed without proof that its launch set is closed",
      expected,
    );
  }
  await removeTempDirectory(input.fixturePath);
  return { kind: "removed" };
}

/** Record the retention decision before the existing retained result reaches its caller. */
function retainSpawnCapableFixture(
  fixturePath: string,
  diagnostic: string,
  expected: boolean,
): SpawnCapableFixtureCleanup {
  recordRetainedFixtureRoot(fixturePath, diagnostic, { expected });
  return { kind: "retained", diagnostic };
}

export async function waitForPidReceiptExit(
  receiptPath: string,
  timeoutMs = PROCESS_EXIT_TIMEOUT_MS,
  options: Readonly<{ requireBirth?: boolean }> = {},
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  if (options.requireBirth === true) {
    while (readPidReceipt(receiptPath).length === 0) {
      if (performance.now() >= deadline) throw new Error(`missing fixture child pid receipt: ${receiptPath}`);
      await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS));
    }
  }
  let known = readPidReceipt(receiptPath);
  for (;;) {
    for (const pid of known) await waitForProcessExit(pid, Math.max(0, deadline - performance.now()));
    const next = readPidReceipt(receiptPath);
    const newcomers = next.filter((pid) => !known.includes(pid));
    if (newcomers.length === 0 && next.every((pid) => !processExists(pid))) return;
    known = next;
    if (performance.now() >= deadline) {
      const alive = next.filter(processExists);
      throw new Error(`fixture child process(es) survived: ${alive.join(", ") || next.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS));
  }
}

export async function removeTempDirectory(path: string): Promise<void> {
  const deadline = performance.now() + TEMP_DIRECTORY_TIMEOUT_MS;
  while (true) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      // A departing fixture process can still hold or repopulate the tree; retry
      // the transient filesystem races on every platform until the tree is gone.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EACCES" && code !== "EBUSY" && code !== "EPERM") throw error;
      if (performance.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** A fresh one-shot barrier; tests own when it resolves or rejects. */
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * One process-local owner for fixture-root retention. Roots register here where
 * they are allocated; a cleanup helper records a bounded reason when it must
 * leave evidence in place. Nested cleanup requests resolve to the containing
 * registered root, so the single root-level teardown that owns the tree honors
 * the decision and no later hook erases evidence by forgetting an earlier
 * helper result. This is test bookkeeping for one runner process, not a durable
 * marker, pid registry, or second authority store.
 */
const ownedFixtureRoots = new Map<string, FixtureRetention | undefined>();
const reportedRetainedRoots = new Set<string>();

/** A recorded decision to leave one owned fixture root physically untouched. */
export type FixtureRetention = Readonly<{
  /** Bounded reason the evidence was retained. */
  reason: string;
  /**
   * True only when the owning test declared this retention as its own deliberate
   * evidence. No helper result proves child closure, so any retention without
   * that declaration is unexpected and fails its owning teardown by name.
   */
  expected: boolean;
}>;

/** A retained owned root as read back by a fixture that records evidence externally. */
export type RetainedFixtureRoot = Readonly<{ path: string }> & FixtureRetention;

/** The canonical form used for containment, so a resolved alias still matches its owning root. */
function canonicalFixturePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Register an owned fixture root at allocation and return its exact identity.
 * The stored path is never rewritten; containment compares canonical forms only.
 */
export function ownFixtureRoot(path: string): string {
  ownedFixtureRoots.set(path, undefined);
  return path;
}

/** Owned fixture roots still registered, in allocation order. */
export function ownedFixtureRootPaths(): readonly string[] {
  return [...ownedFixtureRoots.keys()];
}

/** The registered owned root containing `path`, or undefined when no owned root contains it. */
function ownedFixtureRootContaining(path: string): string | undefined {
  const target = canonicalFixturePath(path);
  let containing: string | undefined;
  let containingCanonical: string | undefined;
  for (const root of ownedFixtureRoots.keys()) {
    const candidate = canonicalFixturePath(root);
    if (target !== candidate && !target.startsWith(candidate.endsWith(sep) ? candidate : `${candidate}${sep}`)) {
      continue;
    }
    if (containingCanonical === undefined || candidate.length > containingCanonical.length) {
      containing = root;
      containingCanonical = candidate;
    }
  }
  return containing;
}

/** The retention recorded for one exact owned root, or undefined when it must be removed. */
export function retainedFixtureRoot(path: string): FixtureRetention | undefined {
  return ownedFixtureRoots.get(path);
}

/** Retained owned roots in allocation order, for a fixture recording evidence externally. */
export function retainedFixtureRoots(): readonly RetainedFixtureRoot[] {
  const retained: RetainedFixtureRoot[] = [];
  for (const [path, retention] of ownedFixtureRoots) {
    if (retention !== undefined) retained.push({ path, ...retention });
  }
  return retained;
}

/**
 * Release bookkeeping for an owned root no later hook will consume. A retained
 * root is never released here: another registered cleanup hook may still remove it.
 */
export function releaseOwnedFixtureRoot(path: string): void {
  ownedFixtureRoots.delete(path);
}

/** Emit at most one bounded root-level diagnostic per retained root; retention is never silent. */
function reportRetainedFixtureRoot(root: string, reason: string, expected: boolean): void {
  if (reportedRetainedRoots.has(root)) return;
  reportedRetainedRoots.add(root);
  const disposition = expected ? " as declared evidence" : "";
  process.stderr.write(`[fixture-retention] retained ${root}${disposition}: ${reason}\n`);
}

/**
 * Record a cleanup's decision to retain evidence, attributed to the containing
 * owned root. The first reason names the root's single diagnostic; a root stays
 * expected only while every decision for it declared that expectation.
 */
export function recordRetainedFixtureRoot(
  path: string,
  reason: string,
  options: Readonly<{ expected: boolean }>,
): void {
  const root = ownedFixtureRootContaining(path);
  if (root === undefined) return;
  const existing = ownedFixtureRoots.get(root);
  if (existing !== undefined) {
    // One decision per root, and an undeclared retention is never upgraded by a
    // later declared one: the root is already evidence no hook may delete.
    if (existing.expected && !options.expected) {
      ownedFixtureRoots.set(root, { reason: existing.reason, expected: false });
    }
    return;
  }
  ownedFixtureRoots.set(root, { reason, expected: options.expected });
  reportRetainedFixtureRoot(root, reason, options.expected);
}

/** Register cleanup before fixture setup, including setup failures. No directory is shared. */
export function temporaryDirectory(context: TestContext, prefix: string): string {
  const directory = ownFixtureRoot(mkdtempSync(join(tmpdir(), prefix)));
  context.after(() => {
    const retention = retainedFixtureRoot(directory);
    if (retention !== undefined) {
      // Retained bytes are the evidence this decision preserved. Only a test
      // that declared the retention as its own evidence may keep it silently;
      // every other retention is unexpected and fails this owning teardown.
      if (retention.expected) return;
      throw new Error(`unexpectedly retained fixture ${directory}: ${retention.reason}`);
    }
    rmSync(directory, { recursive: true, force: true });
    releaseOwnedFixtureRoot(directory);
  });
  return directory;
}

/** Restore one environment variable to its snapshot, deleting it when it was unset. */
export function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Restore every named variable in a previously captured snapshot. */
export function restoreEnvironmentValues(values: Readonly<Record<string, string | undefined>>): void {
  for (const [name, value] of Object.entries(values)) restoreEnvironment(name, value);
}

/** Best-effort fixture cleanup after the child may have stopped on its own. */
export function killFixtureProcess(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already stopped */
  }
}
