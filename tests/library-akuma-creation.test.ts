import { accepted } from "./support/library-verbs.js";
import { present } from "./support/library-verbs.js";
import { temporaryDirectory } from "./support/process.js";
import { settlementProbe, waitForCondition } from "./support/process.js";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AkumaArchetypeError, loadPreparedArchetype } from "../src/akuma/archetype.js";
import { harnessOwner } from "@astrosheep/square";
import {
  beginTurn,
  bindTellsToTurn,
  endTurn,
  finishBodyIfIdle,
  HeldAkumaLeash,
  readHeart,
  readSoul,
  readTell,
  readTurn,
  recordTell,
} from "../src/akuma/heart/index.js";
import { parseAkuId, pathsForAkuId } from "../src/akuma/identity.js";
import { Akuma as PublicAkuma, Schema } from "../src/akuma/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { cliJson } from "./support/cli-fixtures.js";
import type { CallResult } from "../src/library/akumas.js";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import { Akumas, Keiyaku, Repo, World, settings } from "../src/index.js";
import {
  cleanupSpawnCapableFixtureForTest,
  installAkumaBodyEmptyPublicationBarrier,
  installAkumaBodyIdleFinishBarrier,
  installAkumaBodyPidReceipt,
  readPidReceipt,
  waitForProcessExit,
} from "./support/process.js";
import { AkumaOwner, isolateSquareFixtureLedger } from "./support/akuma-composition.js";
import { makeGitRepository } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";

async function repositoryFixture() {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return { raw, repo: await Repo.at({ path: raw.path }), git: await repositoryAt(raw.path) };
}

async function directArchetypeSettings(root: string, answerReleasePath?: string) {
  const home = join(root, ".direct-settings");
  const executable = join(root, "fake-codex");
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(home, "akumas"), { recursive: true });
  writeFileSync(join(home, "akumas", "worker.md"), "---\nprovider: local\n---\nWork.\n");
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({
      providers: { local: { kind: "codex-app-server", executable } },
    }),
  );
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      "const readline = require('node:readline');",
      "const { existsSync } = require('node:fs');",
      `const answerReleasePath = ${JSON.stringify(answerReleasePath ?? null)};`,
      "const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
      "const reply = (message, result) => send({ id: message.id, result });",
      "const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "lines.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') return reply(message, {});",
      "  if (message.method === 'initialized') return;",
      "  if (message.method === 'thread/start') return reply(message, { thread: { id: 'thread-1' }, sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } });",
      "  if (message.method !== 'turn/start') return;",
      "  reply(message, { turn: { id: 'turn-1' } });",
      "  const answer = () => {",
      "    send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: '{\"ok\":true}' } } });",
      "    send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });",
      "  };",
      "  if (answerReleasePath === null || existsSync(answerReleasePath)) return answer();",
      "  const timer = setInterval(() => {",
      "    if (!existsSync(answerReleasePath)) return;",
      "    clearInterval(timer);",
      "    answer();",
      "  }, 5);",
      "});",
    ].join("\n"),
  );
  chmodSync(executable, 0o755);
  const value = await settings({ root, home });
  return { home, value, placement: { home, settings: value } };
}

async function directCallFixture(options: Readonly<{ holdAnswer?: boolean }> = {}) {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const answerReleasePath = options.holdAnswer === true ? join(raw.path, "answer-release") : undefined;
  return {
    raw,
    world,
    configured: await directArchetypeSettings(world, answerReleasePath),
    releaseAnswer() {
      if (answerReleasePath !== undefined) writeFileSync(answerReleasePath, "release\n");
    },
  };
}

function okSchema() {
  return Schema.json(
    { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    (value) => value as { ok: boolean },
  );
}

test("prompt-free bare Akumas.call reports born without admitting a Tell", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const bodyPidReceipt = join(raw.path, "body-pids");
  // Existing Body receipt instrumentation is installed before the call and stays
  // installed until the fixture owner has proven physical departure.
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  let operationFailed = true;
  try {
    const result = await Akumas.of(world).call({
      archetype: "worker",
      cwd: world,
      bare: true,
      writableDirectories: [world, world],
      ...configured.placement,
    });
    assert.deepEqual(result.observation, { kind: "born" });
    const handle = PublicAkuma.select(world, result.akuma);
    assert.deepEqual((await handle.status()).birth, { origin: { kind: "direct" }, caller: { kind: "unknown" } });
    const soul = await readSoul(pathsForAkuId(world, result.akuma));
    assert.equal(soul?.caller, undefined);
    assert.equal(soul?.bare, true);
    assert.deepEqual(soul?.provider.config?.sandbox_workspace_write, {
      writable_roots: [world],
      network_access: false,
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
    });
    const source = await loadPreparedArchetype({
      name: "worker",
      project: world,
      home: configured.home,
      settings: configured.value,
    });
    assert.equal(source.provider.config, undefined, "birth grant never mutates source recipe");
    assert.match(soul?.options.systemPrompt ?? "", /Work\./u);
    const history = await handle.history();
    assert.equal(
      history.rows.some((row) => row.kind === "tell"),
      false,
    );
    // Soul may precede the first Body. The PID-receipt cleanup below awaits
    // this prompt-free publication's natural exit rather than racing a kill.
    operationFailed = false;
  } finally {
    try {
      // The existing spawn-capable fixture owner proves the recorded Body left
      // before anything removes the repository; an unproved departure retains the
      // evidence and fails instead of deleting it.
      await cleanupSpawnCapableFixtureForTest(t, {
        fixturePath: raw.path,
        pidReceiptPath: bodyPidReceipt,
        operationFailed,
      });
    } finally {
      restoreBodyPidReceipt();
    }
  }
});

