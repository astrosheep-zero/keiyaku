import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { DeliveryLedger, harnessOwner, isCardPresentation } from "@astrosheep/square";
import "./support/local-public-package.js";
import { World } from "../src/world.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
const { default: squarePlugin } = await import("../plugins/square/index.js");
import type { WorldRoot } from "../src/world.js";
import { deferred, restoreEnvironmentValues } from "./support/process.js";

const identityNames = [
  "PI_SESSION_ID",
  "CODEX_THREAD_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "OPENCODE_SESSION_ID",
  "PASEO_AGENT_ID",
  "KEIYAKU_INITIATOR",
  "SQUARE_DELIVERY",
  "SQUARE_NOTIFY_DELIVERY_WAIT_MS",
] as const;

async function fixture(t: TestContext, artifact = true) {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-ledger-")));
  const prior = Object.fromEntries(identityNames.map((name) => [name, process.env[name]]));
  for (const name of identityNames) delete process.env[name];
  process.env.PI_SESSION_ID = "requester";
  process.env.SQUARE_DELIVERY = join(root, "delivery.sqlite");
  const path = join(root, ".square", "KEIYAKU.square");
  const bytes = Buffer.from("arbitrary historical artifact\u0000\xff");
  if (artifact) {
    mkdirSync(join(root, ".square"));
    writeFileSync(path, bytes);
  }
  const alice = harnessOwner({ channel: "pi", session: "requester" });
  const bob = harnessOwner({ channel: "pi", session: "peer" });
  const ledger = await DeliveryLedger.open({ location: process.env.SQUARE_DELIVERY, clock: () => Date.now() });
  for (const owner of [alice, bob]) assert.ok(await ledger.attach({ owner, expectedGeneration: null, routes: [] }));
  const activate = () =>
    squarePlugin.activate({
      world: root as WorldRoot,
      config: undefined,
      writablePath: () => assert.fail("direct producer requires no World writable capability"),
    });
  const plugin = await activate();
  t.after(async () => {
    await ledger.close();
    if (artifact) assert.deepEqual(readFileSync(path), bytes);
    else assert.equal(existsSync(join(root, ".square")), false);
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  });
  const cards = async (owner = alice) => {
    const session = await ledger.session(owner);
    assert.ok(session);
    return await ledger.pending(owner, { generation: session.generation });
  };
  const turn = async (id: string, sequence: number, participants: readonly string[] = [alice]) => {
    await plugin.signals!["akuma.turn-outcome"]!({
      kind: "akuma.turn-outcome",
      akumaId: id,
      bodySequence: 1,
      turnSequence: sequence,
      participants,
      outcome: { kind: "answered", text: `answer ${id} ${sequence}` },
    });
  };
  const observe = async (id: string, sequence: number, observer?: string) => {
    await plugin.signals!["akuma.outcome-observed"]!({
      kind: "akuma.outcome-observed",
      akumaId: id,
      historyId: `turn/${sequence}`,
      ...(observer === undefined ? {} : { observer }),
    });
  };
  return { root, path, ledger, plugin, alice, bob, activate, cards, turn, observe };
}
const key = (id: string, ref: string) => `keiyaku/${id}/${ref}`;

