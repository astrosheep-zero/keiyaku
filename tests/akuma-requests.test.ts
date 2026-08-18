import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Akuma } from "../src/akuma/akuma.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import {
  HeldAkumaLeash,
  admitRequest,
  initializeHeart,
  readRequest,
  readSeal,
  readSoul,
  reserveRequest,
  type Soul,
} from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory, pathsForAkuId } from "../src/akuma/identity.js";
import { BIRTH_TIMEOUT_MS, publishAkuma } from "../src/akuma/publication.js";
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";
import {
  AkumaBodyRequestError,
  BodyRequestPump,
  requestBodyCall,
  settleBodyRequests,
} from "../src/akuma/requests.js";
import { Keiyaku, Repo } from "../src/index.js";
import { World } from "../src/world.js";
import { makeGitRepository } from "./support/git.js";

async function akumaAt(root: string) { return Akuma.of(await World.at(root)); }

test("ordinary Akuma birth allows 30 seconds", () => {
  assert.equal(BIRTH_TIMEOUT_MS, 30_000);
});

async function fixture(allowed?: Soul["allowed"]) {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-akuma-requests-")));
  const parent = await allocateAkumaDirectory({ worldRoot: root, archetype: "parent", draw: () => "1234abcd" });
  await initializeHeart(parent.paths);
  const soul: Soul = {
    id: parent.id,
    archetype: "parent",
    provider: { name: "codex-app-server", kind: "codex-app-server" },
    options: { readonly: true },
    readonly: { enforcement: "native" },
    cwd: root,
    origin: { kind: "direct" },
    allowed: allowed ?? ALLOWED_ACTIONS,
    createdAt: "2026-08-09T00:00:00.000Z",
  };
  const leash = (await HeldAkumaLeash.try(parent.paths))!;
  await leash.birth(parent.paths, soul);
  return { root, parent, soul, leash, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("aborted publication keeps an in-flight launch lexically owned", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-akuma-publication-abort-")));
  const controller = new AbortController();
  let started!: () => void;
  const launchStarted = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const launchGate = new Promise<void>((resolve) => { release = resolve; });
  let childPaths: Awaited<ReturnType<typeof allocateAkumaDirectory>>["paths"] | undefined;
  try {
    const publication = publishAkuma({
      worldPath: root,
      archetype: "worker",
      signal: controller.signal,
      async launch(allocated) {
        childPaths = allocated.paths;
        started();
        await launchGate;
      },
    });
    await launchStarted;
    let settled = false;
    void publication.finally(() => { settled = true; }).catch(() => {});
    controller.abort(new Error("cancelled publication"));
    await Promise.resolve();
    assert.equal(settled, false);
    release();
    await assert.rejects(publication, /cancelled publication/u);
    assert.equal(settled, true);
    assert.equal(childPaths === undefined ? null : (await readSeal(childPaths))?.evidence, "cancelled publication");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Heart clips nested allowed at each direct parent and cannot regain removed actions", async () => {
  const value = await fixture(["akuma.call", "task.add"]);
  const previousRequests = process.env[AKUMA_REQUESTS_ENV];
  const previousHome = process.env.HOME;
  const home = join(value.root, "home");
  mkdirSync(join(home, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(home, ".keiyaku", "akuma", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  process.env.HOME = home;
  const first = await BodyRequestPump.open({
    paths: value.parent.paths,
    parent: value.soul,
    bodySequence: 1,
    now: () => "2026-08-09T00:00:01.000Z",
    signal: new AbortController().signal,
    async spawn(launch) {
      const leash = (await HeldAkumaLeash.try(launch.paths))!;
      await leash.birth(launch.paths, { ...launch.seed, createdAt: "2026-08-09T00:00:02.000Z" });
      leash.release();
    },
  });
  try {
    process.env[AKUMA_REQUESTS_ENV] = first.directory;
    const child = await (await akumaAt(value.root)).call({
      archetype: "worker",
      body: "child",
      allowed: ["akuma.call"],
    });
    const childSoul = (await readSoul(pathsForAkuId(value.root, child.id)))!;
    assert.deepEqual(childSoul.allowed, ["akuma.call"]);

    const childPaths = pathsForAkuId(value.root, child.id);
    const second = await BodyRequestPump.open({
      paths: childPaths,
      parent: childSoul,
      bodySequence: 1,
      now: () => "2026-08-09T00:00:03.000Z",
      signal: new AbortController().signal,
      async spawn(launch) {
        const leash = (await HeldAkumaLeash.try(launch.paths))!;
        await leash.birth(launch.paths, { ...launch.seed, createdAt: "2026-08-09T00:00:04.000Z" });
        leash.release();
      },
    });
    try {
      process.env[AKUMA_REQUESTS_ENV] = second.directory;
      const grandchild = await (await akumaAt(value.root)).call({
        archetype: "worker",
        body: "grandchild",
        allowed: ["akuma.call", "task.add"],
      });
      assert.deepEqual(
        (await readSoul(pathsForAkuId(value.root, grandchild.id)))?.allowed,
        ["akuma.call"],
      );
    } finally { await second.close(); }
  } finally {
    await first.close();
    value.leash.release();
    if (previousRequests === undefined) delete process.env[AKUMA_REQUESTS_ENV];
    else process.env[AKUMA_REQUESTS_ENV] = previousRequests;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    value.close();
  }
});

test("Heart refuses a disabled call before child publication", async () => {
  const value = await fixture([]);
  const pump = await BodyRequestPump.open({
    paths: value.parent.paths,
    parent: value.soul,
    bodySequence: 1,
    now: () => "2026-08-09T00:00:01.000Z",
    signal: new AbortController().signal,
    async spawn() { assert.fail("disabled request reached child publication"); },
  });
  try {
    await assert.rejects(requestBodyCall({
      directory: pump.directory,
      id: "00000000-0000-4000-8000-000000000004",
      world: value.root,
      archetype: "worker",
      body: "blocked",
      recipe: {
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        allowed: ["akuma.call"],
      },
    }), (error: unknown) => error instanceof AkumaBodyRequestError
      && error.outcome === "refused"
      && error.diagnostic === "not-allowed: akuma.call");
    const fact = await readRequest(value.parent.paths, "00000000-0000-4000-8000-000000000004");
    assert.equal(fact?.state, "refused");
    assert.equal(fact?.requester, value.parent.id);
    assert.equal(fact?.action, "akuma.call");
  } finally {
    await pump.close();
    value.leash.release();
    value.close();
  }
});

test("publication preserves a Body failure that occurs before birth", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-akuma-publication-failure-")));
  let childPaths: Awaited<ReturnType<typeof allocateAkumaDirectory>>["paths"] | undefined;
  try {
    await assert.rejects(publishAkuma({
      worldPath: root,
      archetype: "worker",
      async launch(allocated) {
        childPaths = allocated.paths;
        await assert.rejects(driveAkumaBody({ paths: allocated.paths }), /Akuma wake has no born soul/u);
        assert.equal((await readSeal(allocated.paths))?.evidence, "Akuma wake has no born soul");
      },
    }), /Akuma wake has no born soul/u);
    assert.equal(childPaths === undefined ? null : (await readSeal(childPaths))?.evidence, "Akuma wake has no born soul");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a drive serves Body Requests through transport while Heart remains authoritative", async () => {
  const value = await fixture();
  const priorHome = process.env.HOME;
  const priorRequests = process.env[AKUMA_REQUESTS_ENV];
  const home = join(value.root, "home");
  mkdirSync(join(home, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(home, ".keiyaku", "akuma", "worker.md"), "---\nprovider: claude\nreadonly: true\n---\nWork.\n");
  writeFileSync(
    join(home, ".keiyaku", "akuma", "codex.md"),
    "---\nprovider: codex-app-server\nreadonly: true\n---\nWork.\n",
  );
  process.env.HOME = home;
  const pump = await BodyRequestPump.open({
    paths: value.parent.paths,
    parent: value.soul,
    bodySequence: 1,
    now: () => "2026-08-09T00:00:01.000Z",
    signal: new AbortController().signal,
    async spawn(launch) {
      const child = (await HeldAkumaLeash.try(launch.paths))!;
      await child.birth(launch.paths, { ...launch.seed, createdAt: "2026-08-09T00:00:02.000Z" });
      child.release();
    },
  });
  try {
    process.env[AKUMA_REQUESTS_ENV] = pump.directory;
    const childId = (await (await akumaAt(value.root)).call({
      archetype: "worker",
      body: "build",
    })).id;
    const childSoul = await readSoul(pathsForAkuId(value.root, childId));
    const origin = childSoul?.origin;
    assert.equal(origin?.kind, "request");
    if (origin?.kind !== "request") return;
    assert.deepEqual(childSoul?.readonly, { enforcement: "native" });
    assert.equal(childSoul?.cwd, value.soul.cwd);
    const requestId = origin.requestId;
    assert.equal((await readRequest(value.parent.paths, requestId))?.state, "served");
    assert.deepEqual(origin, {
      kind: "request",
      parent: value.parent.id,
      requestId,
    });

    const codexId = (await (await akumaAt(value.root)).call({
      archetype: "codex",
      body: "codex work",
    })).id;
    const codexSoul = await readSoul(pathsForAkuId(value.root, codexId));
    assert.equal(codexSoul?.cwd, value.soul.cwd);

    const explicit = join(value.root, "explicit");
    mkdirSync(explicit);
    const explicitId = (await (await akumaAt(value.root)).call({
      archetype: "worker",
      body: "explicit",
      cwd: explicit,
    })).id;
    assert.equal((await readSoul(pathsForAkuId(value.root, explicitId)))?.cwd, explicit);
    delete process.env[AKUMA_REQUESTS_ENV];

    const malformedId = "00000000-0000-4000-8000-000000000001";
    writeFileSync(join(pump.directory, `${malformedId}.request.json`), JSON.stringify({
      id: malformedId,
      world: value.root,
      archetype: "worker",
      body: "legacy association",
      contract: "kei/legacy-association",
      recipe: {
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: { systemPrompt: "Work.\n" },
        allowed: ALLOWED_ACTIONS,
      },
    }));
    await assert.rejects(requestBodyCall({
      directory: pump.directory,
      id: "00000000-0000-4000-8000-000000000002",
      world: join(value.root, "other"),
      archetype: "worker",
      body: "wrong world",
      recipe: {
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: { systemPrompt: "Work.\n" },
        allowed: ALLOWED_ACTIONS,
      },
    }), (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "refused");
    assert.equal(await readRequest(value.parent.paths, malformedId), null, "legacy association bytes must not enter Heart");

    const mismatchId = "00000000-0000-4000-8000-000000000003";
    writeFileSync(join(pump.directory, `${mismatchId}.request.json`), JSON.stringify({
      id: mismatchId,
      world: value.root,
      archetype: "worker",
      body: "restraint mismatch",
      recipe: {
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: { readonly: true, systemPrompt: "Work.\n" },
      },
    }));
    assert.equal(await readRequest(value.parent.paths, mismatchId), null, "a restraint/options mismatch must not enter Heart");
  } finally {
    await pump.close();
    value.leash.release();
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorRequests === undefined) delete process.env[AKUMA_REQUESTS_ENV];
    else process.env[AKUMA_REQUESTS_ENV] = priorRequests;
    assert.equal(existsSync(pump.directory), false);
    value.close();
  }
});

test("a new body settles old requests by observation without replay", async () => {
  const value = await fixture();
  try {
    const admittedId = "00000000-0000-4000-8000-000000000011";
    await admitRequest(value.parent.paths, {
      id: admittedId,
      action: "akuma.call",
      archetype: "worker",
      body: "never spawned",
      world: value.root,
      recipe: { provider: value.soul.provider, options: value.soul.options, allowed: value.soul.allowed },
      admittedAt: "2026-08-09T00:00:01.000Z",
    });

    const bornId = "00000000-0000-4000-8000-000000000012";
    await admitRequest(value.parent.paths, {
      id: bornId, action: "akuma.call", archetype: "worker", body: "born", world: value.root,
      recipe: { provider: value.soul.provider, options: value.soul.options, allowed: value.soul.allowed },
      admittedAt: "2026-08-09T00:00:02.000Z",
    });
    const born = await allocateAkumaDirectory({ worldRoot: value.root, archetype: "worker", draw: () => "00000012" });
    await initializeHeart(born.paths);
    await reserveRequest(value.parent.paths, bornId, born.id);
    const bornLeash = (await HeldAkumaLeash.try(born.paths))!;
    await bornLeash.birth(born.paths, {
      ...value.soul,
      id: born.id,
      archetype: "worker",
      origin: { kind: "request", parent: value.parent.id, requestId: bornId },
    });
    bornLeash.release();

    const unbornId = "00000000-0000-4000-8000-000000000013";
    await admitRequest(value.parent.paths, {
      id: unbornId, action: "akuma.call", archetype: "worker", body: "unborn", world: value.root,
      recipe: { provider: value.soul.provider, options: value.soul.options, allowed: value.soul.allowed },
      admittedAt: "2026-08-09T00:00:03.000Z",
    });
    const unborn = await allocateAkumaDirectory({ worldRoot: value.root, archetype: "worker", draw: () => "00000013" });
    await initializeHeart(unborn.paths);
    await reserveRequest(value.parent.paths, unbornId, unborn.id);

    const mismatchId = "00000000-0000-4000-8000-000000000014";
    await admitRequest(value.parent.paths, {
      id: mismatchId, action: "akuma.call", archetype: "worker", body: "mismatch", world: value.root,
      recipe: { provider: value.soul.provider, options: value.soul.options, allowed: value.soul.allowed },
      admittedAt: "2026-08-09T00:00:04.000Z",
    });
    const mismatch = await allocateAkumaDirectory({ worldRoot: value.root, archetype: "worker", draw: () => "00000014" });
    await initializeHeart(mismatch.paths);
    await reserveRequest(value.parent.paths, mismatchId, mismatch.id);
    const mismatchLeash = (await HeldAkumaLeash.try(mismatch.paths))!;
    await mismatchLeash.birth(mismatch.paths, {
      ...value.soul,
      id: mismatch.id,
      archetype: "worker",
      origin: { kind: "direct" },
    });
    mismatchLeash.release();

    assert.equal(await settleBodyRequests(
      value.parent.paths,
      value.soul,
      () => "2026-08-09T00:00:04.000Z",
    ), "settled");
    assert.equal((await readRequest(value.parent.paths, admittedId))?.state, "voided");
    assert.equal((await readRequest(value.parent.paths, bornId))?.state, "served");
    assert.equal((await readRequest(value.parent.paths, unbornId))?.state, "voided");
    assert.equal((await readRequest(value.parent.paths, mismatchId))?.state, "voided");
    assert.equal((await readSeal(unborn.paths))?.evidence, "request settlement");
  } finally {
    value.leash.release();
    value.close();
  }
});

test("a later body leaves same-actor Contract deliveries unattributed", async () => {
  const value = await fixture(["contract.deliver"]);
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  try {
    const bound = await Keiyaku.bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: "# Delivery recovery\n\n## Context\nC\n\n## Objective\nO\n\n## Design\nD\n\n## Region\n```\nsrc/**\n```\n\n## Criteria\n### C\nC\n",
      workspace: "here",
      gates: ["reviewed"],
    });
    await bound.keiyaku.deliver({ actor: value.soul.id });
    await bound.keiyaku.deliver({ actor: value.soul.id });
    const before = (await bound.keiyaku.history()).events
      .filter((event) => event.source === "journal" && event.fact.kind === "deliver")
      .map((event) => event.source === "journal" ? event.fact : null);
    assert.equal(before.length, 2);
    assert.deepEqual(before.map((fact) => fact?.actor), [value.soul.id, value.soul.id]);

    const requestId = "00000000-0000-4000-8000-000000000021";
    await admitRequest(value.parent.paths, {
      id: requestId,
      action: "contract.deliver",
      repoRoot: repository.path,
      contractId: (await bound.keiyaku.state()).id,
      includeDirty: false,
      admittedAt: "2026-08-09T00:00:05.000Z",
    });
    assert.equal(await settleBodyRequests(
      value.parent.paths,
      value.soul,
      () => "2026-08-09T00:00:06.000Z",
    ), "settled");
    assert.equal((await readRequest(value.parent.paths, requestId))?.state, "voided");
    const after = (await bound.keiyaku.history()).events
      .filter((event) => event.source === "journal" && event.fact.kind === "deliver")
      .map((event) => event.source === "journal" ? event.fact : null);
    assert.deepEqual(after, before);
  } finally {
    value.leash.release();
    value.close();
    rmSync(repository.path, { recursive: true, force: true });
  }
});