test("malformed explicit callers refuse before allocation on public call and fork", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-caller-refusal-"));
  const caller = { kind: "unknown" } as never;
  await assert.rejects(Akumas.of(world).call({ archetype: "worker", caller }), /Invalid Akuma caller/u);
  await assert.rejects(
    Akumas.of(world).fork({ akuma: "aku/worker/1234abcd", at: "turn/1", caller }),
    /Invalid Akuma caller/u,
  );
  assert.deepEqual((await Akumas.of(world).list()).rows, []);
});

test("explicit writable directories refuse invalid public grants before allocation", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-directory-refusal-"));
  const configured = await directArchetypeSettings(world);
  const alias = join(world, "directory-alias");
  symlinkSync(world, alias, "dir");
  for (const value of [
    [""],
    ["relative"],
    [join(world, "missing")],
    [alias],
    [join(world, "fake-codex")],
    "not-an-array",
  ]) {
    await assert.rejects(
      Akumas.of(world).call({
        archetype: "worker",
        ...configured.placement,
        writableDirectories: value as never,
      }),
      /writableDirectories|not an existing directory/u,
    );
  }
  await assert.rejects(
    PublicAkuma.birth("worker", {
      root: world,
      ...configured.placement,
      writableDirectories: [alias],
    }),
    /not canonical/u,
  );
  assert.deepEqual((await Akumas.of(world).list()).rows, []);
});

test("prompt-free Akumas.call refuses schema and wait options", async () => {
  const { world, configured } = await directCallFixture();
  await assert.rejects(
    () => Akumas.of(world).call({ archetype: "worker", ...configured.placement, schema: okSchema() }),
    /schema requires body/u,
  );
  await assert.rejects(
    () => Akumas.of(world).call({ archetype: "worker", ...configured.placement, mode: "wait" }),
    /wait and timeoutMs require body/u,
  );
});

test("local schema Akumas.call waits for its held empty Body before admitting its Tell", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const schema = okSchema();
  const bodyPidReceipt = join(raw.path, "body-pids");
  const emptyPublicationBarrier = join(raw.path, "empty-publication-barrier");
  mkdirSync(emptyPublicationBarrier);
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const restoreEmptyPublicationBarrier = installAkumaBodyEmptyPublicationBarrier(emptyPublicationBarrier);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let akumaId: string | undefined;
  let operationFailed = true;
  try {
    const pending = Akumas.of(world).call({
      archetype: "worker",
      body: "schema-call",
      cwd: world,
      ...configured.placement,
      mode: "wait",
      schema,
    });
    void pending.catch(() => undefined);
    let result: Awaited<typeof pending>;
    try {
      const readyPath = join(emptyPublicationBarrier, "ready");
      await waitForCondition("empty Body publication barrier", () => existsSync(readyPath), {
        terminalState: settlementProbe(pending, () => "call settled before empty Body publication"),
      });
      const held = JSON.parse(readFileSync(readyPath, "utf8")) as { id: string };
      const whileHeld = await readHeart(pathsForAkuId(world, parseAkuId(held.id).id));
      assert.equal(whileHeld.latestBody?.end, undefined);
      assert.deepEqual(whileHeld.pending, []);

      writeFileSync(join(emptyPublicationBarrier, "release"), "release\n");
      result = await pending;
    } finally {
      const releasePath = join(emptyPublicationBarrier, "release");
      if (!existsSync(releasePath)) writeFileSync(releasePath, "release\n");
      await pending.catch(() => undefined);
    }
    akumaId = result.akuma;
    assert.equal(result.observation.kind, "observed");
    if (result.observation.kind === "observed")
      assert.deepEqual(result.observation.observation, { reason: "answered", answer: { ok: true } });
    const history = await PublicAkuma.select(world, result.akuma).history();
    const tells = history.rows.filter((row) => row.kind === "tell");
    assert.equal(tells.length, 1);
    assert.equal(tells[0]?.kind, "tell");
    if (tells[0]?.kind === "tell") assert.equal(tells[0].text, "schema-call");
    assert.equal(history.rows.filter((row) => row.kind === "turn").length, 1);
    assert.equal(
      history.rows.some((row) => row.kind === "call"),
      false,
    );
    operationFailed = false;
  } finally {
    try {
      if (akumaId !== undefined)
        await PublicAkuma.select(world, akumaId)
          .kill()
          .catch(() => undefined);
      await cleanupSpawnCapableFixtureForTest(t, {
        fixturePath: raw.path,
        pidReceiptPath: bodyPidReceipt,
        timeoutMs: 15_000,
        operationFailed,
      });
    } finally {
      restoreEmptyPublicationBarrier();
      restoreBodyPidReceipt();
      restoreSquareLedger();
    }
  }
});