test("Square loads the public composition only for an addressed notice, using Node's module cache", async (t) => {
  const f = await fixture(t);
  const entry = new URL(import.meta.url.endsWith(".js") ? "../../build/src/index.js" : "../build/src/index.js", import.meta.url).href;
  const plugin = new URL("../plugins/square/index.js", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const entry = ${JSON.stringify(entry)};
    let rootLoads = 0;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        return specifier === '@astrosheep/keiyaku' ? { url: entry, shortCircuit: true } : nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        if (url === entry) rootLoads++;
        return nextLoad(url, context);
      },
    });
    const { default: plugin } = await import(${JSON.stringify(plugin)});
    const instance = await plugin.activate({ world: ${JSON.stringify(f.root)}, config: undefined,
      writablePath() { throw Error('no storage'); } });
    await instance.signals['akuma.born']?.({ kind: 'akuma.born', akumaId: 'aku/worker/1234abcd', bodySequence: 1,
      origin: { kind: 'direct' }, caller: { kind: 'unknown' } });
    const outcome = { kind: 'akuma.turn-outcome', akumaId: 'aku/worker/1234abcd', bodySequence: 1,
      turnSequence: 1, outcome: { kind: 'answered', text: 'done' } };
    await instance.signals['akuma.turn-outcome']({ ...outcome, participants: [] });
    assert.equal(rootLoads, 0, 'activation, birth and unaddressed notices must not load the public root');
    await instance.signals['akuma.turn-outcome']({ ...outcome, participants: [${JSON.stringify(f.alice)}] });
    await instance.signals['akuma.turn-outcome']({ ...outcome, turnSequence: 2, participants: [${JSON.stringify(f.alice)}] });
    assert.equal(rootLoads, 1, 'addressed notices load the actual public entry once through Node');
  `], { encoding: "utf8" });
  assert.equal((await f.cards()).length, 2);
});

test("direct cards preserve exact full content, frozen Owners and generic presentation without artifacts", async (t) => {
  const f = await fixture(t, false);
  await f.plugin.signals!["akuma.born"]?.({
    kind: "akuma.born",
    akumaId: "aku/forms/1234abcd",
    bodySequence: 1,
    origin: { kind: "direct" },
    caller: { kind: "unknown" },
    initiator: f.alice,
  });
  await f.plugin.signals!["akuma.turn-outcome"]!({
    kind: "akuma.turn-outcome",
    akumaId: "aku/forms/1234abcd",
    bodySequence: 1,
    turnSequence: 9,
    outcome: { kind: "answered", text: "silent" },
  });
  assert.deepEqual(await f.cards(), []);
  const answer = "full answer\n".repeat(2000);
  for (const [turnSequence, outcome] of [
    [1, { kind: "answered", text: answer }],
    [2, { kind: "failed", reason: "failure detail" }],
    [3, { kind: "canceled" }],
  ] as const) {
    await f.plugin.signals!["akuma.turn-outcome"]!({
      kind: "akuma.turn-outcome",
      akumaId: "aku/forms/1234abcd",
      bodySequence: 1,
      turnSequence,
      participants: [f.alice, f.bob, f.alice],
      initiator: f.bob,
      ...(turnSequence === 2 ? {} : { contractId: "kei/example" }),
      outcome,
    });
  }
  const rows = await f.cards();
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.text),
    [
      `\`aku/forms/1234abcd\` ✓ done\n${answer}\n\n---\n\n\`turn/1\` · \`kei/example\``,
      "`aku/forms/1234abcd` × failed\nfailure detail\n\n---\n\n`turn/2`",
      "`aku/forms/1234abcd` ○ canceled\n\n---\n\n`turn/3` · `kei/example`",
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.key),
    [1, 2, 3].map((n) => key("aku/forms/1234abcd", `turn/${n}`)),
  );
  for (const row of rows) {
    assert.ok(isCardPresentation(row.details));
    assert.deepEqual(row.details, {
      kind: "presentation",
      origin: "Keiyaku",
      author: "aku/forms/1234abcd",
      ref: row.key.split("/").slice(-2).join("/"),
      body: row.text,
    });
  }
  assert.deepEqual(
    (await f.cards(f.bob)).map((card) => card.text),
    rows.map((card) => card.text),
  );
  await f.turn("aku/repeat/1234abcd", 1);
  await f.turn("aku/repeat/1234abcd", 1);
  assert.equal((await f.cards()).filter((card) => card.key === key("aku/repeat/1234abcd", "turn/1")).length, 1);
});

