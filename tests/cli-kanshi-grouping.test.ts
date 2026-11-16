import assert from "node:assert/strict";
import test from "node:test";
import { contractId } from "../src/core/facts/types.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import type { AkumaKanshiRow, KanshiReport } from "../src/kanshi/report.js";
import { contractSummary } from "./support/cli-fixtures.js";
import { activeTool, activityAkumaRow, openAkumaSnapshot, snapshotRow } from "./support/kanshi-activity.js";

const at = "2026-01-01T10:00:05.000Z";
const first = contractSummary({ id: contractId("kei/first"), title: "First", phaseAt: at });
const second = contractSummary({ id: contractId("kei/second"), title: "Second", phaseAt: at });
function worker(suffix: string, contract?: AkumaKanshiRow["contract"]): AkumaKanshiRow {
  return {
    id: parseAkumaId(`aku/worker/${suffix}`).id,
    life: "unborn",
    ...(contract === undefined ? {} : { contract }),
  };
}
function associated(id: string): NonNullable<AkumaKanshiRow["contract"]> {
  return { kind: "associated", contractId: contractId(id) };
}
function report(rows: readonly AkumaKanshiRow[]): KanshiReport {
  return {
    kind: "world",
    observedAt: at,
    contracts: { kind: "present", rows: [first, second] },
    akumas: { kind: "present", rows },
    debts: { kind: "present" },
  };
}
function once(text: string, identity: string): void {
  assert.equal(text.split(identity).length - 1, 1, `${identity} appears once`);
}

test("World nests selected associated Akumas once and preserves ungrouped links and native work", () => {
  const child = {
    ...activityAkumaRow(
      "aku/worker/00000001",
      "running",
      openAkumaSnapshot([snapshotRow(activeTool(5, "bash", { kind: "run", command: "npm test" }))]),
    ),
    aliases: [parseAkumaAlias("@delivery")],
    contract: associated(first.id),
  };
  const peer = worker("00000002", associated(second.id));
  const free = worker("00000003");
  const outside = worker("00000004", associated("kei/outside-page"));
  const unknown = worker("00000005", { kind: "unavailable" });
  const input: KanshiReport = {
    ...report([peer, child, free, outside, unknown]),
    contracts: {
      kind: "present",
      rows: [
        {
          ...first,
          associations: [
            { kind: "akuma", akumaId: child.id, aliases: ["@delivery"] },
            { kind: "akuma", akumaId: "aku/worker/99999999" },
            { kind: "debt", debtId: "debt/held" },
          ],
        },
        second,
      ],
      more: true,
    },
    akumas: { kind: "present", rows: [peer, child, free, outside, unknown], more: true },
    debts: { kind: "present", rows: [{ id: "debt/free", title: "Independent", priority: 2, disposition: "ready" }] },
  };
  const text = renderKanshiText(input, { columns: 120, color: false });
  for (const row of [child, peer, free, outside, unknown]) once(text, row.id);
  once(text, first.id);
  once(text, second.id);
  assert.ok(text.indexOf(first.id) < text.indexOf(child.id));
  assert.ok(text.indexOf(child.id) < text.indexOf(second.id));
  assert.ok(text.indexOf(second.id) < text.indexOf(peer.id));
  assert.ok(text.indexOf(peer.id) < text.indexOf("AKUMA //"));
  assert.ok(text.indexOf("AKUMA //") < text.indexOf(free.id));
  assert.ok(text.includes("@delivery"));
  assert.ok(text.includes("running"));
  assert.ok(text.includes("npm test"));
  assert.ok(text.includes("kei/outside-page"));
  assert.ok(text.includes("contract association unavailable"));
  assert.ok(text.includes("debt/held"));
  assert.ok(text.includes("debt/free"));
  assert.equal(
    text.split("\n").filter((line) => line === "…").length,
    2,
    "each bounded owner page keeps its omission",
  );
});

test("all-nested Akuma page keeps section omissions and Alias failure without claiming an empty roster", () => {
  const child = worker("00000001", associated(first.id));
  const input: KanshiReport = {
    ...report([child]),
    akumas: {
      kind: "present",
      rows: [child],
      more: true,
      aliasesError: "Alias file unreadable",
    },
  };
  const text = renderKanshiText(input, { columns: 120, color: false });
  once(text, child.id);
  assert.match(text, /aliases unavailable/u);
  assert.match(text, /Alias file unreadable/u);
  assert.ok(text.endsWith("…"));
  assert.ok(!text.includes("akuma  none"));
});

test("unavailable Contract authority leaves every selected Akuma visible and preserves failure evidence", () => {
  const child = worker("00000001", associated(first.id));
  const unknown = worker("00000002", { kind: "unavailable" });
  const input: KanshiReport = {
    ...report([child, unknown]),
    contracts: { kind: "failed", diagnostic: "Repo unreadable" },
  };
  const text = renderKanshiText(input, { columns: 120, color: false });
  once(text, child.id);
  once(text, unknown.id);
  assert.match(text, /CONTRACTS \/\/ unavailable/u);
  assert.match(text, /Repo unreadable/u);
  assert.match(text, /kei\/first/u);
  assert.match(text, /contract association unavailable/u);
});
