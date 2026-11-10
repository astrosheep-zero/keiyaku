import assert from "node:assert/strict";
import test from "node:test";
import { Keis, Keiyaku, Repo, classifyVerb, contractHistorySchema, guidanceSchema } from "../src/index.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { assertWireRoundTrip } from "./support/schema-parity.js";
import { temporaryDirectory } from "./support/process.js";

test("default Contract history is semantic; explicit full history retains each historical version", async (t) => {
  const repository = repositoryWithMain();
  const bound = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({
      markdown: document().replace("Call only the package-root API.", "Historical terms. ".repeat(80)),
      target: null,
      gates: ["reviewed"],
    }),
  );
  const original = present(await bound.kei.state()).terms.document.bytes;
  accepted(await bound.kei.amend({ markdown: "## Replace: Objective\n\nThe amended objective.\n" }));
  const amended = present(await bound.kei.state()).terms.document.bytes;
  accepted(await bound.kei.arc({ markdown: "# A historical chapter\n\nExact narrative body.\n" }));

  const semantic = await bound.kei.history();
  assert.ok(semantic.kind === "contract");
  assert.equal(semantic.contractId, bound.contractId);
  assert.deepEqual(
    semantic.events.map((event) => event.kind),
    ["bind", "amend", "arc"],
  );
  const amendment = semantic.events.find((event) => event.kind === "amend");
  assert.deepEqual(amendment?.changedSections, ["Objective"]);
  assert.equal(
    semantic.events.every((event) => !("document" in event)),
    true,
  );
  assertWireRoundTrip(contractHistorySchema, semantic);

  const facet = Keiyaku.at({
    cwd: repository.path,
    environment: {},
    home: temporaryDirectory(t, "history-full-home-"),
  });
  const full = await facet.run("history", { selector: bound.contractId, full: true });
  assert.ok(full.kind === "contract");
  const boundEvent = full.events.find((event) => event.kind === "bind");
  const amendedEvent = full.events.find((event) => event.kind === "amend");
  assert.ok(boundEvent?.kind === "bind");
  assert.ok(amendedEvent?.kind === "amend");
  assert.equal(boundEvent.document, original);
  assert.equal(amendedEvent.document, amended);
  assert.deepEqual(boundEvent.gates, ["reviewed"]);
  assert.deepEqual(amendedEvent.gates, ["reviewed"]);
  assert.deepEqual(amendedEvent.after, []);
  assert.notEqual(original, amended);
  assert.ok(
    full.events.every((event) =>
      event.kind === "bind" || event.kind === "amend" ? event.document !== undefined : true,
    ),
  );
  assertWireRoundTrip(contractHistorySchema, full);
  assert.deepEqual(await facet.run("history", { selector: bound.contractId }), semantic);
});

test("guidance preserves exact requested bytes and distinguishes missing authority from a present read", async (t) => {
  const repository = repositoryWithMain();
  const contracts = Keis.of(await Repo.at({ path: repository.path }));
  const bound = accepted(await contracts.bind({ markdown: document(), target: null }));
  const facet = Keiyaku.at({ cwd: repository.path, environment: {}, home: temporaryDirectory(t, "guidance-home-") });
  const guidance = await bound.kei.guidance();
  assert.ok(guidance.kind === "present");
  assert.ok(guidance.guidance.includes("## Objective"));
  assert.deepEqual(await facet.show({ contract: bound.contractId }), guidance);
  assertWireRoundTrip(guidanceSchema, guidance);

  const missing = contracts.kei({ id: "kei/missing" as never });
  const missingGuidance = await missing.guidance();
  assert.deepEqual(missingGuidance, { kind: "missing" });
  const missingHistory = await missing.history({ full: true });
  assert.deepEqual(missingHistory, { kind: "contract-missing", contractId: "kei/missing" });
  assertWireRoundTrip(guidanceSchema, missingGuidance);
  assertWireRoundTrip(contractHistorySchema, missingHistory);
  assert.equal(classifyVerb("show", {}, { kind: "returned", value: missingGuidance }), "refused");
  assert.equal(
    classifyVerb("history", { selector: "kei/missing" }, { kind: "returned", value: missingHistory }),
    "refused",
  );
});