test("local schema Akumas.call starts its zero observation budget after birth", async (t) => {
  // An already-answered Tell legitimately wins at the deadline edge. Hold the
  // provider answer until the zero-budget observation has returned instead of
  // racing a real child process against the first observation.
  const { raw, world, configured, releaseAnswer } = await directCallFixture({ holdAnswer: true });
  const schema = okSchema();
  const bodyPidReceipt = join(raw.path, "body-pids");
  const emptyPublicationBarrier = join(raw.path, "empty-publication-barrier");
  mkdirSync(emptyPublicationBarrier);
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const restoreEmptyPublicationBarrier = installAkumaBodyEmptyPublicationBarrier(emptyPublicationBarrier);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let akumaId: string | undefined;
  let wake: Promise<unknown> | undefined;
  let pending: Promise<CallResult> | undefined;
  const admitInitialTell = AkumaOwner.prototype.admitInitialTell;
  t.mock.method(
    AkumaOwner.prototype,
    "admitInitialTell",
    async function (this: AkumaOwner, ...args: Parameters<typeof admitInitialTell>) {
      const admitted = await admitInitialTell.apply(this, args);
      if (admitted.kind === "admitted") wake = admitted.wake;
      return admitted;
    },
  );
  let operationFailed = true;
  try {
    pending = Akumas.of(world).call({
      archetype: "worker",
      body: "zero-budget-after-birth",
      cwd: world,
      ...configured.placement,
      mode: "wait",
      schema,
      timeoutMs: 0,
    });
    void pending.catch(() => undefined);
    const readyPath = join(emptyPublicationBarrier, "ready");
    await waitForCondition(
      "empty Body publication barrier before zero-budget observation",
      () => existsSync(readyPath),
      {
        terminalState: settlementProbe(pending, () => "call settled before empty Body publication"),
      },
    );
    const held = JSON.parse(readFileSync(readyPath, "utf8")) as { id: string };
    const child = parseAkuId(held.id).id;
    assert.equal((await readHeart(pathsForAkuId(world, child))).latestBody?.end, undefined);
    writeFileSync(join(emptyPublicationBarrier, "release"), "release\n");
    const result = await pending;
    akumaId = result.akuma;
    assert.deepEqual(result.observation.kind, "observed");
    if (result.observation.kind === "observed") {
      assert.deepEqual(result.observation.observation, { reason: "deadline" });
      assert.equal(result.observation.tell.row.text, "zero-budget-after-birth");
    }
    releaseAnswer();
    assert.equal((await PublicAkuma.select(world, result.akuma).idle({ timeoutMs: 15_000 })).reason, "completed");
    const history = await PublicAkuma.select(world, result.akuma).history();
    const tells = history.rows.filter((row) => row.kind === "tell");
    assert.equal(tells.length, 1);
    assert.equal(tells[0]?.kind === "tell" ? tells[0].text : undefined, "zero-budget-after-birth");
    const outcome = history.rows.find((row) => row.kind === "outcome")?.outcome;
    assert.equal(outcome?.kind, "answered");
    if (outcome?.kind === "answered") assert.equal(outcome.answer, '{"ok":true}');
    operationFailed = false;
  } finally {
    try {
      releaseAnswer();
      const releasePath = join(emptyPublicationBarrier, "release");
      if (!existsSync(releasePath)) writeFileSync(releasePath, "release\n");
      const settled = await pending?.catch(() => undefined);
      akumaId ??= settled?.akuma;
      if (akumaId !== undefined)
        await PublicAkuma.select(world, akumaId)
          .kill()
          .catch(() => undefined);
      await wake?.catch(() => undefined);
      await cleanupSpawnCapableFixtureForTest(t, {
        fixturePath: raw.path,
        pidReceiptPath: bodyPidReceipt,
        timeoutMs: 15_000,
        operationFailed,
      });
    } finally {
      restoreEmptyPublicationBarrier();
      restoreBodyPidReceipt();
      restoreSquareLedger();
    }
  }
});

