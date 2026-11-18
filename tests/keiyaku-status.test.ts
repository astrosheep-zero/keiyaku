import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Akumas, Keiyaku, World } from "../src/index.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { AkumaAddressError } from "../src/library/address.js";
import { classifyVerb } from "../src/library/keiyaku-classify.js";
import { bornLineageAkuma } from "./support/akuma-fixtures.js";
import { temporaryDirectory } from "./support/process.js";

test("named invocation status freezes the canonical subject before observation", async (t) => {
  const world = await World.at(temporaryDirectory(t, "status-selector-"));
  const first = await bornLineageAkuma({ root: world, akumaName: "worker", draw: "a0000041", createdAt: "2026-08-09T00:00:00.000Z" });
  const second = await bornLineageAkuma({ root: world, akumaName: "worker", draw: "a0000042", createdAt: "2026-08-09T00:00:00.000Z" });
  const alias = parseAkumaAlias("@status-worker");
  await moveAlias({ world, alias, akumaId: first.id });
  const prototype: Akumas = Object.getPrototypeOf(Akumas.of(world));
  const original = prototype.status;
  const observed: string[] = [];
  t.mock.method(prototype, "status", async function (this: Akumas, input: Parameters<Akumas["status"]>[0]) {
    observed.push(input.akuma);
    await moveAlias({ world, alias, akumaId: second.id });
    return original.call(this, input);
  });
  const facet = Keiyaku.for({ cwd: world, environment: {} });
  const originalSubject = await facet.status({ selector: alias });
  assert.equal(originalSubject.kind, "akuma");
  assert.equal(originalSubject.id, first.id);
  assert.deepEqual(observed, [first.id]);
  const movedSubject = await facet.run("status", { selector: alias });
  assert.equal(movedSubject.kind, "akuma");
  assert.equal(movedSubject.id, second.id);
  assert.deepEqual(observed, [first.id, second.id]);
});

test("named status preserves unknown and unavailable authority without establishing a World", async (t) => {
  const cwd = temporaryDirectory(t, "status-no-world-");
  const facet = Keiyaku.for({ cwd, environment: {} });
  await assert.rejects(facet.status({ selector: "@unknown" }), (error: unknown) => {
    assert.ok(error instanceof AkumaAddressError);
    assert.equal(error.refusal.kind, "akuma-alias-not-found");
    assert.equal(classifyVerb("status", { selector: "@unknown" }, { kind: "threw", error }), "refused");
    return true;
  });
  assert.equal(existsSync(join(cwd, ".keiyaku")), false);
  const world = await World.at(cwd);
  const worker = await bornLineageAkuma({ root: world, akumaName: "worker", draw: "a0000043", createdAt: "2026-08-09T00:00:00.000Z" });
  mkdirSync(join(world, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akuma", "alias.json"), "broken\n");
  const exact = await facet.status({ selector: worker.id });
  assert.equal(exact.kind, "akuma");
  assert.equal(exact.id, worker.id);
  await assert.rejects(facet.status({ selector: "@unknown" }), /Alias authority is failed/u);
});