test("alias-first card snapshots keep identity keys and do not follow later alias moves", async (t) => {
  const f = await fixture(t);
  const id = parseAkumaId("aku/worker/1234abcd").id;
  const other = parseAkumaId("aku/worker/8765abcd").id;
  const bind = (name: string, akumaId = id) => moveAlias({ world: f.root, alias: parseAkumaAlias(`@${name}`), akumaId });
  await bind("reviewer");
  await f.plugin.signals!["akuma.reported"]!({ kind: "akuma.reported", akumaId: id, bodySequence: 1,
    turnSequence: 1, reportSequence: 1, text: "progress", at: "2026-11-09T00:00:00Z", initiator: f.alice });
  await bind("audit");
  await f.turn(id, 1, [f.alice, f.bob]);
  await f.plugin.signals!["akuma.body-ended"]!({ kind: "akuma.body-ended", akumaId: id, bodySequence: 1,
    end: "broke-off", participants: [f.alice] });
  const before = await f.cards();
  assert.deepEqual(before.map(card => card.key), [key(id, "report/1"), key(id, "turn/1"), key(id, "body/1")]);
  for (const [index, card] of before.entries()) {
    const label = index === 0 ? "@reviewer" : "@audit, @reviewer";
    assert.ok(isCardPresentation(card.details));
    assert.equal(card.details.author, label);
    assert.ok(card.text.startsWith(`\`${label}\``));
    assert.ok(card.text.split("---\n\n")[1]?.includes(`\`${id}\``));
    assert.equal(card.details.body, card.text);
  }
  assert.equal((await f.cards(f.bob))[0]?.text, before[1]?.text);
  await bind("reviewer", other); await bind("audit", other);
  await f.turn(id, 2);
  await f.turn(other, 1);
  const after = await f.cards();
  assert.deepEqual(after.slice(0, 3), before, "published cards keep their event-time label");
  assert.ok(after[3]?.text.startsWith(`\`${id}\``));
  assert.ok(after[4]?.text.startsWith("`@audit, @reviewer`"));
  await f.observe(id, 1);
  assert.equal((await f.cards()).some(card => card.key === key(id, "turn/1")), false);
  assert.equal((await f.cards(f.bob))[0]?.key, key(id, "turn/1"), "alias moves do not change exact Owner suppression");
});

