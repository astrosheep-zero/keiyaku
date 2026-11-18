import { projectCurrentWork } from "../src/akuma/status-projection.js";
import {
  acceptedReceipt,
  contractCatalog,
  contractDetail,
  contractReport,
  contractSummary,
  kanshiReport,
} from "./support/cli-fixtures.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  changeId,
  contractId,
  type SnapshotId,
  documentKey,
  entryUlid,
  type EntryUlid,
  gate,
  requirementId,
  snapshotId,
  type ContractId,
} from "../src/core/facts/types.js";
import { dependencyKeySet } from "../src/core/subject.js";
import type { ReconcileCompletion } from "../src/library/reconcile.js";
import { renderAkumaNameCatalogue, renderContractCatalogue } from "../src/cli/render/catalog.js";
import {
  DEFAULT_CONTEXT,
  frameRule,
  historyText as nativeHistoryText,
  snapshotText,
  waitText as nativeWaitText,
} from "../src/cli/render/akuma-activity.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import { liveStatusObservationSchema } from "../src/akuma/akuma-selection-execution.js";
import type { LiveStatusObservation } from "../src/akuma/akuma-observe.js";
import { type ActivityRow, type OutcomeRow, type ToolRow } from "../src/akuma/projection.js";
import type { AkumaObservation, ContractGateCurrent, DeliverOutcome, Placement, Placed, RequirementProblem } from "../src/index.js";
import { renderAkumaBoard } from "../src/cli/render/kanshi-akuma.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import {
  diagnosticLines,
  displayColumns,
  orderRefusalFacts,
  renderOpaqueBlock,
  takeDisplayColumns,
  truncateDisplayText,
} from "../src/cli/render/terminal.js";
import { stopLines } from "../src/cli/render/receipt.js";
import { renderAccepted } from "../src/cli/render/contract.js";
import { renderDeliveryPreview } from "../src/cli/render/delivery-preview.js";
import { renderConflictMaterialized, renderRefusal } from "../src/cli/render/refusal.js";
import { renderReconcile } from "../src/cli/render/reconcile.js";
import {
  activityAkumaRow,
  akumaWorldReport,
  answeredOutcome,
  completedTool,
  startedTool,
  turnStarted,
  AKUMA_ACTIVITY_AT,
  type ActivityToolCall,
} from "./support/kanshi-activity.js";
import { parseArgv } from "../src/cli/parse.js";
import { askCurrentWorkLine } from "../src/cli/render/akuma.js";
import { activityFact } from "./support/akuma-fixtures.js";
import { projectFact } from "../src/akuma/projection.js";
import type { TimelineFact } from "../src/akuma/heart/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import {
  renderDebtList,
  renderDebtMutation,
  renderDebtShow,
  renderDebtUpdate,
  renderDoctor,
} from "../src/cli/render/debt.js";
import type { DebtDetail, DebtList, DebtSummary } from "../src/debt/index.js";
import { renderContractHistory } from "../src/cli/render/contract-history.js";
import { progressStrip } from "../src/cli/render/contract-observation.js";
import type { ContractHistoryEvent } from "../src/index.js";
import { renderContractHelp } from "../src/cli/commands/contract-help.js";
import { renderAkumaHelp } from "../src/cli/commands/akuma.js";

test("canceled outcomes render as canceled in CLI history and snapshots", () => {
  const row = {
    kind: "outcome" as const,
    sequence: 2,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    outcome: { kind: "canceled" as const },
  };
  assert.equal(
    nativeHistoryText(
      {
        kind: "akuma-exact",
        akumaId: parseAkumaId("aku/claude/1234abcd").id,
        sequence: row.sequence,
        turnSequence: row.turnSequence,
        at: row.at,
        outcome: row.outcome,
      },
      { id: "turn/1" },
      DEFAULT_CONTEXT,
    ),
    "canceled",
  );
});

const DIRECT_BIRTH = { origin: { kind: "direct" }, caller: { kind: "unknown" } } as const;

/** One native selected observation over a status row; absent fields stay absent. */
function observation(status: LiveStatusObservation["status"]): AkumaObservation {
  return {
    kind: "akuma",
    id: status.id,
    life: status.life,
    cwd: status.cwd ?? "/work/repo",
    provider: status.provider ?? "fixture",
    work: status.work,
    ...(status.recent === undefined ? {} : { recent: status.recent }),
    ...(status.model === undefined ? {} : { model: status.model }),
    ...(status.strandedReason === undefined ? {} : { strandedReason: status.strandedReason }),
  };
}

/** Delivery identity is already the published wire shape, not a journal projection. */
function deliveryIdentity(candidate: SnapshotId = snapshotId("tender")) {
  return { candidate, integration: snapshotId("integration"), contentId: changeId("0".repeat(40)) };
}

function movement(overrides: Partial<Placed> = {}): Placed {
  return {
    kind: "placed",
    integration: snapshotId("4".repeat(40)),
    predecessor: snapshotId("3".repeat(40)),
    target: "refs/heads/main",
    ...overrides,
  };
}

function placedDelivery(
  integration: SnapshotId = snapshotId("4".repeat(40)),
  predecessor: SnapshotId = snapshotId("3".repeat(40)),
) {
  return { integration, placement: { kind: "placed" as const, predecessor, target: "refs/heads/main" } };
}

function statusFields(rows: readonly ActivityRow[]) {
  return {
    work: projectCurrentWork(rows),
    ...(rows.length === 0 ? {} : { recent: rows.slice(-3) }),
  };
}

function statusOf(
  id: string,
  life: LiveStatusObservation["status"]["life"],
  rows: readonly ActivityRow[],
  extra: Readonly<Record<string, unknown>> = {},
): LiveStatusObservation["status"] {
  return liveStatusObservationSchema.unwrap().shape.status.parse({
    birth: DIRECT_BIRTH,
    id,
    life,
    ...statusFields(rows),
    ...extra,
  });
}

function openRows(rows: readonly ActivityRow[]): readonly ActivityRow[] {
  return [turnStarted(1), ...rows];
}

function idleRows(rows: readonly ActivityRow[], outcome?: OutcomeRow): readonly ActivityRow[] {
  return [...rows, ...(outcome === undefined ? [] : [outcome])];
}

/** One generic tool row carrying the admitted bounded argument preview an adapter retains. */
function genericTool(
  sequence: number,
  name: string,
  input?: Readonly<{ json: string; truncated?: true }>,
): ToolRow {
  return completedTool(sequence, name, {
    kind: "other",
    ...(input === undefined ? {} : { input }),
  });
}

/** The compact preview the shared admission helper builds for structured arguments. */
function preview(value: unknown, truncated = false): Readonly<{ json: string; truncated?: true }> {
  return { json: JSON.stringify(value), ...(truncated ? { truncated: true as const } : {}) };
}

type GenericFixture = readonly [number, string, ReturnType<typeof preview>?];
const genericLines = (rows: readonly GenericFixture[], columns: number) =>
  nativeHistoryText({ kind: "akuma", akumaId: parseAkumaId("aku/worker/abcd1234").id,
    events: rows.map(([sequence, name, input]) => genericTool(sequence, name, input)),
  }, {}, { columns, color: false }).split("\n").slice(2);
/** One native Debt summary row; scenario deltas are explicit overrides. */
function debtSummary(overrides: Partial<DebtSummary> = {}): DebtSummary {
  return {
    id: "debt/row",
    title: "Debt",
    priority: 2,
    disposition: "ready",
    ...overrides,
  };
}

function debtPage(rows: readonly DebtSummary[], more = false): DebtList {
  const [first, ...rest] = rows;
  return {
    kind: "debt-catalogue",
    ...(first === undefined ? {} : { rows: [first, ...rest] as const }),
    ...(more ? { more: true as const } : {}),
  };
}

function debtDetail(overrides: Partial<DebtDetail> = {}): DebtDetail {
  return {
    title: "Alpha",
    state: "open",
    priority: 2,
    createdAt: "2026-08-12T00:00:00.123Z",
    updatedAt: "2026-08-12T00:01:00.456Z",
    ...overrides,
  };
}

test("empty history carries its subject without inferring a lifecycle", () => {
  assert.equal(
    renderContractHistory({ kind: "contract", contractId: contractId("kei/empty-history"), events: [] }),
    "history  kei/empty-history\n",
  );
});

test("delivery and supplied gate verdicts remain distinct native words", () => {
  assert.equal(progressStrip({}), "delivery absent");
  assert.equal(progressStrip({ delivered: true }), "delivery present");
  assert.equal(progressStrip({ delivered: true, gates: [
    { name: gate("reviewed"), verdict: "missing" },
    { name: gate("verified"), verdict: "satisfied" },
    { name: gate("security"), verdict: "unsatisfied" },
    { name: gate("manual"), verdict: "stale" },
  ] }), "delivery present · review missing · verification satisfied · security unsatisfied · manual stale");
});

