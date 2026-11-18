import assert from "node:assert/strict";
import test from "node:test";
import { contractId } from "../src/core/facts/types.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import { renderContractCatalogue } from "../src/cli/render/catalog.js";
import { renderDebtList } from "../src/cli/render/debt.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import type { AkumaKanshiRow, KanshiReport } from "../src/kanshi/report.js";
import { contractSummary } from "./support/cli-fixtures.js";
import { startedTool, turnStarted, activityAkumaRow } from "./support/kanshi-activity.js";

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

test("World keeps three flat owner-ordered sections with complete links and native work", () => {
  const child = {
    ...activityAkumaRow(
      "aku/worker/00000001",
      "running",
      [turnStarted(), startedTool(5, "bash", { kind: "run", command: "npm test" })],
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
    debts: { kind: "present", rows: [{ id: "debt/free", title: "Independent", priority: 2, disposition: "ready" }], more: true },
  };
  const text = renderKanshiText(input, { columns: 120, color: false });
  for (const row of [child, peer, free, outside, unknown]) once(text, row.id);
  assert.ok(text.indexOf("CONTRACTS") < text.indexOf(first.id));
  assert.ok(text.indexOf(first.id) < text.indexOf(second.id));
  assert.ok(text.indexOf(second.id) < text.indexOf("AKUMA"));
  assert.ok(text.indexOf("AKUMA") < text.indexOf(peer.id));
  assert.ok(text.indexOf(peer.id) < text.indexOf(child.id));
  assert.ok(text.indexOf(child.id) < text.indexOf(free.id));
  assert.ok(text.indexOf(free.id) < text.indexOf(outside.id));
  assert.ok(text.indexOf(outside.id) < text.indexOf(unknown.id));
  assert.ok(text.indexOf(unknown.id) < text.indexOf("DEBTS"));
  assert.match(text, /aku\/worker\/00000002 · unborn · kei\/second/u);
  assert.match(text, /aku\/worker\/00000001 \(@delivery\) · running[^\n]* · kei\/first/u);
  assert.ok(text.includes("@delivery"));
  assert.ok(text.includes("running"));
  assert.ok(text.includes("npm test"));
  assert.ok(text.includes("kei/outside-page"));
  assert.ok(text.includes("contract association unavailable"));
  assert.ok(text.includes("debt/held"));
  assert.ok(text.includes("debt/free"));
  assert.equal(
    text.split("\n").filter((line) => line === "…").length,
    3,
    "each bounded owner page keeps its omission",
  );
  const sections = text.split(/\n\n(?=AKUMA|DEBTS)/u);
  assert.ok(sections.every((section) => section.endsWith("…")));
});

test("a populated Akuma section reports Alias failure once and keeps its omission", () => {
  const child = worker("00000001", associated(first.id));
  const peer = worker("00000002");
  const input: KanshiReport = {
    ...report([child, peer]),
    akumas: {
      kind: "present",
      rows: [child, peer],
      more: true,
      aliasesError: "Alias file unreadable",
    },
  };
  const text = renderKanshiText(input, { columns: 120, color: false });
  once(text, child.id);
  once(text, peer.id);
  once(text, "aliases unavailable");
  assert.ok(text.endsWith("! aliases unavailable · Alias file unreadable\n…"));
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

test("World and standalone catalogues share thin rows at every width without age tones", () => {
  const contract = { ...first, id: contractId(`kei/${"complete-identity-".repeat(8)}`) };
  const akuma: AkumaKanshiRow = {
    ...worker("00000001", associated(contract.id)),
    life: "running",
    lifeAt: at,
    lastActivityAt: "2026-01-01T09:00:05.000Z",
    pending: 2,
    diagnostic: "Input handoff retained",
  };
  const debt = { id: "debt/catalogue", title: "Owned facts", priority: 2, disposition: "ready" } as const;
  const input: KanshiReport = {
    ...report([akuma]),
    contracts: { kind: "present", rows: [contract] },
    debts: { kind: "present", rows: [debt] },
  };
  for (const columns of [24, 120]) {
    const context = { columns, color: true };
    const standalone = [
      renderContractCatalogue({ kind: "contract-catalogue", observedAt: at, rows: [contract] }),
      renderVerb("ls", { selector: "aku/*" }, { kind: "returned", value: {
        kind: "akuma-catalogue", observedAt: at, rows: [akuma],
      } }, context),
      renderDebtList({ kind: "debt-catalogue", rows: [debt] }),
    ].join("\n\n");
    assert.equal(renderKanshiText(input, context), standalone);
    assert.ok(standalone.includes(contract.id));
    assert.match(standalone, /running · 0s · activity 1h · pending input 2 · diagnostic Input handoff retained/u);
    assert.doesNotMatch(standalone, /\u001b/u);
  }
});

test("World reports pending input by native coordinates when current work supplies them", () => {
  const row: AkumaKanshiRow = {
    ...worker("00000001"),
    life: "running",
    pending: 2,
    work: { kind: "open", pending: [{ id: 13, tellId: "tell/first" }, { id: 21, tellId: "tell/second" }] },
  };
  const text = renderKanshiText(report([row]));
  once(text, "pending input");
  assert.match(text, /^  pending input 13 21$/mu);
});

test("empty Alias failure and unavailable current work stay beside readable peers", () => {
  const empty = renderKanshiText({
    ...report([]),
    contracts: { kind: "present" },
    akumas: { kind: "present", aliasesError: "Alias read failed" },
  });
  assert.equal(empty, "AKUMA\n\n! aliases unavailable · Alias read failed");
  const peer = worker("00000001");
  const unavailable = { ...worker("00000002"), work: { kind: "unavailable", diagnostic: "Heart read failed" } } as const;
  const text = renderKanshiText(report([peer, unavailable]));
  assert.match(text, /aku\/worker\/00000001 · unborn/u);
  assert.match(text, /aku\/worker\/00000002 · unborn\n  ! work unavailable · Heart read failed/u);
});