test("alias corruption diagnoses only addressed notices and still posts a bare identity card", async (t) => {
  const f = await fixture(t);
  const id = "aku/worker/1234abcd";
  mkdirSync(join(f.root, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(f.root, ".keiyaku", "akuma", "alias.json"), "corrupt\n");
  const warnings = t.mock.method(console, "warn", () => {});
  await f.turn(id, 1, []);
  assert.equal(warnings.mock.callCount(), 0, "unaddressed notices do not read aliases");
  await f.turn(id, 2);
  assert.equal(warnings.mock.callCount(), 1);
  assert.match(String(warnings.mock.calls[0]?.arguments[0]), /notice alias lookup failed/u);
  const [card] = await f.cards();
  assert.ok(card && isCardPresentation(card.details));
  assert.equal(card.key, key(id, "turn/2"));
  assert.equal(card.details.author, id);
  assert.ok(card.text.startsWith(`\`${id}\``));
});

test("early and late exact suppression survive producer restart and remain Owner/event specific", async (t) => {
  const f = await fixture(t);
  await f.observe("aku/early/1234abcd", 1);
  const reopened = await f.activate();
  await reopened.signals!["akuma.turn-outcome"]!({
    kind: "akuma.turn-outcome",
    akumaId: "aku/early/1234abcd",
    bodySequence: 1,
    turnSequence: 1,
    participants: [f.alice, f.bob],
    outcome: { kind: "answered", text: "exact" },
  });
  assert.equal((await f.cards()).length, 0);
  assert.equal((await f.cards(f.bob)).length, 1);
  await f.turn("aku/early/1234abcd", 2);
  const report = "progress\n".repeat(2000);
  await f.plugin.signals!["akuma.reported"]!({
    kind: "akuma.reported",
    akumaId: "aku/early/1234abcd",
    bodySequence: 1,
    turnSequence: 1,
    reportSequence: 1,
    text: report,
    at: "2026-11-04T00:00:00Z",
    initiator: f.alice,
  });
  const reportCard = (await f.cards()).find((card) => card.key === key("aku/early/1234abcd", "report/1"));
  assert.ok(reportCard);
  assert.equal(reportCard.text, `\`aku/early/1234abcd\` ▸ update\n${report}\n\n---\n\n\`report/1\``);
  assert.deepEqual(reportCard.details, {
    kind: "presentation",
    origin: "Keiyaku",
    author: "aku/early/1234abcd",
    ref: "report/1",
    body: reportCard.text,
  });
  assert.equal((await f.cards(f.bob)).some((card) => card.key === reportCard.key), false);
  assert.equal((await f.cards()).length, 2);
  await f.observe("aku/early/1234abcd", 2);
  assert.deepEqual(
    (await f.cards()).map((card) => card.key),
    [key("aku/early/1234abcd", "report/1")],
  );
  const later = Date.now() + 365 * 24 * 60 * 60_000;
  t.mock.method(Date, "now", () => later);
  await f.turn("aku/early/1234abcd", 1);
  assert.deepEqual(
    (await f.cards()).map((card) => card.key),
    [key("aku/early/1234abcd", "report/1")],
  );
});

test("overlapping prefix scopes release independently; exact observation survives both releases", async (t) => {
  const f = await fixture(t);
  const first = await f.plugin.waitDeferral!({ akumaIds: ["aku/scoped/1234abcd"] });
  const second = await f.plugin.waitDeferral!({ akumaIds: ["aku/scoped/1234abcd"] });
  assert.ok(first && second);
  try {
    await f.turn("aku/scoped/1234abcd", 1, [f.alice, f.bob]);
    await f.turn("aku/scoped/1234abcd", 2);
    await f.turn("aku/other/1234abcd", 1);
    await f.plugin.signals!["akuma.reported"]!({
      kind: "akuma.reported",
      akumaId: "aku/scoped/1234abcd",
      bodySequence: 1,
      turnSequence: 1,
      reportSequence: 1,
      text: "progress",
      at: "2026-11-04T00:00:00Z",
      initiator: f.alice,
    });
    assert.deepEqual(
      (await f.cards()).map((card) => card.key),
      [key("aku/other/1234abcd", "turn/1"), key("aku/scoped/1234abcd", "report/1")],
    );
    assert.equal((await f.cards(f.bob)).length, 1);
    await first.close();
    assert.equal((await f.cards()).length, 2);
    await f.observe("aku/scoped/1234abcd", 1);
    await second.close();
    assert.deepEqual(
      (await f.cards()).map((card) => card.key),
      [key("aku/scoped/1234abcd", "turn/2"), key("aku/other/1234abcd", "turn/1"), key("aku/scoped/1234abcd", "report/1")],
    );
  } finally {
    await first.close();
    await second.close();
  }
});

test("unobserved timeout release and TTL expiry make retained outcomes eligible", async (t) => {
  const f = await fixture(t);
  const scope = await f.plugin.waitDeferral!({ akumaIds: ["aku/expires/1234abcd"] });
  assert.ok(scope);
  t.after(async () => {
    await scope.close();
  });
  await f.turn("aku/expires/1234abcd", 1);
  assert.deepEqual(await f.cards(), []);
  const later = Date.now() + 6 * 60_000;
  t.mock.method(Date, "now", () => later);
  assert.equal((await f.cards()).length, 1);
  await scope.close();
  const other = await f.plugin.waitDeferral!({ akumaIds: ["aku/released/1234abcd"] });
  assert.ok(other);
  await f.turn("aku/released/1234abcd", 1);
  assert.equal((await f.cards()).length, 1);
  await other.close();
  assert.equal((await f.cards()).length, 2);
});

test("partial acquisition cleans late allocated suppression when its peer fails", async (t) => {
  const f = await fixture(t);
  const suppress = DeliveryLedger.prototype.suppress;
  const release = DeliveryLedger.prototype.releaseSuppression;
  const late = deferred<void>();
  const failed = deferred<void>();
  const released: string[] = [];
  const lateReleased = deferred<void>();
  let allocated: string | undefined;
  let count = 0;
  t.mock.method(
    DeliveryLedger.prototype,
    "suppress",
    async function (this: DeliveryLedger, ...args: Parameters<DeliveryLedger["suppress"]>) {
      if (++count === 2) {
        failed.resolve();
        throw new Error("acquisition failed");
      }
      await late.promise;
      const result = await suppress.apply(this, args);
      allocated = result.id;
      return result;
    },
  );
  t.mock.method(
    DeliveryLedger.prototype,
    "releaseSuppression",
    async function (this: DeliveryLedger, ...args: Parameters<DeliveryLedger["releaseSuppression"]>) {
      released.push(args[0].id);
      const result = await release.apply(this, args);
      lateReleased.resolve();
      return result;
    },
  );
  const result = assert.rejects(
    Promise.resolve(f.plugin.waitDeferral!({ akumaIds: ["aku/one/1234abcd", "aku/two/1234abcd"] })),
    /acquisition failed/u,
  );
  await failed.promise;
  await result;
  assert.deepEqual(released, [], "failure returns before an unrelated acquisition settles");
  late.resolve();
  await lateReleased.promise;
  assert.ok(allocated);
  assert.deepEqual(released, [allocated]);
  await f.turn("aku/one/1234abcd", 1);
  assert.equal((await f.cards()).length, 1);
});

test("cancellation after late acquisition releases only its own suppression", async (t) => {
  const f = await fixture(t);
  const external = await f.ledger.suppress({ owner: f.alice, key: key("aku/external/1234abcd", "turn/"), scope: "prefix" });
  const suppress = DeliveryLedger.prototype.suppress;
  const entered = deferred<void>();
  const late = deferred<void>();
  t.mock.method(
    DeliveryLedger.prototype,
    "suppress",
    async function (this: DeliveryLedger, ...args: Parameters<DeliveryLedger["suppress"]>) {
      entered.resolve();
      await late.promise;
      return await suppress.apply(this, args);
    },
  );
  const controller = new AbortController();
  const pending = assert.rejects(
    Promise.resolve(f.plugin.waitDeferral!({ akumaIds: ["aku/cancel/1234abcd"] }, controller.signal)),
    /canceled/u,
  );
  await entered.promise;
  controller.abort(new Error("canceled"));
  late.resolve();
  await pending;
  await f.turn("aku/cancel/1234abcd", 1);
  await f.turn("aku/external/1234abcd", 1);
  assert.deepEqual(
    (await f.cards()).map((card) => card.key),
    [key("aku/cancel/1234abcd", "turn/1")],
  );
  await f.ledger.releaseSuppression({ owner: f.alice, id: external.id });
});

test("lost renewal is diagnostic and never resurrects the expired id", async (t) => {
  const f = await fixture(t);
  const suppress = DeliveryLedger.prototype.suppress;
  const renew = DeliveryLedger.prototype.renewSuppression;
  const allocated: string[] = [];
  const renewed: string[] = [];
  const first = deferred<void>();
  const second = deferred<void>();
  t.mock.method(
    DeliveryLedger.prototype,
    "suppress",
    async function (this: DeliveryLedger, ...args: Parameters<DeliveryLedger["suppress"]>) {
      const result = await suppress.apply(this, args);
      allocated.push(result.id);
      return result;
    },
  );
  t.mock.method(
    DeliveryLedger.prototype,
    "renewSuppression",
    async function (this: DeliveryLedger, input: Parameters<DeliveryLedger["renewSuppression"]>[0]) {
      renewed.push(input.id);
      if (input.id === allocated[0]) {
        await this.releaseSuppression(input);
        return false;
      }
      const result = await renew.call(this, input);
      if (renewed.length === 2) first.resolve();
      if (renewed.length === 3) second.resolve();
      return result;
    },
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = await f.plugin.waitDeferral!({ akumaIds: ["aku/lost/1234abcd", "aku/live/1234abcd"] });
  assert.ok(scope);
  t.mock.timers.tick(120_000);
  await first.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(120_000);
  await second.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(renewed, [allocated[0], allocated[1], allocated[1]]);
  await assert.rejects(Promise.resolve(scope.close()), /expired before renewal/u);
  await f.turn("aku/live/1234abcd", 1);
  assert.equal((await f.cards()).length, 1);
});

test("Body dedup tracks committed recipients independently and reports retain exact opening Owner", async (t) => {
  const f = await fixture(t);
  const post = DeliveryLedger.prototype.post;
  const fault = t.mock.method(
    DeliveryLedger.prototype,
    "post",
    async function (this: DeliveryLedger, input: Parameters<DeliveryLedger["post"]>[0]) {
      if (input.owner === f.bob && input.key.endsWith("turn/1")) throw new Error("post failed");
      return await post.call(this, input);
    },
  );
  await assert.rejects(
    Promise.resolve(
      f.plugin.signals!["akuma.turn-outcome"]!({
        kind: "akuma.turn-outcome",
        akumaId: "aku/body/1234abcd",
        bodySequence: 1,
        turnSequence: 1,
        participants: [f.alice, f.bob],
        outcome: { kind: "failed", reason: "failed" },
      }),
    ),
    /post failed/u,
  );
  fault.mock.restore();
  await f.plugin.signals!["akuma.body-ended"]!({
    kind: "akuma.body-ended",
    akumaId: "aku/body/1234abcd",
    bodySequence: 1,
    end: "hung",
    participants: [f.alice, f.bob],
  });
  assert.deepEqual(
    (await f.cards()).map((card) => card.key),
    [key("aku/body/1234abcd", "turn/1")],
  );
  assert.deepEqual(
    (await f.cards(f.bob)).map((card) => card.key),
    [key("aku/body/1234abcd", "body/1")],
  );
  await f.plugin.signals!["akuma.reported"]!({
    kind: "akuma.reported",
    akumaId: "aku/body/1234abcd",
    bodySequence: 1,
    turnSequence: 1,
    reportSequence: 1,
    text: "report",
    at: "2026-11-04T00:00:00Z",
    initiator: f.bob,
  });
  assert.equal((await f.cards(f.bob)).length, 2);
  assert.equal((await f.cards()).length, 1);
});

test("Claude child markers preserve explicit native identity but not child-only fallback", async (t) => {
  const f = await fixture(t);
  delete process.env.PI_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = "claude-requester";
  process.env.CLAUDE_CODE_CHILD_SESSION = "1";
  process.env.PASEO_AGENT_ID = "fallback";
  const native = harnessOwner({ channel: "claude-code", session: "claude-requester" });
  assert.ok(await f.ledger.attach({ owner: native, expectedGeneration: null, routes: [] }));
  const plugin = await f.activate();
  await plugin.signals!["akuma.outcome-observed"]!({
    kind: "akuma.outcome-observed",
    akumaId: "aku/native/1234abcd",
    historyId: "turn/1",
  });
  await plugin.signals!["akuma.turn-outcome"]!({
    kind: "akuma.turn-outcome",
    akumaId: "aku/native/1234abcd",
    bodySequence: 1,
    turnSequence: 1,
    participants: [native],
    outcome: { kind: "answered", text: "observed" },
  });
  assert.deepEqual(await f.cards(native), []);

  delete process.env.CLAUDE_CODE_SESSION_ID;
  const childOnly = await f.activate();
  assert.equal(await childOnly.waitDeferral!({ akumaIds: ["aku/native/1234abcd"] }), undefined);
});

test("explicit opaque observer overrides local identity while another Owner stays independent", async (t) => {
  const f = await fixture(t);
  const opaque = "integration-owned-opaque-value" as typeof f.alice;
  assert.ok(await f.ledger.attach({ owner: opaque, expectedGeneration: null, routes: [] }));
  await f.observe("aku/opaque/1234abcd", 1, opaque);
  await f.turn("aku/opaque/1234abcd", 1, [opaque, f.alice]);
  assert.equal((await f.cards(opaque)).length, 0);
  assert.equal((await f.cards()).length, 1);
  await f.plugin.signals!["akuma.outcome-observed"]!({
    kind: "akuma.outcome-observed",
    akumaId: "aku/opaque/1234abcd",
    historyId: "body/1",
  });
  assert.equal((await f.cards()).length, 1);
});

test("unknown and deleted sessions remain undeliverable without registration", async (t) => {
  const f = await fixture(t);
  const unknown = harnessOwner({ channel: "pi", session: "unknown" });
  const session = await f.ledger.session(f.bob);
  assert.ok(session);
  await f.ledger.markDeleted({ owner: f.bob, generation: session.generation });
  await f.turn("aku/missing/1234abcd", 1, [unknown, f.bob]);
  assert.equal(await f.ledger.session(unknown), undefined);
  assert.equal((await f.ledger.session(f.bob))?.state, "deleted");
  assert.deepEqual(await f.cards(), []);
});

test("native non-Codex push honors prefix release and accepted custody cannot be recalled", async (t) => {
  const f = await fixture(t);
  const session = await f.ledger.session(f.alice);
  assert.ok(session);
  const delivered: string[] = [];
  const receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    delivered.push((JSON.parse(Buffer.concat(chunks).toString()) as { key: string }).key);
    response.writeHead(202).end();
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    receiver.closeAllConnections();
    await new Promise<void>((resolve, reject) => receiver.close((error) => (error ? reject(error) : resolve())));
  });
  const address = receiver.address();
  assert.ok(address && typeof address !== "string");
  await f.ledger.updateRoutes({
    owner: f.alice,
    generation: session.generation,
    routes: [{ kind: "http", address: { url: `http://127.0.0.1:${address.port}/` } }],
  });
  const scope = await f.plugin.waitDeferral!({ akumaIds: ["aku/push/1234abcd"] });
  assert.ok(scope);
  await f.turn("aku/push/1234abcd", 1);
  assert.deepEqual(delivered, []);
  await scope.close();
  assert.deepEqual(delivered, [key("aku/push/1234abcd", "turn/1")]);
  await f.observe("aku/push/1234abcd", 1);
  await f.turn("aku/push/1234abcd", 1);
  assert.equal(delivered.length, 1);
  const handoffs = await f.ledger.handoffs(f.alice, { generation: session.generation });
  assert.ok(handoffs.some((attempt) => attempt.outcome === "accepted"));
});