test("history pages keep individual requirements and exact records retain subjects", () => {
  const watch = contractId("kei/history-test");
  const start = snapshotId("a".repeat(40));
  const candidateA = snapshotId("b".repeat(40));
  const integrationA = snapshotId("c".repeat(40));
  const candidateB = snapshotId("d".repeat(40));
  const integrationB = snapshotId("e".repeat(40));
  const later = snapshotId("f".repeat(40));
  let suffix = 0;
  const nextEntry = () => {
    suffix += 1;
    return String(suffix);
  };
  const delivery = (candidate: SnapshotId, predecessor: SnapshotId, integration: SnapshotId) => ({
    candidate,
    predecessor,
    integration,
    contentId: changeId(integration),
    requireBranchesToBeUpToDate: false,
  });
  const verification = (snapshot: SnapshotId, verdict: "satisfied" | "unsatisfied", target?: EntryUlid) => ({
    gate: gate("verified"),
    requirement: requirementId("verification:sha256:original-check"),
    subject: dependencyKeySet([
      { kind: "snapshot", value: snapshot },
      ...(target === undefined ? [] : [{ kind: "target" as const, value: target }]),
    ]),
    verdict,
    summary: `verification ${verdict}\nsecond line`,
  });
  const reviewChange = changeId("9".repeat(40));
  const reviewDocument = documentKey(`document:sha256:${"ab".repeat(32)}`);
  const events: ContractHistoryEvent[] = [
    {
      kind: "bind",
      id: nextEntry(),
      at: "2026-09-28T15:18:31.946Z",
      start,
      target: "refs/heads/main",
      gates: [gate("reviewed"), gate("verified")],
      after: [],
      document: "# Original terms\n",
    },
    { kind: "dispatch", at: "2026-09-28T15:20:00.000Z", akumaId: parseAkumaId("aku/intern/33dd4670").id },
    { kind: "deliver", id: nextEntry(), at: "2026-09-28T16:00:00.000Z", ...delivery(candidateA, start, integrationA) },
    {
      kind: "attestation",
      id: nextEntry(),
      at: "2026-09-28T16:01:00.000Z",
      ...verification(integrationA, "unsatisfied"),
    },
    {
      kind: "amend",
      id: nextEntry(),
      at: "2026-09-28T16:11:00.000Z",
      target: "refs/heads/release",
      gates: [gate("reviewed"), gate("verified")],
      after: [],
      document: "# Replacement terms\n",
    },
    { kind: "deliver", id: nextEntry(), at: "2026-09-28T16:18:00.000Z", ...delivery(candidateB, start, integrationB) },
    {
      kind: "attestation",
      id: nextEntry(),
      at: "2026-09-28T16:19:00.000Z",
      ...verification(integrationB, "satisfied", entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FA0")),
    },
    {
      kind: "attestation",
      id: nextEntry(),
      at: "2026-09-28T16:38:00.000Z",
      gate: gate("reviewed"),
      requirement: requirementId("gate:reviewed"),
      subject: dependencyKeySet([
        { kind: "document", value: reviewDocument },
        { kind: "change", value: reviewChange },
      ]),
      verdict: "satisfied",
      summary: "review summary",
    },
    {
      kind: "reintegrated",
      id: nextEntry(),
      at: "2026-09-28T16:38:30.000Z",
      predecessor: integrationB,
      integration: later,
    },
    { kind: "attestation", id: nextEntry(), at: "2026-09-28T16:39:00.000Z", ...verification(later, "satisfied") },
    {
      kind: "arc",
      id: nextEntry(),
      at: "2026-09-29T09:00:00.000Z",
      chapter: 1,
      title: "Chapter One",
      body: "freeform body\nline two",
    },
    {
      kind: "claimed",
      id: nextEntry(),
      at: "2026-09-29T09:30:00.000Z",
      deliveryId: "5",
    },
  ];
  const journals = events.filter((event) => event.kind !== "dispatch").length;
  const text = renderContractHistory({ kind: "contract", contractId: watch, events });

  assert.equal(
    text.split("\n")[0],
    `history  kei/history-test · ${journals} entries · 1 dispatch`,
    "the header reports returned rows without asserting current lifecycle",
  );
  assert.doesNotMatch(text, /journal/u);
  assert.equal((text.match(/^\d{4}-\d{2}-\d{2}$/gmu) ?? []).length, 2, "one bare day divider per day");
  assert.match(text, /^15:18 1 bound to main @ aaaaaaa · gates review · verification$/mu);
  assert.match(text, /^15:20 dispatch · aku\/intern\/33dd4670$/mu);
  assert.match(text, /^16:00 2 delivered bbbbbbb$/mu);
  assert.match(text, /^16:01 3 × verification verification:sha256:original-check · subject snapshot ccccccc · \d+ lines$/mu);
  assert.match(text, /^16:11 4 amended · target release$/mu, "history names the retained retarget, not term deltas");
  assert.match(text, /^16:18 5 delivered ddddddd$/mu);
  assert.match(
    text,
    /^16:19 6 ✓ verification verification:sha256:original-check · subject snapshot eeeeeee · target revision 01ARZ3NDEKTSV4RRFFQ69G5FA0 · \d+ lines$/mu,
  );
  assert.match(
    text,
    new RegExp(
      `^16:38 7 ✓ review · subject change ${reviewChange} · document ${reviewDocument} · 1 line$`,
      "mu",
    ),
    "a mark-first review beat labels every recorded subject part in canonical order",
  );
  assert.doesNotMatch(text, /\[\["/u, "subject text never leaks its stored tuple array");
  assert.match(
    text,
    /^16:38 8 integrated eeeeeee\.\.fffffff$/mu,
    "reintegration stays separate from each check's evidence",
  );
  assert.match(text, /^09:00 10 arc Chapter One · 2 lines$/mu, "the chapter title is visible with its body folded");
  assert.match(text, /^09:30 11 accepted$/mu);
  assert.doesNotMatch(text, /freeform body|verification satisfied|verification unsatisfied/u, "evidence stays folded");
  assert.doesNotMatch(text, /\[[ ✓×]\]/u, "history rows never carry state checkboxes");
  assert.doesNotMatch(text, /T\d{2}:\d{2}:\d{2}|Z /u, "skeleton rows carry HH:MM only");
  assert.doesNotMatch(text, /satisfied|unsatisfied/u, "the mark carries the verdict");

  const full = events.flatMap((event) => event.kind === "dispatch" ? [] : [renderContractHistory({ kind: "contract-exact", contractId: watch, event })]).join("\n");
  assert.match(full, /2026-09-28T15:18:31\.946Z bind · 1/u, "exact keeps ISO stamps");
  assert.match(full, /candidate  bbbbbbb/u, "full keeps complete fields");
  assert.match(full, /amend · 4\n  target  release\n  gates  reviewed · verified\n  after  none\n  document\n  # Replacement terms/u);
  assert.match(full, /subject  snapshot ccccccc/u, "full history lays out the recorded subject parts");
  assert.match(full, /subject  snapshot eeeeeee · target revision 01ARZ3NDEKTSV4RRFFQ69G5FA0/u);
  assert.match(
    full,
    new RegExp(`subject  change ${reviewChange} · document ${reviewDocument}`, "u"),
    "full history labels every recorded subject part too",
  );
  assert.doesNotMatch(full, /\[\["/u, "full history never leaks the stored tuple array");

  const help = renderAkumaHelp("history");
  assert.match(help, /--answer/u);
});

test("exact Contract history renders complete historical terms", () => {
  const id = contractId("kei/historical-terms");
  const entry = "1";
  const start = snapshotId("a".repeat(40));
  const bytes = "# Historical terms\n\n## Context\nOriginal scope.\n" + Array.from({length: 150}, (_, index) => `historical line ${index}\n`).join("");
  const event: Extract<ContractHistoryEvent, { kind: "bind" }> = {
    kind: "bind",
    id: entry,
    at: "2026-09-28T15:18:31.946Z",
    start,
    document: bytes,
    gates: [],
    after: [],
  };
  const history = { kind: "contract" as const, contractId: id, events: [event] };
  const full = renderContractHistory({ kind: "contract-exact", contractId: id, event });
  assert.ok(
    full.includes(
      bytes
        .trim()
        .split("\n")
        .map((line) => (line.length === 0 ? "" : `  ${line}`))
        .join("\n"),
    ),
  );
  assert.ok(full.includes(entry));
  assert.doesNotMatch(renderContractHistory(history), /Historical terms|Original scope/u);
  const unavailable = {
    ...history,
    dispatches: {
      kind: "unavailable" as const,
      category: "authority-corruption" as const,
      diagnostic: "Dispatch has invalid fields: dispatch/broken.json",
    },
  };
  const rendered = renderContractHistory(unavailable);
  assert.ok(rendered.includes("bound to targetless"));
  assert.ok(rendered.includes("! Dispatch history unavailable · authority-corruption · Dispatch has invalid fields: dispatch/broken.json"));
});

test("Debt catalogue rows retain complete identity and title in one thin row", () => {
  const row = debtSummary({
    id: "debt/a-very-long-debt-title-that-cannot-fit-here",
    title: "a very long debt title that cannot fit inside one narrow rendered row and keeps going past the terminal",
  });
  assert.equal(renderDebtList(debtPage([row])), `DEBTS\n\n○ ${row.id} · ready · P2 · ${row.title}`);
});

test("Debt receipts name identity, preserve exact content, and report field changes only", () => {
  const debt = debtDetail({ note: "new note", body: "first line\nsecond line" });
  const id = "debt/alpha";
  const update = renderDebtUpdate(id, {
    kind: "accepted",
    changes: ["note"],
  });
  assert.equal(update, "✓ updated  debt/alpha\n  note  changed");
  assert.doesNotMatch(update, /diff|updatedAt|debt\/alpha\.md/u);
  const noop = renderDebtUpdate(id, { kind: "accepted" });
  assert.equal(noop, "✓ updated  debt/alpha");
  const added = renderDebtMutation("add", { kind: "accepted", id });
  assert.equal(added, "✓ added  debt/alpha");
  const warned = renderDebtMutation("add", {
    kind: "accepted",
    id,
    warning: "could not release debt.lock",
  });
  assert.match(warned, /^  ! warning$/mu);
  assert.match(warned, /^    could not release debt\.lock$/mu);
  const refused = renderDebtMutation("add", {
    kind: "refused",
    reason: "invalid-graph",
    diagnostic: "cycle",
  });
  assert.match(refused, /^× add refused$/mu);
  assert.match(refused, /^  reason  invalid graph$/mu);
  assert.match(refused, /^  detail  cycle$/mu);
  assert.equal(renderDebtMutation("add", { kind: "retry", reason: "busy" }), "? add retry\nbusy");
  const shown = renderDebtShow({ kind: "debt-complete", items: [{ kind: "found", id, ...debt }] });
  assert.match(shown, /^  created  2026-08-12T00:00:00Z$/mu);
  assert.match(shown, /^  updated  2026-08-12T00:01:00Z$/mu);
  assert.match(shown, /^  note\n  new note/mu);
  assert.match(shown, /^  body\n  first line/mu);
  const partial = renderDebtShow({
    kind: "debt-partial",
    items: [{ kind: "missing", id: "debt/gone" }, { kind: "found", id, ...debt }],
  });
  assert.match(partial, /^× show refused\n  reason  debt missing\n  debt  debt\/gone/mu);
  assert.match(partial, /debt\/alpha · open · P2 — Alpha/u);
  assert.equal(renderDebtShow({ kind: "absent" }), "debt world absent");
});

test("Debt show and doctor render native prerequisite facts", () => {
  const shown = renderDebtShow(
    {
      kind: "debt-complete", items: [{
        kind: "found",
        id: "debt/root",
        ...debtDetail({
          title: "Root",
          needs: [
            { id: "debt/child", state: "drop" },
            { id: "debt/gone", state: "missing" },
          ],
        }),
      }],
    },
    { columns: 120, color: false },
  );
  assert.match(shown, /^○ debt\/root · open · P2 — Root$/mu);
  assert.match(shown, /^ {2}needs debt\/child · dropped$/mu);
  assert.match(shown, /^ {2}needs debt\/gone · missing$/mu);
  assert.equal(renderDoctor({ kind: "present" }), "✓ doctor  healthy");
  const issues = renderDoctor({
    kind: "present",
    issues: [
      { kind: "missing-target", debtId: "debt/a", relation: "needs", target: "debt/b" },
      { kind: "self-relation", debtId: "debt/a", relation: "needs" },
      { kind: "cycle", relation: "needs", debts: ["debt/a", "debt/c"] },
    ],
  });
  assert.match(issues, /^! doctor  3 issues$/mu);
  assert.match(issues, /^! missing-target debt\/a needs debt\/b$/mu);
  assert.match(issues, /^! self-relation debt\/a needs$/mu);
  assert.match(issues, /^! cycle needs debt\/a debt\/c$/mu);
  assert.equal(renderDoctor({ kind: "absent" }), "debt world absent");
});

test("catalog text renders only the selected identity layer", () => {
  assert.match(
    renderDebtList(
      debtPage([debtSummary({ id: "debt/catalog-row", title: "Catalog row" })], true),
    ),
    /debt\/catalog-row/u,
  );
  assert.equal(
    renderAkumaNameCatalogue({
      kind: "akuma-name-catalogue",
      rows: [{ name: "reviewer", model: "codex-5", description: "Read the complete change without truncation." }],
    }),
    ["AKUMA NAMES // available", "", "reviewer", "  codex-5 — Read the complete change without truncation."].join("\n"),
  );
});
test("ls help lists the Akuma catalogue usage forms", () => {
  const help = renderContractHelp("ls");
  assert.ok(help.includes("ls aku[/] [--limit <count>]"));
  assert.ok(help.includes("ls aku/<name>"));
  assert.ok(help.includes('ls "aku/<name>/*"'));
  assert.ok(help.includes('ls "aku/*/*"'));
});

test("rendered Akuma catalog header names Akuma names, never akumaName", () => {
  const text = renderAkumaNameCatalogue({
    kind: "akuma-name-catalogue",
    rows: [{ name: "reviewer" }],
  });
  assert.ok(text.startsWith("AKUMA NAMES // available"));
  assert.doesNotMatch(text, /akumaName/iu);
});
test("root Debt catalogue marks every disposition with its own state", () => {
  const cases = [
    ["ready", "○"],
    ["blocked", "‖"],
    ["done", "✓"],
    ["drop", "×"],
  ] as const;
  const catalog = debtPage(
    cases.map(([disposition]) =>
      debtSummary({
        id: `debt/${disposition}`,
        title: disposition,
        priority: 1,
        disposition,
      }),
    ),
  );
  const text = renderDebtList(catalog);
  for (const [state, mark] of cases) assert.ok(text.includes(`${mark} debt/${state}`));
});

test("empty World status has one explicit empty row", () => {
  assert.equal(
    renderKanshiText(
      {
        kind: "world",
        observedAt: "2026-08-12T00:00:00.000Z",
        contracts: { kind: "present" },
        debts: { kind: "present" },
        akumas: { kind: "present" },
      },
      { columns: 120, color: false },
    ),
    "○ world empty",
  );
});
test("empty catalogues share a surface-named none state", () => {
  assert.equal(renderDebtList({ kind: "debt-catalogue" }), "debts  none");
  assert.equal(renderContractCatalogue(contractCatalog([])), "contracts  none");
  assert.equal(renderVerb("ls", { selector: "aku/*" }, { kind: "returned", value: { kind: "akuma-catalogue", observedAt: "2026-08-12T00:00:00.000Z" } }, { columns: 120, color: false }), "akuma  none");
});
test("World roster names a bound Contract once without a bare unavailable parenthetical", () => {
  const snapshot = idleRows([]);
  const bound = {
    ...activityAkumaRow("aku/worker/11110001", "asleep", snapshot),
    contract: { kind: "associated" as const, contractId: contractId("kei/bound-contract") },
  };
  const boundText = renderAkumaBoard(akumaWorldReport([bound]).akumas, "2026-01-01T10:00:05.000Z", { columns: 120, color: false }).join("\n");
  assert.match(boundText, /· kei\/bound-contract$/mu);
  assert.doesNotMatch(boundText, /bound to|unbound/u);
  assert.doesNotMatch(boundText, /->/u);

  const free = renderAkumaBoard(akumaWorldReport([activityAkumaRow("aku/worker/22220002", "asleep", snapshot)]).akumas, "2026-01-01T10:00:05.000Z", {
    columns: 120,
    color: false,
  }).join("\n");
  assert.match(free, /○ aku\/worker\/22220002 · asleep · 5s$/mu);
  assert.doesNotMatch(free, /bound to|unbound/u);
  assert.doesNotMatch(free, /·\s*$/mu);
});
test("Debt listings retain empty and absent observations", () => {
  const empty = { kind: "debt-catalogue" as const };
  assert.equal(renderDebtList(empty), "debts  none");
  assert.equal(renderDebtList({ kind: "debt-catalogue", absent: true }), "debt world absent");
  const text = renderDebtList(debtPage([debtSummary({ id: "debt/one-row", title: "One row" })], true));
  assert.match(text, /^DEBTS$/mu);
  assert.match(text, /^○ debt\/one-row · ready · P2 · One row$/mu);
  assert.ok(text.endsWith("\n…"));
});

test("Debt catalogue rows render the compact native summary", () => {
  const text = renderDebtList(
    debtPage([debtSummary({ id: "debt/no-body", title: "No body", priority: 1 })]),
  );
  assert.match(text, /^○ debt\/no-body · ready · P1 · No body$/mu);
  assert.doesNotMatch(text, /bodyPresent|^  (body|note)$/mu);
});

test("World status debt rows state a Contract association only when one exists", () => {
  const row = {
    id: "debt/standalone",
    title: "Standalone debt",
    priority: 1,
    disposition: "ready",
  } as const;
  const text = renderKanshiText(
    {
      ...akumaWorldReport([]),
      debts: { kind: "present", rows: [row] },
    },
    { columns: 120, color: false },
  );
  assert.match(text, /○ debt\/standalone · ready · P1 · Standalone debt$/mu);
  assert.doesNotMatch(text, /bound to|unbound/u);
  assert.doesNotMatch(text, /·\s*$/mu);
});

test("World roster states the activity age only when it differs from the state age", () => {
  const snapshot = idleRows([]);
  const equal = activityAkumaRow("aku/worker/33330003", "asleep", snapshot);
  const equalText = renderAkumaBoard(akumaWorldReport([equal]).akumas, "2026-01-01T10:00:05.000Z", { columns: 120, color: false }).join("\n");
  assert.match(equalText, /asleep · 5s/u);
  assert.doesNotMatch(equalText, /activity/u);
  const distinct = { ...equal, lastActivityAt: "2026-01-01T09:59:00.000Z" };
  const distinctText = renderAkumaBoard(akumaWorldReport([distinct]).akumas, "2026-01-01T10:00:05.000Z", { columns: 120, color: false }).join("\n");
  assert.match(distinctText, /activity 1m/u);
});

test("Contract catalog keeps domain IDs complete and makes every gate state legible", () => {
  const summary = (
    delivery: "pending" | "delivered",
    gates: readonly {
      name: ReturnType<typeof gate>;
      verdict: "satisfied" | "unsatisfied" | "missing" | "stale";
    }[],
  ) =>
    contractSummary({
      id: contractId("kei/selected-contract"),
      title: "Selected Contract",
      ...(delivery === "delivered" ? { delivered: true as const } : {}),
      gates,
    });
  const catalog = contractCatalog(
    [
      summary("pending", [
        { name: gate("reviewed"), verdict: "satisfied" },
        { name: gate("verified"), verdict: "unsatisfied" },
        { name: gate("security"), verdict: "stale" },
        { name: gate("manual"), verdict: "missing" },
      ]),
    ],
    { more: true },
  );
  const text = renderContractCatalogue(catalog);

  assert.match(text, /kei\/selected-contract · bound · 0s · Selected Contract/u);
  assert.match(text, /delivery absent · review satisfied · verification unsatisfied · security stale · manual missing/u);
  assert.doesNotMatch(text, /awaiting/u);
  assert.doesNotMatch(text, /candidate|predecessor|method|content identity|behind|workspace|target/u);
  assert.doesNotMatch(text, /not shown|full|next:|--all/u);
  assert.equal(text.endsWith("…"), true);

  const delivered = renderContractCatalogue(
    contractCatalog([
      summary("delivered", [
        { name: gate("reviewed"), verdict: "satisfied" },
        { name: gate("verified"), verdict: "unsatisfied" },
        { name: gate("security"), verdict: "stale" },
        { name: gate("manual"), verdict: "missing" },
      ]),
    ]),
  );
  assert.match(delivered, /delivery present · review satisfied · verification unsatisfied · security stale · manual missing/u);
  assert.doesNotMatch(delivered, /awaiting/u);
  assert.doesNotMatch(delivered, /candidate|predecessor|content identity|method|behind/u);
});
test("selected Contract roster preserves terminal associations and unavailable observations", () => {
  const attached = { id: "aku/worker/11110001", aliases: [parseAkumaAlias("@lead")] };
  const missing = { id: "aku/worker/22220002", aliasesUnavailable: true as const };
  const report = contractReport(
    contractDetail({
      phase: "claimed",
      roster: [attached, missing],
    }),
  );
  const text = renderKanshiText(report, { columns: 80, color: false });
  assert.match(text, /aku\/worker\/11110001 \(@lead\)/u);
  assert.match(text, /aku\/worker\/22220002 \(aliases unavailable\)/u);
  assert.match(text, /worktree  \/tmp\/wt/u);
  assert.doesNotMatch(text, /activity|candidate/u);
});
test("Contract status preserves ordered native facts and bounded testimony in every phase", () => {
  const integration = snapshotId("a".repeat(40));
  const tender = snapshotId("b".repeat(40));
  const long = "👩‍💻".repeat(120);
  const reviewGate = (current: ContractGateCurrent) => ({
    gate: "reviewed",
    satisfied: current.kind === "attested" && current.verdict === "satisfied",
    current,
    requirements: [{ requirement: requirementId("gate:reviewed"), current }],
  });
  const at = "2026-08-12T00:00:00.000Z";
  const base = contractDetail({
    phase: "bound",
    title: "Verified commit",
    gates: [reviewGate({ kind: "missing" })],
  });
  const show = (detail: Parameters<typeof contractReport>[0]) =>
    renderKanshiText(contractReport(detail), { columns: 60, color: false });
  const bound = show(base);
  assert.match(bound, /· bound · Verified commit/u);
  assert.match(bound, /review · missing/u);
  assert.match(bound, /holder  none/u);
  assert.doesNotMatch(bound, /awaiting delivery/u);
  assert.match(bound, /worktree  \/tmp\/wt/u);
  const delivered = show({
    ...base,
    delivery: { candidate: tender, integration },
  });
  assert.match(delivered, /review · missing/u);
  assert.doesNotMatch(delivered, /awaiting gates/u);
  assert.match(delivered, /candidate  bbbbbbb/u);
  assert.match(delivered, /integration result  aaaaaaa/u);
  assert.doesNotMatch(delivered, /predecessor|method|content identity|behind/u);
  const denied = show({
    ...base,
    delivery: { candidate: tender, integration },
    gates: [reviewGate({ kind: "attested", verdict: "unsatisfied", at, summary: "Fix missing coverage" })],
  });
  assert.match(denied, /review summary  “Fix missing coverage”/u);
  assert.match(denied, /review · current · unsatisfied/u);
  assert.doesNotMatch(denied, /× reviewed/u);
  assert.equal((denied.match(/Fix missing coverage/gu) ?? []).length, 1);
  const stale = show({
    ...base,
    delivery: { candidate: tender, integration },
    gates: [reviewGate({ kind: "stale", priorVerdict: "satisfied" })],
  });
  assert.match(stale, /review · stale/u);
  const blocked = show({
    ...base,
    delivery: { candidate: tender, integration },
    gates: [],
    after: [{ contractId: contractId("kei/other"), state: "active" }],
  });
  assert.match(blocked, /candidate  bbbbbbb/u);
  assert.match(blocked, /^  blocked by  kei\/other · active$/mu);
  const moved = show({
    ...base,
    delivery: { candidate: tender, integration },
    gates: [],
    target: "refs/heads/main",
    targetObservation: { kind: "moved", before: integration, after: tender },
  });
  assert.match(moved, /^  integration result  aaaaaaa$/mu);
  assert.match(moved, /^  target moved  aaaaaaa -> bbbbbbb$/mu);
  assert.doesNotMatch(moved, /awaiting/u);
  const unwitnessed = show({
    ...base,
    delivery: { candidate: tender, integration },
    gates: [],
    target: "refs/heads/main",
  });
  assert.match(unwitnessed, /^  integration result  aaaaaaa$/mu);
  assert.doesNotMatch(unwitnessed, /target moved/u, "a differing head is not drift without owner evidence");
  const claimed = show({
    ...base,
    phase: "claimed",
    delivery: { candidate: tender, integration },
    gates: [reviewGate({ kind: "attested", verdict: "satisfied", at, summary: long })],
    targetLag: { kind: "counted", behind: 5 },
  });
  assert.match(claimed, /integration result  aaaaaaa/u);
  assert.match(claimed, /candidate  bbbbbbb/u);
  assert.match(claimed, /review · current · satisfied/u);
  assert.match(claimed, /target behind 5/u);
  assert.match(claimed, /worktree  \/tmp\/wt/u);
  assert.doesNotMatch(claimed, /when  5s/u);
  assert.match(claimed, /review summary  “/u);
  assert.match(claimed, /│ /u);
  assert.match(claimed, /…”/u);
  assert.doesNotMatch(claimed, /landed|predecessor|method|content identity|target moved/u);
  const abandoned = show({ ...base, phase: "abandoned", abandonNote: long });
  assert.match(abandoned, /· abandoned ·/u);
  assert.match(abandoned, /note  “/u);
  assert.match(abandoned, /…”/u);
  assert.match(abandoned, /worktree  \/tmp\/wt/u);
  assert.match(abandoned, /review · missing/u);
  const world = renderKanshiText(
    kanshiReport({
      kind: "present",
      rows: [contractSummary({ delivered: true })],
    }),
    { columns: 60, color: false },
  );
  assert.match(world, /delivery present/u);
  assert.doesNotMatch(world, /awaiting gates/u);
  assert.doesNotMatch(world, /candidate|predecessor|method|content identity|behind/u);
});
test("a terminal Contract keeps its retained or unavailable target checkout issue visible", () => {
  const retained = renderKanshiText(
    contractReport(
      contractDetail({
        phase: "claimed",
        target: "refs/heads/main",
        issue: { kind: "target-checkout-retained" },
      }),
    ),
    { columns: 80, color: false },
  );
  assert.match(retained, /^ {2}checkout behind$/mu);
  assert.match(retained, /^ {2}target  refs\/heads\/main$/mu);
  assert.match(retained, /workspace  clean/u);
  const unavailable = renderKanshiText(
    contractReport(
      contractDetail({
        phase: "abandoned",
        issue: { kind: "unavailable", diagnostic: "status read failed" },
      }),
    ),
    { columns: 80, color: false },
  );
  assert.match(unavailable, /^ {2}checkout unavailable · status read failed$/mu);
  assert.match(unavailable, /worktree  \/tmp\/wt/u);
});

test("verb receipts render native conclusions with explicit invocation context", () => {
  const id = contractId("kei/receipt-vocabulary");
  const arc = acceptedReceipt("arc", { contractId: id, chapter: 2 });
  const texts = [
    renderAccepted("bind", acceptedReceipt("bind", { contractId: id })),
    renderAccepted("amend", acceptedReceipt("amend", { contractId: id })),
    renderAccepted("arc", arc),
    renderAccepted("abandon", acceptedReceipt("abandon", { contractId: id }), undefined, { note: "Scope retired" }),
    renderAccepted("deliver", acceptedReceipt("deliver", { contractId: id, ...deliveryIdentity() })),
    renderAccepted("review", acceptedReceipt("review", { contractId: id }), undefined, { verdict: "satisfied" }),
  ];
  assert.equal(texts[2], "✓ chapter 2 opened  kei/receipt-vocabulary");
  assert.match(texts[3]!, /note  Scope retired/u);
  assert.match(texts[5]!, /✓ review satisfied/u);
  for (const text of texts) assert.ok(text.includes(id));
});

test("opaque payloads preserve lines and name overflow", () => {
  assert.deepEqual(renderOpaqueBlock("diff --git a/x b/x\n+++ b/x\n@@ -1 +1 @@", "  ", 100), [
    "  diff --git a/x b/x",
    "  +++ b/x",
    "  @@ -1 +1 @@",
  ]);
  const lines = renderOpaqueBlock(`${"line\n".repeat(100)}tail`, "  ", 100);
  assert.equal(lines.length, 100);
  assert.match(lines.at(-1) ?? "", /omitted/u);
  const wrapped = renderOpaqueBlock("x".repeat(8_000), "  ", 80);
  assert.equal(wrapped.length, 100);
  assert.match(wrapped.at(-1) ?? "", /omitted/u);
});

/** A native selected-Contract reconcile result; absence means known empty. */
const reconcileId = contractId("kei/reconciled");
const reconcile = (
  report: Omit<Extract<ReconcileCompletion, { kind: "contract" }>, "kind" | "contractId">,
): Extract<ReconcileCompletion, { kind: "contract" }> => ({ kind: "contract", contractId: reconcileId, ...report });

test("reconcile reports retained workspace and failed cleanup in human words", () => {
  const result = reconcile({
    issues: [
      {
        kind: "worktree-retained",
        severity: "optional",
        path: "/tmp/wt",
        diagnostic: "scratch removal failed",
      },
      {
        kind: "worktree-hook-failed",
        severity: "required",
        phase: "destroy",
        path: "/tmp/wt",
        name: "cleanup",
        diagnostic: "exit 7",
      },
    ],
  });
  const text = renderReconcile(result);
  assert.match(text, /^! lag  worktree retained  \/tmp\/wt$/mu);
  assert.match(text, /^  reason\n  scratch removal failed$/mu);
  assert.match(text, /! lag  worktree-hook-failed destroy \/tmp\/wt name cleanup/u);
  assert.match(text, /reason\n  exit 7/u);
  assert.doesNotMatch(text, /!.*worktree-retained/u);
});

test("Verification receipts expose retained scratch and its cleanup diagnostic", () => {
  const result = acceptedReceipt("verify", {
    contractId: contractId("kei/residue"),
    snapshot: snapshotId("verified-snapshot"),
    checks: [],
    issues: [{ kind: "diagnostic", severity: "optional", path: "/tmp/scratch", diagnostic: "cleanup failed" }],
  });
  const text = renderAccepted("verify", result);
  assert.match(text, /residue\s+\/tmp\/scratch/u);
  assert.match(text, /cleanup failed/u);
});

test("preview keeps each requirement's verdict and summary without parsing output", () => {
  const summary = "check output [1 bash exit 1]";
  const result = acceptedReceipt("deliver-preview", {
    contractId: contractId("kei/preview"),
    ...deliveryIdentity(),
    scope: {},
    unmetGates: [
      {
        gate: gate("verified"),
        requirement: requirementId("historical-check"),
        state: "unsatisfied",
        summary,
      },
    ],
  });
  const text = renderDeliveryPreview(result);
  assert.match(text, /verification historical-check\s+recorded unsatisfied/u);
  assert.ok(text.includes(summary));
  assert.match(text, /deliver --dry-run/u);
});

test("refusals use reason and option for missing contract and nuke confirmation", () => {
  const missing = renderRefusal({
    operation: "status",
    refusal: { kind: "contract-missing" },
  });
  assert.match(missing, /reason  contract missing/u);
  const nuke = renderRefusal({
    operation: "nuke",
    refusal: { kind: "nuke-confirmation-required", world: "/repo" },
  });
  assert.match(nuke, /reason  nuke confirmation required/u);
  assert.match(nuke, /option  keiyaku nuke --confirm '\/repo'/u);
});

test("Debt listing displays dropped while the native disposition remains drop", () => {
  const row = debtSummary({
    id: "debt/dropped",
    title: "Retired",
    priority: 1,
    disposition: "drop",
  });
  const text = renderDebtList(debtPage([row]));
  assert.match(text, /debt\/dropped · dropped · P1/u);
  assert.equal(row.disposition, "drop");
});

test("amend receipt names gate and prerequisite changes even without document diff", () => {
  const contract = contractId("kei/gate-only");
  const base = acceptedReceipt("amend", { contractId: contract });
  assert.match(renderAccepted("amend", base), /✓ amended  kei\/gate-only\n  terms  unchanged/u);
  const gates = renderAccepted("amend", acceptedReceipt("amend", { contractId: contract, gatesChanged: true }));
  assert.match(gates, /✓ amended[\s\S]*gates  changed/u);
  assert.doesNotMatch(gates, /terms  unchanged/u);
  assert.match(
    renderAccepted("amend", acceptedReceipt("amend", { contractId: contract, afterChanged: true })),
    /after  changed/u,
  );
});

test("amend summarizes changed sections and independently changed obligations", () => {
  const text = renderAccepted(
    "amend",
    acceptedReceipt("amend", {
      contractId: contractId("kei/changed-terms"),
      changedSections: ["Design", "Criteria"],
      gatesChanged: true,
      afterChanged: true,
    }),
  );
  assert.match(text, /changed sections  Design · Criteria/u);
  assert.match(text, /gates  changed/u);
  assert.match(text, /after  changed/u);
  assert.doesNotMatch(text, /terms  unchanged/u);
});

test("receipt ids abbreviate in text, omit empty content, and remain full in JSON", () => {
  const contract = contractId("kei/identity");
  const tender = snapshotId("a".repeat(40));
  const integration = snapshotId("b".repeat(40));
  const result = acceptedReceipt("deliver", {
    contractId: contract,
    ...deliveryIdentity(tender),
    ...placedDelivery(integration, tender),
  });
  const text = renderAccepted("deliver", result);
  assert.match(text, /candidate  aaaaaaa/u);
  assert.match(text, /target  aaaaaaa\.\.bbbbbbb/u);
  assert.match(text, /✓ accepted/u);
  assert.doesNotMatch(text, /a{40}|b{40}|0{40}|content identity/u);
  assert.equal(JSON.parse(JSON.stringify(result)).candidate, tender);
});

test("preview names target lag without inventing absent requirement evidence", () => {
  const contract = contractId("kei/audit-lag");
  const head = snapshotId("a".repeat(40));
  const integrated = snapshotId("b".repeat(40));
  const base = acceptedReceipt("deliver-preview", {
    contractId: contract,
    candidate: head,
    integration: integrated,
    contentId: changeId("0".repeat(40)),
    scope: {},
    target: { kind: "placeable", ref: "refs/heads/main", head, behind: 3 },
  });
  const counted = renderDeliveryPreview(base);
  assert.match(counted, /^  target  placeable  main @ aaaaaaa · behind 3$/mu);
  const unknown = renderDeliveryPreview({
    ...base,
    target: { kind: "placeable", ref: "refs/heads/main", head, behind: "unknown" },
  });
  assert.match(unknown, /^  target  placeable  main @ aaaaaaa · behind unknown$/mu);
  assert.doesNotMatch(unknown, /behind 3|not.run|undeclared/u);
});

test("receipt hashes extend their prefixes when IDs collide within one receipt", () => {
  const tender = snapshotId(`${"a".repeat(7)}0${"0".repeat(32)}`);
  const integration = snapshotId(`${"a".repeat(7)}1${"0".repeat(32)}`);
  const text = renderAccepted(
    "deliver",
    acceptedReceipt("deliver", {
      contractId: contractId("kei/hash-collision"),
      ...deliveryIdentity(tender),
      ...placedDelivery(integration, tender),
    }),
  );
  assert.match(text, /candidate  aaaaaaa0/u);
  assert.match(text, /target  aaaaaaa0\.\.aaaaaaa1/u);
});

test("reconcile lists changed effects once with path last and no null sentinels", () => {
  const ref = {
    kind: "ref" as const,
    name: "refs/keiyaku/delivery/example",
    before: "a".repeat(40),
    after: null,
  };
  const text = renderReconcile(reconcile({ effects: [ref, ref] }));
  assert.equal(text, "✓ reconcile\n  effect  ref  aaaaaaa → absent  refs/keiyaku/delivery/example");
  assert.doesNotMatch(text, /null/u);
});

test("reconcile recovery snapshots use receipt-length Git identities", () => {
  const text = renderReconcile(
    reconcile({
      effects: [{ kind: "recovery-snapshot", snapshot: snapshotId("f".repeat(40)) }],
    }),
  );
  assert.match(text, /effect  recovery snapshot  fffffff/u);
  assert.doesNotMatch(text, /f{40}/u);
});

test("reconcile renders a healthy no-op compactly", () => {
  const result = reconcile({});
  assert.equal(renderReconcile(result), "✓ reconcile\n  already consistent");
});

test("reconcile failure renders mark and facts", () => {
  const result = reconcile({
    issues: [
      {
        kind: "reconcile-failed",
        severity: "required",
        diagnostic: "git failed",
      },
    ],
  });
  assert.equal(renderReconcile(result), "! reconcile incomplete\n! lag  reconcile-failed\n  reason\n  git failed\n");
});

test("reconcile renders worktree hook failure as attention", () => {
  const result = reconcile({
    issues: [
      {
        kind: "worktree-hook-failed",
        severity: "required",
        phase: "create",
        path: "/tmp/wt",
        name: "prepare",
        diagnostic: "exit 7\nhook failed",
      },
    ],
  });
  const text = renderReconcile(result);
  assert.match(text, /! lag  worktree-hook-failed create \/tmp\/wt name prepare/u);
  assert.match(text, /reason\n  exit 7\n  hook failed/u);
});

test("reconcile renders target checkout retention as attention", () => {
  const result = reconcile({
    issues: [
      {
        kind: "target-checkout-retained",
        severity: "required",
        target: "refs/heads/main",
        path: "/repo/file",
        diagnostic: "checkout failed",
      },
    ],
  });
  const text = renderReconcile(result);
  assert.match(text, /! lag  checkout behind  \/repo\/file  · refs\/heads\/main/u);
  assert.match(text, /  reason\n  checkout failed/u);
});

test("reconcile renders private-state seat-close failure and diagnostic", () => {
  const result = reconcile({
    issues: [
      {
        kind: "diagnostic",
        severity: "required",
        diagnostic: "could not close publication seat",
      },
    ],
  });
  const text = renderReconcile(result);
  assert.match(text, /! stopped/u);
  assert.match(text, /  reason\n  could not close publication seat/u);
});

test("reconcile hook payloads preserve lines and remain bounded", () => {
  const result = reconcile({
    issues: [
      {
        kind: "worktree-hook-failed",
        severity: "required",
        phase: "destroy",
        path: "/tmp/wt",
        name: "cleanup",
        diagnostic: `exit 9\n${"line\n".repeat(100)}tail`,
      },
    ],
  });
  const lines = renderReconcile(result).split("\n");
  assert.equal(lines.filter((line) => line.startsWith("  ")).length <= 101, true);
  assert.equal(lines.includes("  line"), true);
  assert.equal(lines.includes("  tail"), false);
  assert.match(lines.at(-2) ?? "", /omitted/u);
  assert.equal(
    lines.some((line) => line === "  line  line"),
    false,
  );
});

test("reconcile renders contract-file and settlement failures", () => {
  const result = reconcile({
    issues: [
      {
        kind: "contract-file-failed",
        severity: "required",
        path: ".keiyaku/KEIYAKU.md",
        diagnostic: "write failed",
      },
      { kind: "settlement-failed", severity: "required", diagnostic: "debt failed" },
    ],
  });
  const text = renderReconcile(result);
  assert.match(text, /! lag  contract-file-failed \.keiyaku\/KEIYAKU\.md/u);
  assert.match(text, /reason\n  write failed/u);
  assert.match(text, /! settlement/u);
  assert.match(text, /reason\n  debt failed/u);
});

test("world reconcile failure renders its diagnostic", () => {
  const result = { kind: "world-observation-failed", diagnostic: "git failed" } as const;
  assert.equal(renderReconcile(result), "! reconcile failed\n! reconcile  git failed");
});

test("Verification create action names are safe in text receipts", () => {
  const name = "prepare\nINJECT\u001b[31m";
  const result = acceptedReceipt("verify", {
    contractId: contractId("kei/hostile-create-name"),
    snapshot: snapshotId("snapshot"),
    checks: [
      {
        kind: "stopped",
        index: 1,
        requirement: "check-one",
        stop: { kind: "environment-hook-failure", name, diagnostic: "exit 17" },
      },
    ],
  });

  const text = renderAccepted("verify", result, { columns: 200, color: false });
  assert.equal(text.includes('name "prepare\\nINJECT\\u001b[31m"'), true);
  assert.doesNotMatch(text, /\nINJECT/u);
  assert.doesNotMatch(text, /\u001b/u);
  const check = result.checks[0];
  assert.equal(check?.kind === "stopped" && check.stop.kind === "environment-hook-failure" ? check.stop.name : undefined, name);
});

test("Verification cleanup action names are safe in text receipts", () => {
  const name = "destroy\rINJECT\u001b[2J";
  const contract = contractId("kei/hostile-cleanup-name");
  const result = acceptedReceipt("verify", {
    contractId: contract,
    snapshot: snapshotId("verified-snapshot"),
    checks: [],
    issues: [
      {
        kind: "diagnostic",
        severity: "optional",
        name,
        diagnostic: "timeout",
      },
    ],
  });

  const text = renderAccepted("verify", result, { columns: 200, color: false });
  assert.equal(text.includes('name "destroy\\rINJECT\\u001b[2J"'), true);
  assert.doesNotMatch(text, /\rINJECT/u);
  assert.doesNotMatch(text, /\u001b/u);
  const cleanup = result.issues?.find((issue) => issue.kind === "diagnostic");
  assert.equal(cleanup?.kind === "diagnostic" ? cleanup.name : undefined, name);
});

test("accepted results preserve reconciliation lag without telemetry", () => {
  const contract = contractId("kei/followed");
  const lag = {
    kind: "worktree-follow-retained" as const,
    severity: "optional" as const,
    path: "/tmp/wt",
    reason: "head-moved" as const,
  };
  const issues = [lag];
  assert.equal(
    renderAccepted("deliver", acceptedReceipt("deliver", { contractId: contract, issues, ...deliveryIdentity() })),
    ["✓ delivered  kei/followed", "  candidate  tender · kept", "  integration result  integration"].join("\n"),
  );
});

test("accepted bind receipts expose confirmed private-state seat close lag", () => {
  const contract = contractId("kei/bound");
  const result = acceptedReceipt("bind", {
    contractId: contract,
    worktreePath: "/tmp/wt",
    issues: [
      {
        kind: "diagnostic",
        severity: "required",
        diagnostic: "seat close failed after publication",
      },
    ],
  });
  assert.equal(
    renderAccepted("bind", result),
    [
      "✓ bound  kei/bound",
      "  worktree  /tmp/wt",
      "  no target",
      "! stopped",
      "  reason",
      "  seat close failed after publication",
      "",
    ].join("\n"),
  );
});

test("delivery distinguishes reused admission and keeps fresh input notes in context", () => {
  const contract = contractId("kei/delivery-admission");
  const fields = {
    contractId: contract,
    ...deliveryIdentity(snapshotId("tender-commit")),
    contentId: changeId("content-id"),
  };
  const fresh = renderAccepted("deliver", acceptedReceipt("deliver", fields), undefined, { message: "fresh delivery" });
  assert.match(fresh, /candidate  tender-commit[\s\S]*content identity  content-id/u);
  assert.match(fresh, /note\n  fresh delivery/u);
  const reused = renderAccepted("deliver", acceptedReceipt("deliver", { ...fields, admission: "reused" }), undefined, {
    message: "not newly admitted",
  });
  assert.match(reused, /admission  reused/u);
  assert.doesNotMatch(reused, /not newly admitted/u);
});

test("direct placement stops render the public unmet prerequisites in order", () => {
  const contract = contractId("kei/waiting-on-prerequisites");
  const unmet = [
    { contractId: contractId("kei/active-prerequisite"), state: "active" as const },
    { contractId: contractId("kei/abandoned-prerequisite"), state: "abandoned" as const },
    { contractId: contractId("kei/missing-prerequisite"), state: "missing" as const },
  ];
  const placement: Placement = {
    kind: "prerequisites-unsatisfied",
    unmet,
  };
  assert.equal(
    renderAccepted("deliver", acceptedReceipt("deliver", { contractId: contract, ...deliveryIdentity(), placement })),
    [
      "✓ delivered  kei/waiting-on-prerequisites",
      "  candidate  tender · kept",
      "  integration result  integration",
      "! prerequisites unsatisfied",
      "  prerequisite  kei/active-prerequisite  ·  active",
      "  prerequisite  kei/abandoned-prerequisite  ·  abandoned",
      "  prerequisite  kei/missing-prerequisite  ·  missing",
    ].join("\n"),
  );

  assert.equal(
    renderAccepted("review", acceptedReceipt("review", { contractId: contract, placement }), undefined, {
      verdict: "satisfied",
    }),
    [
      "✓ review satisfied  kei/waiting-on-prerequisites",
      "! prerequisites unsatisfied",
      "  prerequisite  kei/active-prerequisite  ·  active",
      "  prerequisite  kei/abandoned-prerequisite  ·  abandoned",
      "  prerequisite  kei/missing-prerequisite  ·  missing",
    ].join("\n"),
  );
});

test("a satisfied review whose placement fails names the satisfied fact once and refuses in outcome words", () => {
  const contract = contractId("kei/review-refused-f911");
  const text = renderAccepted(
    "review",
    acceptedReceipt("review", {
      contractId: contract,
      placement: {
        kind: "failed",
        diagnostic: "fatal: could not read from remote repository",
      },
    }),
    undefined,
    { verdict: "satisfied" },
  );
  assert.equal(
    text,
    [
      "✓ review satisfied  kei/review-refused-f911",
      "× not accepted",
      "  reason",
      "  fatal: could not read from remote repository",
      "",
    ].join("\n"),
  );
  assert.equal((text.match(/✓ review satisfied/gu) ?? []).length, 1, "the satisfied fact prints once");
  assert.doesNotMatch(text, /placement|continuation|reconciliation/u, "no internal phase name appears");
});

/** Shared text scenarios take native wire fields directly. */
function reviewText(
  contractId: ContractId,
  fields: Omit<ReturnType<typeof acceptedReceipt<"review">>, "kind" | "contractId"> = {},
): string {
  return renderAccepted("review", acceptedReceipt("review", { contractId, ...fields }), undefined, {
    verdict: "satisfied",
  });
}
function deliverText(
  contractId: ContractId,
  fields: Partial<Omit<ReturnType<typeof acceptedReceipt<"deliver">>, "kind" | "contractId">> = {},
): string {
  return renderAccepted("deliver", acceptedReceipt("deliver", { contractId, ...deliveryIdentity(), ...fields }));
}
function abandonText(
  contractId: ContractId,
  fields: Omit<ReturnType<typeof acceptedReceipt<"abandon">>, "kind" | "contractId"> = {},
): string {
  return renderAccepted("abandon", acceptedReceipt("abandon", { contractId, ...fields }));
}
function blockedText(slug: string, unmet: readonly RequirementProblem[]) {
  const contract = contractId(slug);
  return deliverText(contract, {
    placement: {
      kind: "gates-unsatisfied",
      unmet,
    },
  });
}

test("a gates-refused placement keeps each requirement's evidence and pending state", () => {
  const text = blockedText("kei/blocked-review", [
    {
      gate: gate("verified"),
      requirement: requirementId("check-one"),
      state: "unsatisfied",
      summary: "[1 bash exit 1]",
    },
    {
      gate: gate("reviewed"),
      requirement: requirementId("gate:reviewed"),
      state: "stale",
    },
    {
      gate: gate("manual"),
      requirement: requirementId("gate:manual"),
      state: "missing",
    },
  ]);
  assert.equal(
    text,
    [
      "✓ delivered  kei/blocked-review",
      "  candidate  tender · kept",
      "  integration result  integration",
      "× verification check-one  recorded unsatisfied",
      "  summary",
      "  [1 bash exit 1]",
      "",
      "! review  stale",
      "○ manual  missing",
      "⧗ awaiting review, manual",
    ].join("\n"),
  );
  assert.doesNotMatch(text, /gate/u, "the gate class word leaves the receipt");
  assert.doesNotMatch(text, /gates unsatisfied|gates-unsatisfied/u, "no refusal kind prints");
});

test("a gates-refused placement awaits each not-yet-happened requirement as a plain noun", () => {
  const text = blockedText("kei/two-missing", [
    { gate: gate("reviewed"), requirement: requirementId("gate:reviewed"), state: "missing" },
    {
      gate: gate("verified"),
      requirement: requirementId("check-one"),
      state: "stale",
    },
  ]);
  assert.equal(
    text.split("\n").at(-1),
    "⧗ awaiting review, verification check-one",
    "a stale requirement folds into the same await",
  );
});

test("four or more awaited requirements still name every event", () => {
  const text = blockedText(
    "kei/many-missing",
    ["a", "b", "c", "d"].map((name) => ({
      gate: gate(name),
      requirement: requirementId(`gate:${name}`),
      state: "missing" as const,
    })),
  );
  assert.equal(text.split("\n").at(-1), "⧗ awaiting a, b, c, d");
});

test("a gates-refused placement whose unmet requirements all hold verdicts omits the await line", () => {
  const text = blockedText("kei/recorded-only", [
    {
      gate: gate("verified"),
      requirement: requirementId("check-one"),
      state: "unsatisfied",
    },
  ]);
  assert.equal(
    text,
    [
      "✓ delivered  kei/recorded-only",
      "  candidate  tender · kept",
      "  integration result  integration",
      "× verification check-one  recorded unsatisfied",
    ].join("\n"),
  );
  assert.doesNotMatch(text, /awaiting/u, "nothing is pending when every unmet requirement holds a verdict");
});

test("an unsatisfied review attempts no placement and carries no target row", () => {
  const contract = contractId("kei/review-unsatisfied");
  const text = renderAccepted("review", acceptedReceipt("review", { contractId: contract }), undefined, {
    verdict: "unsatisfied",
  });
  assert.doesNotMatch(text, /target/u);
});

test("completion stops project an ignored-checkout refusal fact", () => {
  const contract = contractId("kei/checkout-followability");
  const text = [
    "reason  checkout not followable",
    "target  refs/heads/main",
    "checkout  /repo/checkout",
    "paths",
    "  ignored.tmp",
    '  quote"path.tmp',
  ];
  const rendered = deliverText(contract, {
    placement: {
      kind: "checkout-not-followable",
      target: "refs/heads/main",
      path: "/repo/checkout",
      paths: ["ignored.tmp", 'quote"path.tmp'],
    },
  });
  const renderedLines = rendered.split("\n");
  const start = renderedLines.indexOf("reason  checkout not followable");
  assert.notEqual(start, -1);
  assert.deepEqual(renderedLines.slice(start, start + text.length), text);
});

test("continuation checkout stop keeps its exact block after the dependent context", () => {
  const contract = contractId("kei/prerequisite-checkout");
  const dependent = contractId("kei/stopped-checkout-dependent");
  assert.equal(
    deliverText(contract, {
      ...placedDelivery(snapshotId("2".repeat(40)), snapshotId("1".repeat(40))),
      continuation: {
        stopped: [
          {
            contractId: dependent,
            stop: {
              kind: "checkout-not-followable",
              target: "refs/heads/main",
              path: "/repo/checkout",
              paths: ['quote"path.ts'],
            },
          },
        ],
      },
    }),
    [
      "✓ delivered  kei/prerequisite-checkout",
      "  candidate  tender",
      "  integration result  2222222",
      "  target  1111111..2222222  refs/heads/main",
      "✓ accepted",
      "! dependent  kei/stopped-checkout-dependent",
      "reason  checkout not followable",
      "target  refs/heads/main",
      "checkout  /repo/checkout",
      "paths",
      '  quote"path.ts',
    ].join("\n"),
  );
});

test("retry stops name their retry class in outcome vocabulary", () => {
  const addressed = contractId("kei/retry-stop");
  const dependent = contractId("kei/retry-dependent");
  assert.deepEqual(
    stopLines(
      {
        kind: "retry",
        reason: "exhausted",
      },
      100,
      addressed,
    ),
    ["? retry  exhausted"],
  );
  assert.deepEqual(
    stopLines(
      {
        kind: "retry",
        reason: "collision",
      },
      100,
      addressed,
    ),
    ["? retry  collision"],
  );
  assert.deepEqual(
    stopLines(
      {
        kind: "retry",
        reason: "publication-failed",
        diagnostic: "fatal: unable to create lock",
      },
      100,
      addressed,
    ),
    ["? retry  publication failed", "  reason", "  fatal: unable to create lock", ""],
  );
  assert.deepEqual(
    stopLines(
      {
        kind: "retry",
        reason: "collision",
      },
      100,
      addressed,
      dependent,
    ),
    [`? retry  collision  ·  ${dependent}`],
  );

  for (const stop of [
    { kind: "retry", reason: "exhausted" },
    { kind: "retry", reason: "collision" },
    { kind: "retry", reason: "publication-failed", diagnostic: "fatal: unable to create lock" },
  ] as const) {
    const text = stopLines(stop, 100, addressed, dependent).join("\n");
    assert.match(text, /^\? retry  /u);
    assert.doesNotMatch(text, /!/u);
  }
});

test("a retry placement stop renders through the delivered receipt without the failure mark", () => {
  const contract = contractId("kei/retry-stops-receipt");
  assert.equal(
    deliverText(contract, {
      placement: {
        kind: "retry",
        reason: "publication-failed",
        diagnostic: "fatal: unable to create lock",
      },
    }),
    [
      "✓ delivered  kei/retry-stops-receipt",
      "  candidate  tender · kept",
      "  integration result  integration",
      "? retry  publication failed",
      "  reason",
      "  fatal: unable to create lock",
      "",
    ].join("\n"),
  );
});

test("detail facts sink behind ordered refusal facts", () => {
  assert.deepEqual(orderRefusalFacts(["reason  first", "detail  alpha", "path  /repo", "detail  beta", "debt  t"]), [
    "reason  first",
    "path  /repo",
    "debt  t",
    "detail  alpha",
    "detail  beta",
  ]);
  assert.deepEqual(orderRefusalFacts(["detail  only", "reason  kept"]), ["reason  kept", "detail  only"]);
});

test("delivery and review report confirmed placement without claiming check execution", () => {
  const delivered = deliverText(contractId("kei/completion"), placedDelivery());
  assert.equal(
    delivered,
    [
      "✓ delivered  kei/completion",
      "  candidate  tender",
      "  integration result  4444444",
      "  target  3333333..4444444  refs/heads/main",
      "✓ accepted",
    ].join("\n"),
  );
  const reviewed = reviewText(contractId("kei/placement-reuse"), { placement: movement() });
  assert.equal(
    reviewed,
    ["✓ review satisfied  kei/placement-reuse", "  target  3333333..4444444  refs/heads/main", "✓ accepted"].join("\n"),
  );
  assert.doesNotMatch(`${delivered}\n${reviewed}`, /check \d+  executed/u);
});

test("a deliver receipt keeps candidate, integration and content identities distinct", () => {
  const text = deliverText(contractId("kei/standalone-subject"), {
    candidate: snapshotId("b".repeat(40)),
    integration: snapshotId("d".repeat(40)),
    contentId: changeId("c".repeat(40)),
  });
  assert.equal(
    text,
    [
      "✓ delivered  kei/standalone-subject",
      "  candidate  bbbbbbb · kept",
      "  integration result  ddddddd",
      "  content identity  ccccccc",
    ].join("\n"),
  );
});

test("a terminal receipt names a retained worktree in place of the obituary", () => {
  const retainedAbandon = contractId("kei/retained-abandon");
  const retained = abandonText(retainedAbandon, {
    issues: [{ kind: "worktree-retained", severity: "optional", path: "/repo/.keiyaku/wt/fridge" }],
  });
  assert.match(retained, /^! lag  worktree retained  \/repo\/\.keiyaku\/wt\/fridge$/mu);
  assert.doesNotMatch(retained, /retired/u);
  const residueContract = contractId("kei/preexisting-residue");
  const preexisting = reviewText(residueContract, {
    issues: [
      {
        kind: "worktree-retained",
        severity: "optional",
        path: "/tmp/wt",
      },
    ],
  });
  assert.doesNotMatch(preexisting, /lag  worktree|\/tmp\//u, "pre-existing residue stays typed-only");
});

test("a terminal receipt names each checkout its own follow left behind", () => {
  const checkoutContract = contractId("kei/retained-checkout");
  const text = reviewText(checkoutContract, {
    placement: movement(),
    issues: ["/repo", "/repo/.keiyaku/wt/fridge"].map((path) => ({
      kind: "target-checkout-retained" as const,
      severity: "required" as const,
      path,
      target: "refs/heads/main",
      diagnostic: "kept",
    })),
  });
  assert.match(text, /^✓ accepted$/mu);
  assert.match(text, /^! lag  checkout behind  \/repo  · refs\/heads\/main$/mu);
  assert.match(text, /^! lag  checkout behind  \/repo\/\.keiyaku\/wt\/fridge  · refs\/heads\/main$/mu);
  assert.doesNotMatch(text, /target-checkout-retained/u, "the raw kind never prints");
  const checkoutResidue = contractId("kei/preexisting-checkout-residue");
  const preexisting = reviewText(checkoutResidue, {
    issues: [
      {
        kind: "target-checkout-retained",
        severity: "required",
        path: "/repo",
        target: "refs/heads/main",
        diagnostic: "kept",
      },
    ],
  });
  assert.doesNotMatch(preexisting, /checkout behind|\/repo/u, "pre-existing checkout residue stays typed-only");
});

test("deliver renders accepted and stopped continuations from the accepted result", () => {
  const contract = contractId("kei/prerequisite");
  const claimed = contractId("kei/claimed-dependent");
  const stopped = contractId("kei/stopped-dependent");
  assert.equal(
    deliverText(contract, {
      ...placedDelivery(snapshotId("6".repeat(40)), snapshotId("5".repeat(40))),
      continuation: {
        claimed: [claimed],
        stopped: [
          {
            contractId: stopped,
            stop: {
              kind: "gates-unsatisfied",
              unmet: [{ gate: gate("reviewed"), requirement: requirementId("gate:reviewed"), state: "missing" }],
            },
          },
        ],
      },
    }),
    [
      "✓ delivered  kei/prerequisite",
      "  candidate  tender",
      "  integration result  6666666",
      "  target  5555555..6666666  refs/heads/main",
      "✓ accepted",
      "✓ dependent  complete  kei/claimed-dependent",
      "⧗ kei/stopped-dependent  ·  awaiting review",
      "○ review  missing",
    ].join("\n"),
  );
});

test("movement preserves final placement and an exhausted target-movement stop", () => {
  const contract = contractId("kei/reintegrated");
  assert.equal(
    deliverText(contract, {
      ...placedDelivery(snapshotId("integration-4"), snapshotId("target-3")),
    }),
    [
      "✓ delivered  kei/reintegrated",
      "  candidate  tender",
      "  integration result  integration-4",
      "  target  target-3..integration-4  refs/heads/main",
      "✓ accepted",
    ].join("\n"),
  );
  const stopped = deliverText(contract, {
    placement: {
      kind: "target-moved",
      target: "refs/heads/main",
      integration: snapshotId("integration-2"),
      observed: null,
    },
  });
  assert.match(stopped, /candidate  tender · kept/u);
  assert.match(stopped, /! target moved  refs\/heads\/main  integration-2 -> absent/u);
});

test("a multi-line invalid-document diagnostic keeps one detail row per diagnostic", () => {
  const text = renderRefusal({
    operation: "bind",
    refusal: {
      kind: "invalid-document",
      diagnostic: "contract document is missing ## Design\ncontract document is missing ## Region",
    },
  });
  assert.equal(
    text,
    [
      "× bind refused",
      "  reason  invalid document",
      "  detail  contract document is missing ## Design",
      "  detail  contract document is missing ## Region",
    ].join("\n"),
  );
});

test("materialized conflict text keeps the exact recovery projection", () => {
  const result: Extract<DeliverOutcome, { kind: "handoff" }> = {
    kind: "handoff",
    contractId: contractId("kei/conflicted"),
    targetHead: snapshotId("b".repeat(40)),
    conflictPaths: ["a.txt", "b.txt"],
    worktreePath: "/repo/.keiyaku/wt/x",
    handoffBase: snapshotId("a".repeat(40)),
  };
  assert.equal(
    renderConflictMaterialized(result),
    [
      "! integration-conflict-materialized",
      "  target  bbbbbbb",
      "  delivery  none",
      "  index  unmerged",
      "  saved  worktree bytes before projection",
      "  handoff base  aaaaaaa",
      "  conflicts",
      "    a.txt",
      "    b.txt",
      "  workspace  /repo/.keiyaku/wt/x",
      "  option  deliver  keiyaku deliver --include-dirty · reads worktree bytes, not index",
    ].join("\n"),
  );
  assert.equal(JSON.parse(JSON.stringify(result)).handoffBase, result.handoffBase);
  assert.doesNotMatch(renderConflictMaterialized(result), /staging|not-required|UU|please|next|then/u);
});

test("World roster keeps the latest concrete tool work", () => {
  const calls: readonly Readonly<{ name: string; call: ActivityToolCall }>[] = [
    { name: "read", call: { kind: "read", path: "src/a.ts", offset: 10, limit: 5 } },
    {
      name: "grep",
      call: { kind: "search", query: "snapshot", scope: "content", path: "src" },
    },
    {
      name: "edit",
      call: { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts", diffstat: { added: 2, removed: 1 } }] },
    },
    {
      name: "bash",
      call: { kind: "run", command: "bash -lc 'npm test -- tests/cli-render.test.ts'" },
    },
  ];
  const snapshot = openRows(
    calls.map((member, index) => (startedTool(index + 1, member.name, member.call))),
  );
  const roster = renderAkumaBoard(akumaWorldReport([activityAkumaRow("aku/worker/aaaa0001", "running", snapshot)]).akumas, "2026-01-01T10:00:05.000Z", {
    columns: 120,
    color: false,
  });
  assert.match(roster.at(-1)!, /run +\$ bash -lc 'npm test -- tests\/cli-render\.test\.ts'/u);
  assert.doesNotMatch(roster.join("\n"), /src\/a\.ts|activity "/u);
});

test("World and addressed status retain the outcome's exact history coordinate and verdict", () => {
  const snapshot = idleRows([], answeredOutcome(1, "complete retained answer"));
  const context = { columns: 70, color: false };
  const board = renderAkumaBoard(
    akumaWorldReport([activityAkumaRow("aku/worker/aaaa0001", "asleep", snapshot)]).akumas,
    "2026-01-01T10:00:05.000Z",
    context,
  ).join("\n");
  const status = liveStatusObservationSchema.unwrap().shape.status.parse({
    birth: DIRECT_BIRTH, id: "aku/worker/aaaa0001", life: "asleep", ...statusFields(snapshot),
  });
  for (const text of [board, snapshotText(observation(status), context)])
    assert.match(text, /answered turn\/1 · activity 1/u);
});

test("native history retains diagnostics beneath a bounded command row", () => {
  const diagnostic = "hook failed; retained diagnostic words; log /work/recovery/log.txt";
  const row = completedTool(1, "bash", { kind: "run", command: `bash -lc 'npm test ${"long-file ".repeat(30)}'` },
    { status: "error", exitCode: 7, message: diagnostic });
  const context = { columns: 48, color: false };
  const status = statusOf("aku/worker/aaaa0001", "running", openRows([row]));
  const text = nativeHistoryText({ kind: "akuma", akumaId: status.id, events: [row] }, {}, context);
  const lines = text.split("\n");
  const continuation = lines.slice(lines.findIndex((line) => line.includes("run")) + 1).join(" ").replace(/\s+/gu, " ");
  assert.ok(continuation.includes(diagnostic));
  assert.doesNotMatch(continuation, /…/u, "a diagnostic that fits the continuation stays whole");
  assert.match(text, /run\s+\$[^…\n]+… — (?:error|exit 7)/u, "the command and failure status survive together");
  const short = completedTool(2, "bash", { kind: "run", command: "npm test" }, { status: "error", message: "hook failed" });
  const textShort = nativeHistoryText({ kind: "akuma", akumaId: status.id, events: [short] }, {}, context);
  assert.equal(textShort.split("hook failed").length - 1, 1, "a complete inline diagnostic is not repeated");
});

test("native history bounds long diagnostics with a visible omission", () => {
  const message = "diagnostic word ".repeat(1000);
  for (const columns of [24, 48, 100, 200]) {
    const context = { columns, color: false };
    for (const failed of [false, true]) {
      const row = completedTool(1, "bash", { kind: "run", command: "npm test" }, { status: failed ? "error" : "ok", message });
      const status = statusOf("aku/worker/aaaa0001", "running", openRows([row]));
      const text = nativeHistoryText({ kind: "akuma", akumaId: status.id, events: [row] }, {}, context);
      assert.match(text, /diagnostic/u);
      assert.match(text.trimEnd(), /…$/u, "the bounded diagnostic visibly omits its remainder");
    }
  }
});

test("World roster keeps the honest fallback for unknown tool calls", () => {
  const snapshot = openRows([
    (startedTool(1, "mystery", { kind: "other" })),
    (startedTool(2, "custom-tool", { kind: "other" })),
  ]);
  const roster = renderAkumaBoard(akumaWorldReport([activityAkumaRow("aku/worker/cccc0003", "running", snapshot)]).akumas, "2026-01-01T10:00:05.000Z", {
    columns: 120,
    color: false,
  }).join("\n");
  assert.ok(roster.includes("2 custom-tool"));
});

test("a settled successful tool spends no mark while voice and input rows keep their own leads", () => {
  const id = "aku/worker/abcd0040";
  const rows: ActivityRow[] = [
    completedTool(1, "read", { kind: "read", path: "src/a.ts", offset: 0, limit: 1 }),
    { kind: "said", sequence: 2, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "spoken" },
    { kind: "tell", sequence: 3, at: AKUMA_ACTIVITY_AT, tellId: "tell/mark-law", text: "told direction", state: "told",
      deliveries: [{ route: "launch", turnSequence: 1, deliveredAt: AKUMA_ACTIVITY_AT }] },
  ];
  const text = nativeHistoryText({ kind: "akuma", akumaId: parseAkumaId(id).id, events: rows }, {}, { columns: 100, color: false });
  assert.match(text, /^ {3}read +src\/a\.ts · L0-0$/mu, "a settled tool affirms success by spending no mark");
  assert.match(text, /^▎ spoken$/mu, "speech sits on its own rail without a label or quotes");
  assert.match(text, /^▸ told direction$/mu, "a told input keeps its input lead");
  assert.equal((text.match(/✓/gu) ?? []).length, 0, "settled work adds no completion to running status");
});

test("generic tool rows preserve observed JSON arguments", () => {
  const lines = genericLines(
    [
      [1, "future_tool", preview({ alpha: 1, beta: "x", gamma: { delta: [true, null] } })],
      [2, "silent"],
      [3, "silent", preview({})],
      [4, "future_tool", { json: '{"alpha":1,"beta":"long', truncated: true }],
    ],
    200,
  );
  const text = lines.join("\n");
  assert.match(
    text,
    /future_tool\s+\{"alpha":1,"beta":"x","gamma":\{"delta":\[true,null\]\}\}/u,
    "nested compact JSON keeps types and order",
  );
  assert.match(text, /future_tool\s+\{"alpha":1,"beta":"long…/u, "a truncated capture keeps its explicit ellipsis");
  assert.match(text, /^ {3}silent$/mu, "an absent argument preview keeps the tool identity alone");
  assert.match(text, /^ {3}silent +\{\}$/mu, "an explicitly empty argument object stays visibly empty");
});

test("generic tool rows keep failure diagnostics beside argument previews", () => {
  const events = [
    completedTool(
      1,
      "future_tool",
      { kind: "other", input: preview({ alpha: 1 }) },
      { status: "error", message: "refused" },
    ),
    completedTool(2, "future_tool", { kind: "other", input: preview({}) }, { status: "error", exitCode: 7 }),
  ];
  const text = nativeHistoryText({ kind: "akuma", akumaId: parseAkumaId("aku/worker/abcd1234").id, events }, {}, { columns: 200, color: false });
  for (const [pattern, message] of [
    [/\{"alpha":1\} — error · refused$/mu, "argument evidence and its failure stay together"],
    [/future_tool\s+\{\} — exit 7$/mu, "an empty argument object never swallows failure evidence"],
  ] as const)
    assert.match(text, pattern, message);
  assert.doesNotMatch(text, / — ok/u);
  const legacy = nativeHistoryText({ kind: "akuma", akumaId: parseAkumaId("aku/worker/abcd1234").id,
    events: [completedTool(1, "mystery", { kind: "other" }, { status: "error", message: "refused" })],
  }, {}, { columns: 120, color: false });
  assert.match(legacy, /mystery — error · refused$/mu);
  assert.equal((legacy.match(/refused/gu) ?? []).length, 1, "a name-only failure states its diagnostic once");
});

test("generic tool rows preserve name, width, and grapheme behavior", () => {
  const exact = "e".repeat(71);
  const family = "👨‍👩‍👧‍👦";
  const lines = genericLines(
    [
      [1, "n".repeat(120), preview({ a: 1 })],
      [2, "🙂".repeat(60), preview({ a: 1 })],
      [3, "n".repeat(120)],
      [4, exact, preview({ a: 1 })],
      [5, family + family, preview({ a: 1 })],
      [6, family.repeat(60), preview({ a: 1 })],
      [7, "ok_tool", preview({ path: "a" })],
      [8, "a_very_long_tool_name_here", preview({ arguments: "y".repeat(200) })],
      [9, "wide_tool", preview({ text: "🙂".repeat(30) })],
    ],
    80,
  );
  assert.equal(lines.length, 9, "one rendered line per generic tool row");
  for (const line of lines) assert.ok(displayColumns(line) <= 80, `one line within 80 columns: ${line}`);
  assert.ok(lines[0]!.includes("…"), "an over-wide name truncates visibly");
  assert.ok(lines[1]!.includes("🙂"), "a wide name keeps whole graphemes");
  assert.doesNotMatch(lines[1]!, /\uFFFD/u, "no grapheme is split into a replacement");
  assert.ok(lines[3]!.includes(exact), "an exact-fit name is not truncated");
  assert.ok(lines[3]!.endsWith("…"), "the argument preview truncates visibly instead of vanishing");
  for (const line of lines.slice(4, 6)) {
    assert.ok(line.includes(family), "a ZWJ family stays whole");
    assert.doesNotMatch(line, /\uFFFD/u, "ZWJ is never replaced by a replacement character");
  }
  assert.equal(
    lines[6]!.indexOf("{"),
    3 + "ok_tool".length + 1,
    "a name longer than six cells uses its own action width",
  );
  assert.ok(lines[7]!.includes("a_very_long_tool_name_here"), "an over-long name stays complete");
  assert.ok(lines[7]!.endsWith("…"), "args truncate before the name does");
  assert.ok(lines[8]!.includes("🙂") && lines[8]!.endsWith("…"), "a truncated emoji argument stays grapheme-safe");
});

test("activity rows share one six-cell default action column", () => {
  const note = { kind: "note", sequence: 1, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "payload" } as const;
  const plainNote = nativeHistoryText({ kind: "akuma", akumaId: parseAkumaId("aku/worker/abcd1234").id, events: [note] }, {}, { columns: 80, color: false }).split("\n")[2]!;
  const plainTool = genericLines([[1, "tool", preview({ value: 1 })]], 80)[0]!;
  assert.equal(
    plainNote.indexOf("payload"),
    plainTool.indexOf("{"),
    "narrative and tool rows share the default action column",
  );
});

test("World current work keeps concrete active work and visible clipping", () => {
  const active = openRows([
    (startedTool(1, "bash", { kind: "run", command: "keiyaku wait --all" })),
  ]);
  const activeRoster = renderAkumaBoard(akumaWorldReport([activityAkumaRow("aku/worker/aabb0006", "running", active)]).akumas, "2026-01-01T10:00:05.000Z", {
    columns: 120,
    color: false,
  }).join("\n");
  assert.match(activeRoster, /1 run \$ keiyaku wait --all/u);
  assert.doesNotMatch(activeRoster, /— ok/u);

  const truncated = openRows([
    ({ kind: "said", sequence: 3, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "x".repeat(400) }),
  ]);
  const truncatedRoster = renderAkumaBoard(
    akumaWorldReport([activityAkumaRow("aku/worker/eeff0008", "running", truncated)]).akumas,
    "2026-01-01T10:00:05.000Z",
    { columns: 120, color: false },
  ).join("\n");
  assert.match(truncatedRoster, /…$/u);
  assert.ok(!truncatedRoster.includes("x".repeat(200)), "truncation bounds retained said text");
});

test("a sleeping worker retains its outcome coordinate and completion judgment", () => {
  const sleeping = liveStatusObservationSchema.unwrap().shape.status.parse({
    birth: DIRECT_BIRTH,
    id: "aku/worker/abcd0001",
    life: "asleep",
    ...statusFields(idleRows([], answeredOutcome(1, "the answer"))),
  });
  const snapshot = snapshotText(observation(sleeping), { columns: 80, color: false });
  assert.match(snapshot, /answered turn\/1 · activity 1/u);
  assert.match(snapshot, /✓ completed$/u);

  const answerless = liveStatusObservationSchema.unwrap().shape.status.parse({
    birth: DIRECT_BIRTH,
    id: "aku/worker/abcd0002",
    life: "asleep",
    ...statusFields(idleRows([])),
  });
  const answerlessText = snapshotText(observation(answerless), { columns: 80, color: false });
  assert.match(answerlessText, /✓ completed$/mu, "an answer-less sleeper keeps its closer");

  const returned = nativeWaitText(
    {
      kind: "akuma",
      reason: "completed",
      results: [
        {
          kind: "observed",
          id: sleeping.id,
          life: sleeping.life,
          outcome: { kind: "answered", historyId: "turn/1", answer: "the answer" },
        },
      ],
    },
    {},
    { columns: 80, color: false },
  );
  assert.equal(returned, `✓ ${sleeping.id} — answered\n  turn/1 · answered\n  the answer`, "wait keeps the complete exact-turn answer without a status panel");
  assert.doesNotMatch(returned, /─|✓ answer|came back/u, "no panel, no separate answer row, no retired life label");
});

test("status text and JSON report the Akuma execution workdir", () => {
  const id = "aku/worker/abcd0009";
  const status = liveStatusObservationSchema.unwrap().shape.status.parse({
    birth: DIRECT_BIRTH,
    id,
    life: "running",
    cwd: "/work/tree",
    ...statusFields(openRows([])),
  });
  const invocation = parseArgv(["status", id]);
  assert.ok("command" in invocation);
  const observationView = observation(status);
  const statusLines = snapshotText(observationView, DEFAULT_CONTEXT).split("\n");
  assert.deepEqual(
    statusLines.slice(0, 3),
    [id, "  /work/tree", frameRule([id, "  /work/tree"], DEFAULT_CONTEXT.columns)],
    "the execution directory is a static coordinate above the content boundary",
  );
  assert.doesNotMatch(statusLines.join("\n"), /cwd/u, "the coordinate is named once, above the timeline");
  const json = JSON.parse(JSON.stringify(observationView));
  assert.equal(json.cwd, "/work/tree");
});

test("status keeps current evidence while history retains thought narration", () => {
  const id = "aku/worker/abcd0040";
  const thought = {
    kind: "thought" as const,
    sequence: 1,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text: "internal thought",
  };
  const completed = (sequence: number, command: string) => completedTool(sequence, "bash", { kind: "run", command });
  const active = (sequence: number, command: string) => startedTool(sequence, "bash", { kind: "run", command });

  const focusedEntries = [
    (thought),
    (completed(2, "c1")),
    (completed(3, "c2")),
    (completed(4, "c3")),
    (completed(5, "c4")),
    ({ kind: "note" as const, sequence: 6, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "between" }),
    (completed(7, "c5")),
    (completed(8, "c6")),
    (completed(9, "c7")),
    ({ kind: "said" as const, sequence: 10, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "after" }),
    (completed(11, "c8")),
    (active(12, "c9")),
  ];
  const snapshot = openRows(focusedEntries);
  const status = statusOf(id, "running", snapshot);
  const statusInvocation = parseArgv(["status", id]);
  assert.ok("command" in statusInvocation);
  const statusText = snapshotText(observation(status), DEFAULT_CONTEXT);
  assert.match(statusText, /12 run \$ c9/u, "the owner-selected current work remains visible");
  assert.deepEqual(observation(status).work.activeTools, [{ id: 12, turnSequence: 1, toolId: "tool-12" }]);

  const outcomeSnapshot = idleRows(
    [
      (completed(2, "c1")),
      (completed(3, "c2")),
      (completed(4, "c3")),
      (completed(5, "c4")),
      ({ kind: "note" as const, sequence: 6, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "between" }),
      (completed(7, "c5")),
      (completed(8, "c6")),
      (completed(9, "c7")),
      ({ kind: "said" as const, sequence: 10, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "after" }),
      (completed(11, "c8")),
      (completed(12, "c9")),
    ],
    answeredOutcome(13, "final outcome"),
  );
  const answeredStatus = liveStatusObservationSchema.unwrap().shape.status.parse({
    birth: DIRECT_BIRTH,
    id,
    life: "asleep",
    ...statusFields(outcomeSnapshot),
  });
  const outcomeText = snapshotText(observation(answeredStatus), DEFAULT_CONTEXT);
  assert.match(outcomeText, /answered turn\/1 · activity 13/u);

  const failedOutcome: OutcomeRow = {
    kind: "outcome",
    sequence: 13,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    outcome: { kind: "failed", diagnostic: "retained provider diagnostic" },
  };
  const failedText = snapshotText(
    observation(
      liveStatusObservationSchema.unwrap().shape.status.parse({
        birth: DIRECT_BIRTH,
        id,
        life: "asleep",
        ...statusFields(idleRows(outcomeSnapshot.filter(row => row.kind !== "outcome"), failedOutcome)),
      }),
    ),
    DEFAULT_CONTEXT,
  );
  assert.match(failedText, /failed turn\/1 · activity 13/u);

  const historyInvocation = parseArgv(["history", id]);
  assert.ok("command" in historyInvocation);
  const events = snapshot;
  const historyText = nativeHistoryText(
    {
      kind: "akuma",
      akumaId: status.id,
      events,
      omitted: 55,
      lowestRetainedSequence: 1,
      highestSequence: 12,
    },
    {},
    DEFAULT_CONTEXT,
  );
  assert.match(historyText, /internal thought/u, "history keeps retained thought narration");
  assert.match(historyText, /^ {3}··· +55 earlier events · showing last 13/mu);
  assert.doesNotMatch(historyText, /earlier turns/u);
  assert.doesNotMatch(historyText, /●/u, "history never asserts live activity");
  for (const command of ["c4", "c5", "c6", "c7"])
    assert.match(historyText, new RegExp(`\\$ ${command}`, "u"), `history keeps intermediate tool ${command}`);
});

test("Ask current work follows the native overlapping-tool frontier", () => {
  const id = parseAkumaId("aku/worker/abcd0104").id;
  const at = (minute: number) => `2026-08-10T00:${String(minute).padStart(2, "0")}:00.000Z`;
  const tool = (sequence: number, phase: "started" | "completed", name: string): TimelineFact =>
    phase === "completed"
      ? activityFact(sequence, 1, at(sequence), {
          type: "tool",
          phase: "completed",
          id: name,
          name: "bash",
          call: { kind: "run", command: name },
          result: { status: "ok" as const },
        })
      : activityFact(sequence, 1, at(sequence), {
          type: "tool",
          phase: "started",
          id: name,
          name: "bash",
          call: { kind: "run", command: name },
        });
  const first: TimelineFact[] = [
    { kind: "turn-start", sequence: 1, bodySequence: 1, startedAt: at(1) },
    { kind: "call", sequence: 2, turnSequence: 1, at: at(2), body: "first question" },
    tool(3, "started", "A"),
    {
      kind: "tell",
      sequence: 4,
      id: "tell/overlap",
      body: "another question",
      recordedAt: at(4),
      state: "told",
      deliveries: [],
    },
    tool(5, "started", "B"),
  ];
  const second = [
    ...first,
    tool(6, "completed", "B"),
    activityFact(7, 1, at(7), { type: "note", text: "between tools" }),
  ];
  const third = [...second, tool(8, "completed", "A")];
  const projection = (facts: readonly TimelineFact[]) => {
    const rows = facts.map(projectFact);
    return { status: statusOf(id, "running", rows), rows };
  };
  const context = { columns: 120, color: false };
  const line = (facts: readonly TimelineFact[]) => {
    const observed = projection(facts);
    return askCurrentWorkLine(
      { id, life: observed.status.life, summary: observed.status.work.summary },
      2_000,
      context,
    );
  };
  assert.match(line(first), /run \$ B/u);
  assert.match(line(second), /run \$ A/u);
  assert.match(line(third), /last observed running/u);
  assert.doesNotMatch(line(third), /\$ [AB]/u, "settled tools are no longer current work");
  const completions = third.map(projectFact).filter(row => row.kind === "tool" && row.phase === "completed");
  const history = nativeHistoryText({ kind: "akuma", akumaId: id, events: completions }, {}, context);
  assert.ok(history.indexOf("$ B") < history.indexOf("$ A"), "native history retains both completion identities in durable order");
});

test("a plural wait text renders compact facts, exact-turn outcomes and unreadable peers", () => {
  const first = parseAkumaId("aku/worker/abcd0006").id;
  const second = parseAkumaId("aku/worker/abcd0007").id;
  const missing = parseAkumaId("aku/worker/abcd0008").id;
  const text = nativeWaitText(
    {
      kind: "akuma",
      reason: "deadline",
      results: [
        {
          kind: "observed",
          id: first,
          life: "asleep",
          outcome: { kind: "answered", historyId: "turn/1", answer: "the answer" },
        },
        { kind: "observed", id: second, life: "running" },
        { kind: "unobserved", id: missing, diagnostic: "window lost" },
      ],
    },
    {},
    { columns: 120, color: false },
  );
  assert.equal(
    text,
    [`✓ ${first} — answered`, "  turn/1 · answered", "  the answer", `● ${second} — running`, `! ${missing} — observation failed · window lost`].join("\n"),
    "compact member facts with a complete labeled answer and an honest failure line",
  );
  assert.doesNotMatch(text, /of \d+ done/u, "no completion count and no scoreboard");
  assert.doesNotMatch(text, /waited|\d{2}:\d{2}|─/u, "no elapsed wait, clock, or status panel");
  assert.doesNotMatch(text, /\n\n/u, "no blank block separators");
});

test("an any-mode completion keeps an incomplete peer's own state honest", () => {
  const complete = liveStatusObservationSchema.unwrap().shape.status.parse({
    birth: DIRECT_BIRTH,
    id: "aku/worker/abcd0047",
    life: "asleep",
    ...statusFields(idleRows([])),
  });
  const pending = liveStatusObservationSchema.unwrap().shape.status.parse({
    birth: DIRECT_BIRTH,
    id: "aku/worker/abcd0048",
    life: "asleep",
    ...statusFields(openRows([
      {
        kind: "tell", sequence: 1, at: AKUMA_ACTIVITY_AT,
        tellId: "tell/pending-any", text: "still waiting", state: "pending", deliveries: [],
      },
    ])),
  });
  const results = [
    { kind: "observed" as const, id: complete.id, life: complete.life },
    { kind: "observed" as const, id: pending.id, life: pending.life, pending: true as const },
  ];
  const text = nativeWaitText({ kind: "akuma", reason: "completed", results }, {}, { columns: 120, color: false });
  assert.equal(
    text,
    [`✓ ${complete.id} — completed`, `⧗ ${pending.id} — pending tell`].join("\n"),
    "each peer keeps its own final state on one line",
  );
});

test("diagnostic payloads fold whitespace, wrap body-aligned, and expose bounded grapheme-safe omission", () => {
  assert.deepEqual(
    diagnosticLines("created debts", "  Unmigrated\tledger\n authority: /tmp/tasks  ", 32),
    ["! created debts unavailable", "  Unmigrated ledger authority:", "  /tmp/tasks"],
    "the subject never borrows the cause, and wrapping prefers a word boundary",
  );
  const lines = diagnosticLines("contract association", "👩‍💻".repeat(100), 32);
  assert.equal(lines[0], "! contract association unavailable");
  const payload = lines.slice(1);
  assert.equal(payload.length, 3, "diagnostics use the existing bounded payload budget");
  assert.ok(payload.every((line) => displayColumns(line) <= 32 && /^ {2}(?:👩‍💻)+…?$/u.test(line)));
  assert.match(payload.at(-1)!, /…$/u, "omission stays on the cause, not its subject");
});

test("terminal width counts grapheme clusters rather than code points", () => {
  const family = "👨‍👩‍👧‍👦";
  assert.equal([...family].length, 7, "a ZWJ family is seven code points in one cluster");
  assert.equal(displayColumns(family), 2, "a ZWJ sequence occupies one cell group");
  assert.equal(displayColumns("©"), 1, "a plain text symbol stays narrow");
  assert.equal(displayColumns("©️"), 2, "the emoji selector widens the same symbol");
  assert.equal(displayColumns("™"), 1, "an unselected letterlike symbol stays narrow");
  assert.equal(displayColumns("♥"), 1, "a text-presentation heart stays narrow");
  assert.equal(displayColumns("☀"), 1, "a text-presentation sun stays narrow");
  assert.equal(displayColumns("❤"), 1, "an emoji without its selector stays text width");
  assert.equal(displayColumns("✅"), 2, "an emoji that is wide by default needs no selector");
  assert.equal(displayColumns("🇺🇸"), 2, "a flag is one pair of regional indicators");
  assert.equal(displayColumns("❤️"), 2, "an emoji presentation selector widens its base");
  assert.equal(displayColumns("1️⃣"), 2, "a keycap is one cluster");
  assert.equal(displayColumns("👍🏽"), 2, "a skin tone modifier adds no cells");
  assert.equal(displayColumns("é"), 1, "a precomposed accented letter is one cell");
  assert.equal(displayColumns("e\u0301"), 1, "a combining mark adds no cell");
  assert.equal(displayColumns("\u0301"), 0, "an isolated mark occupies no cell");
  assert.equal(displayColumns(`a${family}b`), 4, "narrow text around a cluster keeps its cells");
  assert.equal(displayColumns("plain ascii"), 11, "ASCII keeps its own measure");
  assert.deepEqual(takeDisplayColumns(`a${family}b`, 3), { text: `a${family}`, rest: "b" });
  assert.deepEqual(takeDisplayColumns("🇺🇸x", 1), { text: "", rest: "🇺🇸x" }, "a cluster never splits");
  assert.deepEqual(takeDisplayColumns("e\u0301x", 1), { text: "e\u0301", rest: "x" });
  assert.equal(displayColumns(truncateDisplayText(family.repeat(3), 5)), 5, "ZWJ truncation keeps its cell width");
  assert.equal(
    truncateDisplayText(family.repeat(3), 5).includes("\uFFFD"),
    false,
    "ZWJ survives terminal-safe truncation",
  );
});

test("failed sections preserve each owner diagnostic", () => {
  const text = renderKanshiText(
    {
      kind: "world",
      observedAt: "2026-08-12T00:00:00.000Z",
      contracts: { kind: "failed", diagnostic: "contract read failed" },
      debts: { kind: "failed", diagnostic: "debt read failed", coordinate: "/work/debts" },
      akumas: { kind: "failed", diagnostic: "akuma read failed" },
    },
    { columns: 120, color: false },
  );
  assert.match(text, /CONTRACTS \/\/ unavailable\n\n! contract read failed/u);
  assert.match(text, /DEBTS \/\/ unavailable\n\n! \/work\/debts · failed debt read failed/u);
  assert.match(text, /AKUMA \/\/ unavailable\n\n! akuma read failed/u);
});

test("a failed selected Contract retains its identity and failure", () => {
  const text = renderKanshiText(
    {
      kind: "contract-failed",
      id: contractId("kei/verified-commit"),
      diagnostic: "status read failed",
    },
    { columns: 80, color: false },
  );
  assert.match(text, /status read failed/u);
  assert.match(text, /kei\/verified-commit/u);
});

test("a selected Contract renders its explicit held Debt and unavailable association", () => {
  const report = contractReport(contractDetail({ holder: "debt/held-work" }));
  assert.match(renderKanshiText(report, { columns: 120, color: false }), /holder  debt\/held-work/u);
  const failed = contractReport(contractDetail({ holder: { kind: "unavailable" } }));
  assert.match(renderKanshiText(failed, { columns: 120, color: false }), /holder  unavailable/u);
});