test("bounded call preserves logs and captures diagnostics without duplicate emission or callback authority", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const bodyPidReceipt = join(raw.path, "body-pids");
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const output = join(world, "plugin-signals.jsonl");
  mkdirSync(join(world, "plugins"), { recursive: true });
  writeFileSync(
    join(world, "plugins", "record.mjs"),
    `
    import { appendFileSync } from "node:fs";
    export default {
      manifest: { id: "record", apiVersion: 1 },
      activate(context) {
        const record = (signal) => {
          appendFileSync(context.config.output, JSON.stringify(signal) + "\\n");
          throw new Error("call observer failed");
        };
        return { signals: { "akuma.born": record, "akuma.outcome-observed": record } };
      }
    };
  `,
  );
  writeFileSync(
    join(world, ".keiyaku", "settings.json"),
    JSON.stringify({
      plugins: { record: { package: "./plugins/record.mjs", config: { output } } },
    }),
  );
  const diagnostics: string[] = [];
  const stderr: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    stderr.push(message);
  });
  let child: string | undefined;
  let operationFailed = true;
  try {
    const result = await Akumas.of(world, {
      reportDiagnostic: async (message) => {
        diagnostics.push(message);
        throw new Error("host rejects diagnostic");
      },
    }).call({
      archetype: "worker",
      body: "bounded observation",
      cwd: world,
      caller: { kind: "external", integration: "tests", id: "submit:bounded" },
      initiator: "Submitter",
      home: configured.home,
      settings: await settings({ root: world, home: configured.home }),
      mode: "wait",
      signal: t.signal,
    });
    child = result.akuma;
    assert.equal(result.observation.kind, "observed");
    assert.ok(result.observation.kind === "observed");
    assert.deepEqual(result.observation.observation, { reason: "answered", answer: '{"ok":true}' });
    const tell = await readTell(pathsForAkuId(world, result.akuma), result.observation.tell.admission.tellId);
    assert.ok(tell?.binding);
    assert.deepEqual(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [
        {
          kind: "akuma.born",
          akumaId: result.akuma,
          bodySequence: 1,
          origin: { kind: "direct" },
          caller: { kind: "external", integration: "tests", id: "submit:bounded" },
          initiator: "Submitter",
        },
        { kind: "akuma.outcome-observed", akumaId: result.akuma, historyId: `turn/${tell.binding.turnSequence}` },
      ],
    );
    assert.deepEqual(
      diagnostics,
      ["plugin record signal: call observer failed"],
      "remote birth diagnostics belong to the Body, not this host",
    );
    assert.deepEqual((await PublicAkuma.select(world, result.akuma, { reportDiagnostic() {} }).status()).birth, {
      origin: { kind: "direct" },
      caller: { kind: "external", integration: "tests", id: "submit:bounded" },
    });
    const log = pathsForAkuId(world, result.akuma).log;
    await waitForCondition("submitting call observation diagnostic log", () =>
      readFileSync(log, "utf8").includes("plugin outcome observation failed:"),
    );
    const logged = readFileSync(log, "utf8");
    assert.ok(logged.includes("plugin birth failed: plugin record signal: call observer failed"));
    assert.ok(logged.includes("plugin outcome observation failed: plugin record signal: call observer failed"));
    assert.deepEqual(stderr, [], "call diagnostics do not use the local observation stderr default");
    operationFailed = false;
  } finally {
    if (child !== undefined)
      await PublicAkuma.select(world, child)
        .kill()
        .catch(() => undefined);
    await cleanupSpawnCapableFixtureForTest(t, {
      fixturePath: raw.path,
      pidReceiptPath: bodyPidReceipt,
      timeoutMs: 15_000,
      operationFailed,
    });
    restoreBodyPidReceipt();
  }
});

test("call without a host preserves log-only diagnostics", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const bodyPidReceipt = join(raw.path, "body-pids");
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  mkdirSync(join(world, "plugins"), { recursive: true });
  writeFileSync(
    join(world, "plugins", "fail.mjs"),
    `export default {
    manifest: { id: "fail", apiVersion: 1 },
    activate() { return { signals: { "akuma.born": () => { throw new Error("birth-only failure"); } } }; }
  };`,
  );
  writeFileSync(
    join(world, ".keiyaku", "settings.json"),
    JSON.stringify({
      plugins: { fail: { package: "./plugins/fail.mjs" } },
    }),
  );
  const stderr: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    stderr.push(message);
  });
  let operationFailed = true;
  try {
    const result = await Akumas.of(world).call({
      archetype: "worker",
      cwd: world,
      home: configured.home,
      settings: await settings({ root: world, home: configured.home }),
    });
    assert.deepEqual(result.observation, { kind: "born" });
    const log = pathsForAkuId(world, result.akuma).log;
    await waitForCondition(
      "log-only birth diagnostic",
      () => existsSync(log) && readFileSync(log, "utf8").includes("birth-only failure"),
    );
    assert.ok(readFileSync(log, "utf8").includes("plugin birth failed: plugin fail signal: birth-only failure"));
    assert.deepEqual(stderr, []);
    // Prompt-free birth can precede its Body fact. The PID-receipt cleanup owns
    // and awaits that process's natural empty publication exit, without a kill race.
    operationFailed = false;
  } finally {
    await cleanupSpawnCapableFixtureForTest(t, {
      fixturePath: raw.path,
      pidReceiptPath: bodyPidReceipt,
      timeoutMs: 15_000,
      operationFailed,
    });
    restoreBodyPidReceipt();
  }
});