test("scope cleanup is bounded while late renewal and release retain their ledger until settlement", async (t) => {
  const f = await fixture(t);
  const renew = DeliveryLedger.prototype.renewSuppression;
  const release = DeliveryLedger.prototype.releaseSuppression;
  const close = DeliveryLedger.prototype.close;
  const renewing = deferred<void>();
  const renewalGate = deferred<void>();
  const releasing = deferred<void>();
  const releaseGate = deferred<void>();
  const released = deferred<void>();
  const closed = deferred<void>();
  let scopeLedger: DeliveryLedger | undefined;
  let retired = false;
  t.mock.method(
    DeliveryLedger.prototype,
    "renewSuppression",
    async function (this: DeliveryLedger, input: Parameters<DeliveryLedger["renewSuppression"]>[0]) {
      scopeLedger = this;
      renewing.resolve();
      await renewalGate.promise;
      return await renew.call(this, input);
    },
  );
  t.mock.method(
    DeliveryLedger.prototype,
    "releaseSuppression",
    async function (this: DeliveryLedger, input: Parameters<DeliveryLedger["releaseSuppression"]>[0]) {
      releasing.resolve();
      await releaseGate.promise;
      const result = await release.call(this, input);
      released.resolve();
      return result;
    },
  );
  t.mock.method(DeliveryLedger.prototype, "close", async function (this: DeliveryLedger) {
    await close.call(this);
    if (this === scopeLedger) {
      retired = true;
      closed.resolve();
    }
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = await f.plugin.waitDeferral!({ akumaIds: ["aku/late-cleanup/1234abcd"] });
  assert.ok(scope);
  t.mock.timers.tick(120_000);
  await renewing.promise;
  const cancellation = new AbortController();
  const cleanup = assert.rejects(Promise.resolve(scope.close(cancellation.signal)), /cleanup expired/u);
  cancellation.abort(new Error("cleanup expired"));
  await cleanup;
  await releasing.promise;
  assert.equal(retired, false, "late resource operations still own the connection");
  releaseGate.resolve();
  await released.promise;
  assert.equal(retired, false, "release cannot retire a pending renewal");
  renewalGate.resolve();
  await closed.promise;
  await f.turn("aku/late-cleanup/1234abcd", 1);
  assert.equal((await f.cards()).length, 1, "late renewal did not recreate released suppression");
});

test("a native receiver claims full text and receipts prevent idempotent replay", async (t) => {
  const f = await fixture(t);
  await f.turn("aku/receiver/1234abcd", 1);
  const session = await f.ledger.session(f.alice);
  assert.ok(session);
  const claim = await f.ledger.claimPresentation(f.alice, { generation: session.generation, budgetChars: 100_000 });
  assert.ok(claim);
  assert.equal(await claim.current(), true);
  assert.equal(claim.cards[0]?.key, key("aku/receiver/1234abcd", "turn/1"));
  assert.ok(claim.cards[0]?.text.includes("answer aku/receiver/1234abcd 1"));
  assert.equal(await claim.settle("presented"), true);
  assert.deepEqual(
    (await f.ledger.receipts(f.alice)).map((receipt) => receipt.key),
    [key("aku/receiver/1234abcd", "turn/1")],
  );
  await f.turn("aku/receiver/1234abcd", 1);
  assert.deepEqual(await f.cards(), []);
});

test("unknown handoff retains producer connection until late accepted settlement without recall", async (t) => {
  const f = await fixture(t);
  process.env.SQUARE_NOTIFY_DELIVERY_WAIT_MS = "10";
  const plugin = await f.activate();
  const session = await f.ledger.session(f.alice);
  assert.ok(session);
  await f.ledger.updateRoutes({
    owner: f.alice,
    generation: session.generation,
    routes: [{ kind: "http", address: { url: "http://isolated-fake.invalid/" } }],
  });
  const accepted = deferred<void>();
  const closed = deferred<void>();
  const dispatch = DeliveryLedger.prototype.dispatchHandoff;
  const close = DeliveryLedger.prototype.close;
  let producer: DeliveryLedger | undefined;
  let retired = false;
  let sent = 0;
  let lateSettlement: ReturnType<DeliveryLedger["dispatchHandoff"]> | undefined;
  t.mock.method(
    DeliveryLedger.prototype,
    "dispatchHandoff",
    async function (this: DeliveryLedger, ...args: Parameters<DeliveryLedger["dispatchHandoff"]>) {
      producer = this;
      const result = dispatch.call(
        this,
        args[0],
        args[1],
        {
          kind: "http",
          async send(_card, _address, context) {
            assert.equal(await context.beforeSend(), true);
            sent += 1;
            await accepted.promise;
            return "accepted";
          },
        },
        args[3],
      );
      lateSettlement = result;
      return await result;
    },
  );
  t.mock.method(DeliveryLedger.prototype, "close", async function (this: DeliveryLedger) {
    await close.call(this);
    if (this === producer) {
      retired = true;
      closed.resolve();
    }
  });
  const signal = {
    kind: "akuma.turn-outcome" as const,
    akumaId: "aku/late/1234abcd",
    bodySequence: 1,
    turnSequence: 1,
    participants: [f.alice],
    outcome: { kind: "answered" as const, text: "late result" },
  };
  await plugin.signals!["akuma.turn-outcome"]!(signal);
  assert.equal(retired, false);
  assert.equal((await f.ledger.handoffs(f.alice, { generation: session.generation }))[0]?.outcome, "unknown");
  await f.observe("aku/late/1234abcd", 1);
  const result = await lateSettlement;
  assert.ok(result?.lateSettlement);
  accepted.resolve();
  assert.deepEqual(await result.lateSettlement, { outcome: "accepted", persistence: { status: "recorded" } });
  await closed.promise;
  assert.equal((await f.ledger.handoffs(f.alice, { generation: session.generation }))[0]?.outcome, "accepted");
  await plugin.signals!["akuma.turn-outcome"]!(signal);
  assert.equal(sent, 1, "exact observation and repeat posting never recall or repeat accepted custody");
});