test("a Tell admitted while an empty Body is deciding to put down is still driven", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const bodyPidReceipt = join(raw.path, "body-pids");
  const barrier = join(raw.path, "idle-finish-barrier");
  mkdirSync(barrier);
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const restoreIdleBarrier = installAkumaBodyIdleFinishBarrier(barrier);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let child: PublicAkuma | undefined;
  let tellRecorded = false;
  let operationFailed = true;
  try {
    child = await PublicAkuma.birth("worker", { root: world, cwd: world, ...configured.placement });
    await waitForCondition("Body idle-finish barrier", () => existsSync(join(barrier, "idle-ready")), {
      budgetMs: 5_000,
    });
    await waitForCondition("Body periodic observation barrier", () => existsSync(join(barrier, "observation-ready")), {
      budgetMs: 5_000,
    });
    const paths = pathsForAkuId(world, child.id);
    const admitted = await recordTell(paths, {
      kind: "tell",
      id: "late-tell",
      body: "answer",
      recordedAt: new Date().toISOString(),
    });
    assert.equal(admitted.kind, "recorded");
    tellRecorded = true;
    writeFileSync(join(barrier, "release"), "release\\n");
    await waitForCondition(
      "late Tell answer",
      async () => {
        const tell = await readTell(paths, "late-tell");
        if (tell?.binding === undefined) return false;
        const turn = await readTurn(paths, tell.binding.turnSequence);
        return turn?.end?.outcome.kind === "answered";
      },
      { budgetMs: 5_000 },
    );
    const tell = await readTell(paths, "late-tell");
    const turn = tell?.binding === undefined ? null : await readTurn(paths, tell.binding.turnSequence);
    assert.equal(turn?.end?.outcome.kind, "answered");
    if (turn?.end?.outcome.kind === "answered") assert.equal(turn.end.outcome.answer, '{"ok":true}');
    writeFileSync(join(barrier, "observation-release"), "release\\n");
    operationFailed = false;
  } finally {
    try {
      if (operationFailed && child !== undefined && tellRecorded) {
        const tell = await readTell(pathsForAkuId(world, child.id), "late-tell");
        if (tell?.state === "pending" && tell.binding === undefined && tell.deliveries.length === 0) {
          for (const pid of readPidReceipt(bodyPidReceipt)) {
            try {
              process.kill(pid, "SIGTERM");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
            await waitForProcessExit(pid, 5_000);
          }
        }
      }
    } finally {
      writeFileSync(join(barrier, "release"), "release\\n");
      writeFileSync(join(barrier, "observation-release"), "release\\n");
      restoreIdleBarrier();
      restoreBodyPidReceipt();
      restoreSquareLedger();
      await cleanupSpawnCapableFixtureForTest(t, {
        fixturePath: raw.path,
        pidReceiptPath: bodyPidReceipt,
        timeoutMs: 15_000,
        operationFailed,
        expectRetainedEvidence: operationFailed,
      });
    }
  }
});

test("native birth retains its captured host callback for the resulting handle", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const bodyPidReceipt = join(raw.path, "body-pids");
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  mkdirSync(join(world, "plugins"), { recursive: true });
  writeFileSync(
    join(world, "plugins", "fail.mjs"),
    `export default {
    manifest: { id: "fail", apiVersion: 1 },
    activate() { return { signals: { "akuma.outcome-observed": () => { throw new Error("birth observer failed"); } } }; }
  };`,
  );
  writeFileSync(
    join(world, ".keiyaku", "settings.json"),
    JSON.stringify({
      plugins: { fail: { package: "./plugins/fail.mjs" } },
    }),
  );
  const diagnostics: string[] = [];
  const host = {
    reportDiagnostic: (message: string) => {
      diagnostics.push(message);
    },
  };
  let child: PublicAkuma | undefined;
  let operationFailed = true;
  try {
    child = await PublicAkuma.birth("worker", { root: world, cwd: world, ...configured.placement, host });
    host.reportDiagnostic = () => {
      throw new Error("mutated callback must not run");
    };
    const result = await child.ask("answer", { signal: t.signal });
    assert.deepEqual(result.observation, { reason: "answered", answer: '{"ok":true}' });
    await child.history();
    assert.deepEqual(diagnostics, [
      "plugin fail signal: birth observer failed",
      "plugin fail signal: birth observer failed",
    ]);
    await child.kill();
    operationFailed = false;
  } finally {
    await cleanupSpawnCapableFixtureForTest(t, {
      fixturePath: raw.path,
      pidReceiptPath: bodyPidReceipt,
      timeoutMs: 15_000,
      operationFailed,
    });
    restoreBodyPidReceipt();
  }
});

test("schema Akumas.call preserves its child when initial Tell admission fails", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const schema = okSchema();
  const bodyPidReceipt = join(raw.path, "body-pids");
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let akumaId: string | undefined;
  let admissionCalls = 0;
  let operationFailed = true;
  t.mock.method(AkumaOwner.prototype, "admitInitialTell", async function (this: AkumaOwner) {
    admissionCalls += 1;
    return {
      kind: "birth-failed" as const,
      diagnostic: `Akuma ${this.id} prompt-free birth did not settle cleanly`,
    };
  });
  try {
    const result = await Akumas.of(world).call({
      archetype: "worker",
      body: "terminal-birth-schema-call",
      cwd: world,
      ...configured.placement,
      mode: "detach",
      schema,
    });
    akumaId = result.akuma;
    assert.equal(result.observation.kind, "failed");
    if (result.observation.kind === "failed")
      assert.match(result.observation.failure.diagnostic, /did not settle cleanly/u);
    assert.equal(admissionCalls, 1);
    const history = await PublicAkuma.select(world, result.akuma).history();
    assert.equal(history.rows.filter((row) => row.kind === "tell").length, 0);
    operationFailed = false;
  } finally {
    try {
      if (akumaId !== undefined)
        await PublicAkuma.select(world, akumaId)
          .kill()
          .catch(() => undefined);
      await cleanupSpawnCapableFixtureForTest(t, {
        fixturePath: raw.path,
        pidReceiptPath: bodyPidReceipt,
        timeoutMs: 15_000,
        operationFailed,
      });
    } finally {
      restoreBodyPidReceipt();
      restoreSquareLedger();
    }
  }
});

test("ordinary Akumas.call stays bound to its first Turn when a later Turn settles before observation", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const bodyPidReceipt = join(raw.path, "body-pids");
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let observedTellId: string | undefined;
  let operationFailed = true;
  try {
    const result = await Akumas.of(world).call({
      archetype: "worker",
      body: "ordinary-first-input",
      cwd: world,
      ...configured.placement,
      mode: "wait",
      timeoutMs: 10_000,
      observe: {
        admitted: async (tell, id) => {
          observedTellId = tell.admission.tellId;
          const paths = pathsForAkuId(world, id);
          await waitForCondition("the call's admitted Turn to settle", async () => {
            const persisted = await readTell(paths, tell.admission.tellId);
            if (persisted?.binding === undefined) return false;
            return (await readTurn(paths, persisted.binding.turnSequence))?.end !== undefined;
          });
          await waitForCondition("the call Body to release its leash", async () => {
            const available = await HeldAkumaLeash.try(paths);
            if (available === null) return false;
            available.release();
            return true;
          });
          const leash = await HeldAkumaLeash.try(paths);
          if (leash === null) throw new Error("settled call Body did not release its leash");
          try {
            const at = new Date().toISOString();
            const body = await leash.recordBody(paths, { leashTakenAt: at });
            const laterTellId = `${tell.admission.tellId}-later`;
            const laterTell = await recordTell(paths, {
              kind: "tell",
              id: laterTellId,
              body: "later input",
              recordedAt: at,
            });
            assert.equal(laterTell.kind, "recorded");
            const laterTurn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
            await bindTellsToTurn(paths, {
              turnSequence: laterTurn.sequence,
              tellIds: [laterTellId],
              boundAt: at,
            });
            const completedAt = new Date(Date.parse(at) + 1).toISOString();
            await endTurn(paths, {
              turnSequence: laterTurn.sequence,
              outcome: {
                kind: "answered",
                historyId: "later-call-history",
                session: { sessionId: "later-call-session" },
                answer: "later answer",
              },
              completedAt,
            });
            await finishBodyIfIdle(paths, {
              sequence: body.sequence,
              at: new Date(Date.parse(completedAt) + 1).toISOString(),
            });
          } finally {
            leash.release();
          }
        },
      },
    });
    assert.equal(result.structured, undefined);
    assert.deepEqual(result.observation.kind, "observed");
    if (result.observation.kind === "observed") {
      assert.deepEqual(result.observation.observation, { reason: "answered", answer: '{"ok":true}' });
      assert.equal(result.observation.tell.admission.tellId, observedTellId);
    }
    operationFailed = false;
  } finally {
    try {
      await cleanupSpawnCapableFixtureForTest(t, {
        fixturePath: raw.path,
        pidReceiptPath: bodyPidReceipt,
        timeoutMs: 15_000,
        operationFailed,
      });
    } finally {
      restoreBodyPidReceipt();
      restoreSquareLedger();
    }
  }
});

test("Contract association never selects the Akuma execution workdir", async (t) => {
  const { raw, repo, git } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await directArchetypeSettings(world);
  const births = join(world, "births.jsonl");
  mkdirSync(join(world, "plugins"));
  writeFileSync(
    join(world, "plugins", "birth.mjs"),
    `
    import { appendFileSync } from "node:fs";
    export default { manifest: { id: "birth", apiVersion: 1 }, activate(context) {
      return { signals: { "akuma.born": (signal) => appendFileSync(context.config.output, JSON.stringify(signal) + "\\n") } };
    } };
  `,
  );
  writeFileSync(
    join(world, ".keiyaku", "settings.json"),
    JSON.stringify({
      plugins: {
        birth: { package: "./plugins/birth.mjs", config: { output: births } },
      },
    }),
  );
  const bodyPidReceipt = join(raw.path, "body-pids");
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let operationFailed = true;
  let bound: Awaited<ReturnType<ReturnType<typeof Keiyaku.with>["bind"]>> | undefined;
  const environment = { ...process.env };
  for (const key of [
    "KEIYAKU_ACTOR_ID",
    "KEIYAKU_ACTOR_WORLD",
    "KEIYAKU_INITIATOR",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CODEX_THREAD_ID",
    "OPENCODE_SESSION_ID",
    "PI_SESSION_ID",
    "PASEO_AGENT_ID",
  ])
    delete environment[key];
  environment.PI_SESSION_ID = "isolated-call-submitter";
  const submittingOwner = harnessOwner({ channel: "pi", session: "isolated-call-submitter" });
  try {
    bound = await Keiyaku.with().bind({
      repo,
      markdown: contractMarkdown("Akuma execution placement", {
        Context: "A Contract association and a call execution directory are separate inputs.",
        Objective: "Contract association never selects the Akuma execution workdir.",
        Design: "Keep association in Dispatch and placement in the explicit execution directory.",
        Region: "```\nsrc/**\n```",
        Criteria: "### Placement\nThe invocation directory stands without an explicit workdir.",
      }),
      workspace: "worktree",
    });
    const managedId = present(await accepted(bound).value.keiyaku.state()).id;
    const appointment = await readManagedWorktreeAppointment(git, managedId);
    assert.ok(appointment.kind === "appointed", "expected appointment.kind = 'appointed'");
    if (appointment.kind !== "appointed") return;

    const invocationCwd = realpathSync(raw.path);
    const implicit = await cliJson<CallResult>(["-C", ".", "call", "worker", "--contract", managedId, "-"], {
      cwd: raw.path,
      environment: { ...environment, KEIYAKU_HOME: configured.home },
      readStdin: async () => "implicit placement",
    });
    assert.equal(implicit.value.kind, "called");
    assert.deepEqual(implicit.value.execution, { cwd: invocationCwd, source: "input" });
    assert.notEqual(implicit.value.execution.cwd, appointment.path);
    assert.equal(implicit.value.dispatch.kind, "dispatched");
    if (implicit.value.dispatch.kind === "dispatched")
      assert.equal(implicit.value.dispatch.dispatch.contractId, managedId);
    assert.equal((await readSoul(pathsForAkuId(world, implicit.value.akuma)))?.cwd, invocationCwd);
    assert.equal(implicit.value.observation.kind, "detached");
    if (implicit.value.observation.kind === "detached") {
      assert.equal(
        (await readTell(pathsForAkuId(world, implicit.value.akuma), implicit.value.observation.tell.admission.tellId))
          ?.initiator,
        submittingOwner,
      );
    }

    const explicitDir = join(raw.path, "explicit-workdir");
    mkdirSync(explicitDir);
    const explicit = await cliJson<CallResult>(
      ["-C", ".", "call", "worker", "--contract", managedId, "--workdir", "explicit-workdir"],
      {
        cwd: raw.path,
        environment: {
          ...environment,
          KEIYAKU_HOME: configured.home,
          KEIYAKU_ACTOR_ID: "aku/delegator/abcd1234",
          KEIYAKU_ACTOR_WORLD: `${world}/.`,
          KEIYAKU_EXTERNAL_CALLER: "ignored:outer",
          KEIYAKU_INITIATOR: "Submitter",
        },
      },
    );
    assert.equal(explicit.value.kind, "called");
    assert.deepEqual(explicit.value.execution, { cwd: realpathSync(explicitDir), source: "input" });
    assert.equal(explicit.value.dispatch.kind, "dispatched");
    assert.equal(explicit.value.observation.kind, "born");
    await waitForCondition(
      "both direct birth notifications",
      () => existsSync(births) && readFileSync(births, "utf8").trim().split("\n").length === 2,
    );
    const directBirths = readFileSync(births, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(directBirths.find((signal) => signal.akumaId === implicit.value.akuma)?.initiator, submittingOwner);
    assert.deepEqual(
      directBirths.find((signal) => signal.akumaId === explicit.value.akuma),
      {
        kind: "akuma.born",
        akumaId: explicit.value.akuma,
        bodySequence: 1,
        origin: { kind: "direct" },
        caller: { kind: "akuma", world, akuId: "aku/delegator/abcd1234" },
        initiator: "Submitter",
        contractId: managedId,
      },
    );
    operationFailed = false;
  } finally {
    try {
      if (bound !== undefined)
        await accepted(bound)
          .value.keiyaku.abandon({})
          .catch(() => undefined);
      await cleanupSpawnCapableFixtureForTest(t, {
        fixturePath: raw.path,
        pidReceiptPath: bodyPidReceipt,
        timeoutMs: 15_000,
        operationFailed,
      });
    } finally {
      restoreBodyPidReceipt();
      restoreSquareLedger();
    }
  }
});

test("package-root World inputs reject a forged JavaScript coordinate before effects", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-library-world-proof-"));
  const forged = `${root}/.`;
  await assert.rejects(
    Akumas.of(forged as never).call({
      archetype: "worker",
      body: "must not start",
    }),
    /canonical physical directory/u,
  );
  await assert.rejects(
    Akumas.of(forged as never).fork({
      akuma: "aku/worker/1234abcd",
      at: "turn/1",
    }),
    /canonical physical directory/u,
  );
  await assert.rejects(Akumas.of(forged as never).list(), /canonical physical directory/u);
  await assert.rejects(
    Akumas.of(forged as never).status({
      akuma: "aku/worker/1234abcd",
    }),
    /canonical physical directory/u,
  );
  await assert.rejects(
    Akumas.of(forged as never).wait({
      akuma: ["aku/worker/1234abcd"],
      completion: "all",
    }),
    /canonical physical directory/u,
  );
  await assert.rejects(
    Akumas.of(forged as never).tell({
      akuma: "aku/worker/1234abcd",
      body: "must not tell",
    }),
    /canonical physical directory/u,
  );
  await assert.rejects(
    Akumas.of(forged as never).kill({
      akuma: ["aku/worker/1234abcd"],
    }),
    /canonical physical directory/u,
  );
  assert.equal(existsSync(join(root, ".keiyaku", "akuma")), false);
});

test("Archetype base chains refuse missing providers, malformed names, and cycles", async (context) => {
  const home = temporaryDirectory(context, "keiyaku-akuma-archetype-invalid-base-");
  mkdirSync(join(home, "akumas"));
  writeFileSync(join(home, "akumas", "missing.md"), "---\nbase: absent\n---\n");
  writeFileSync(join(home, "akumas", "malformed.md"), "---\nbase: 'bad/name'\n---\n");
  writeFileSync(join(home, "akumas", "a.md"), "---\nbase: b\n---\n");
  writeFileSync(join(home, "akumas", "b.md"), "---\nbase: a\n---\n");
  writeFileSync(join(home, "akumas", "noprov.md"), "---\nbase: empty\n---\n");
  writeFileSync(join(home, "akumas", "empty.md"), "---\n{}\n---\n");
  const settingsValue = await settings({ home });
  await assert.rejects(
    loadPreparedArchetype({ name: "missing", home, settings: settingsValue }),
    (error: unknown) => error instanceof AkumaArchetypeError && error.message.includes("missing -> absent"),
  );
  await assert.rejects(
    loadPreparedArchetype({ name: "malformed", home, settings: settingsValue }),
    (error: unknown) => error instanceof AkumaArchetypeError && error.reason.includes("Akuma name"),
  );
  await assert.rejects(
    loadPreparedArchetype({ name: "a", home, settings: settingsValue }),
    (error: unknown) => error instanceof AkumaArchetypeError && error.message.includes("a -> b -> a"),
  );
  await assert.rejects(
    loadPreparedArchetype({ name: "noprov", home, settings: settingsValue }),
    (error: unknown) => error instanceof AkumaArchetypeError && error.message.includes("provider must be"),
  );
});

// Decode at the owner boundary: bad configuration does not need Git, a Body, or a provider process.
test("retired caller fields refuse before allocation", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-retired-call-input-");
  const world = await World.at(root);
  const runtime = Akumas.of(world);
  await assert.rejects(
    runtime.call({ archetype: "worker", allowed: [] } as never),
    /Akumas.call input has unknown field: allowed/u,
  );
  await assert.rejects(
    PublicAkuma.birth("worker", { root: world, allowed: [] } as never),
    /Akuma birth input has unknown field: allowed/u,
  );
  await assert.rejects(
    runtime.fork({ akuma: "aku/worker/1234abcd", at: "turn/1", allowed: [] } as never),
    /Akumas.fork input has unknown field: allowed/u,
  );
  assert.deepEqual((await runtime.list()).rows, []);
});

// The initiating local call must keep its Archetype-classified refusal even though
// the shared prepared-call executor performs provider admission.
test("a local call reports unsupported Archetype options as an Archetype failure before allocation", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-local-unsupported-option-");
  const home = join(root, "home");
  mkdirSync(join(home, "akumas"), { recursive: true });
  const value = await settings({ root, home });
  const archetypePath = join(home, "akumas", "greedy.md");
  writeFileSync(archetypePath, "---\nprovider: claude\nnetwork: enabled\n---\nWork.\n");
  await assert.rejects(
    Akumas.of(await World.at(root)).call({ archetype: "greedy", body: "hello", home, settings: value }),
    (error: unknown) =>
      error instanceof AkumaArchetypeError &&
      error.archetype === "greedy" &&
      error.searched.join("\n") === archetypePath &&
      error.reason === "is unsupported: Claude provider does not support the network option",
  );
  assert.equal(existsSync(join(root, ".keiyaku", "akuma", "run")), false);
});
