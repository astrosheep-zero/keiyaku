import { projectCurrentWork } from "../src/akuma/status-projection.js";
import {
  acceptedReceipt,
  contractCatalog,
  contractDetail,
  contractReport,
  contractSummary,
  kanshiReport,
  cliJson,
  runCli,
} from "./support/cli-fixtures.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
} from "../src/core/facts/types.js";
import { dependencyKeySet } from "../src/core/subject.js";
import type { ReconcileCompletion } from "../src/library/reconcile.js";
import { renderAkumaNameCatalogue, renderContractCatalogue } from "../src/cli/render/catalog.js";
import {
  DEFAULT_CONTEXT,
  historyText as nativeHistoryText,
  snapshotText,
  waitText as nativeWaitText,
} from "../src/cli/render/akuma-activity.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import { liveStatusObservationSchema } from "../src/akuma/akuma-selection-execution.js";
import type { LiveStatusObservation } from "../src/akuma/akuma-observe.js";
import { type ActivityRow, type OutcomeRow, type ToolRow } from "../src/akuma/projection.js";
import type { AkumaObservation, ContractGateCurrent, DeliverOutcome, Placement, Placed } from "../src/index.js";
import { renderAkumaBoard } from "../src/cli/render/kanshi-akuma.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import { exactIndentedLines, previewLines } from "../src/cli/render/terminal.js";
import { evidenceLines } from "../src/cli/render/receipt.js";
import { renderRefusal } from "../src/cli/render/refusal.js";
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
import { activityFact, bornBody } from "./support/akuma-fixtures.js";
import { makeGitRepository } from "./support/git.js";
import { temporaryDirectory } from "./support/process.js";
import { contractMarkdown } from "./support/markdown.js";
import { projectFact } from "../src/akuma/projection.js";
import { appendActivity, beginTurn, type TimelineFact } from "../src/akuma/heart/index.js";
import type { Settings } from "../src/settings.js";
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
      { id: "turn/1" }
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

/** Shared text projection context for the native Contract result family. */
const RECEIPT_CONTEXT = { columns: 120, color: false } as const;

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
const genericLines = (rows: readonly GenericFixture[]) =>
  nativeHistoryText({ kind: "akuma", akumaId: parseAkumaId("aku/worker/abcd1234").id,
    events: rows.map(([sequence, name, input]) => genericTool(sequence, name, input)),
  }, {}).split("\n").slice(1);
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
  const long = "👩‍💻".repeat(161);
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
  assert.match(denied, /^  review summary\n    Fix missing coverage$/mu);
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
  assert.match(claimed, /^  review summary\n    [^\n]+…$/mu);
  assert.doesNotMatch(claimed, /landed|predecessor|method|content identity|target moved/u);
  const abandoned = show({ ...base, phase: "abandoned", abandonNote: long });
  assert.match(abandoned, /· abandoned ·/u);
  assert.match(abandoned, /^  note\n    [^\n]+…$/mu);
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
  const texts = [
    renderVerb(
      "bind",
      { terms: "# Bound" },
      { kind: "returned", value: acceptedReceipt("bind", { contractId: id }) },
      RECEIPT_CONTEXT,
    ),
    renderVerb(
      "amend",
      { contract: id },
      { kind: "returned", value: acceptedReceipt("amend", { contractId: id }) },
      RECEIPT_CONTEXT,
    ),
    renderVerb(
      "arc",
      { contract: id, body: "# Two" },
      { kind: "returned", value: acceptedReceipt("arc", { contractId: id, chapter: 2 }) },
      RECEIPT_CONTEXT,
    ),
    renderVerb(
      "abandon",
      { contract: id, note: "Scope retired" },
      { kind: "returned", value: acceptedReceipt("abandon", { contractId: id }) },
      RECEIPT_CONTEXT,
    ),
    renderVerb(
      "deliver",
      { contract: id },
      { kind: "returned", value: acceptedReceipt("deliver", { contractId: id, ...deliveryIdentity() }) },
      RECEIPT_CONTEXT,
    ),
    renderVerb(
      "review",
      { contract: id, verdict: "satisfied", summary: "looks right" },
      { kind: "returned", value: acceptedReceipt("review", { contractId: id }) },
      RECEIPT_CONTEXT,
    ),
  ];
  assert.deepEqual(
    texts.map((text) => text.split("\n")[0]),
    [
      `bind accepted  ${id}`,
      `amend accepted  ${id}`,
      `arc accepted  ${id}`,
      `abandon accepted  ${id}`,
      `deliver accepted  ${id}`,
      `review accepted  ${id} · satisfied`,
    ],
  );
  assert.match(texts[2]!, /^ {2}chapter {2}2$/mu);
  assert.match(texts[3]!, /^ {2}note\n {2}Scope retired$/mu);
  for (const text of texts) assert.ok(text.includes(id));
});

test("exact indented content preserves source lines and its full tail", () => {
  const line = "a".repeat(800);
  const lines = exactIndentedLines(`${line}\n${"\n".repeat(101)}  tail\n`, "  ");
  assert.equal(lines[0], `  ${line}`);
  assert.deepEqual(lines.slice(1, 102), Array(101).fill(""));
  assert.deepEqual(lines.slice(102), ["    tail", ""]);
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
  const text = renderVerb("reconcile", { contract: reconcileId }, { kind: "returned", value: result }, RECEIPT_CONTEXT);
  assert.equal(text.split("\n")[0], `reconcile failed  ${reconcileId}`);
  assert.match(text, /^ {2}issue {2}worktree retained$/mu);
  assert.match(text, /^ {2}path {2}\/tmp\/wt$/mu);
  assert.match(text, /^ {2}diagnostic\n {2}scratch removal failed$/mu);
  assert.match(text, /^ {2}issue {2}worktree hook failed$/mu);
  assert.match(text, /^ {2}name {2}"cleanup"$/mu);
  assert.match(text, /^ {2}phase {2}destroy$/mu);
  assert.match(text, /^ {2}diagnostic\n {2}exit 7$/mu);
  assert.doesNotMatch(text, /worktree-retained/u);
});

test("Verification receipts expose retained scratch and its cleanup diagnostic", () => {
  const result = acceptedReceipt("verify", {
    contractId: contractId("kei/residue"),
    snapshot: snapshotId("verified-snapshot"),
    checks: [],
    issues: [{ kind: "diagnostic", severity: "optional", path: "/tmp/scratch", diagnostic: "cleanup failed" }],
  });
  const text = renderVerb("verify", { contract: contractId("kei/residue") }, { kind: "returned", value: result }, RECEIPT_CONTEXT);
  assert.match(text, /^ {2}issue {2}diagnostic$/mu);
  assert.match(text, /^ {2}path {2}\/tmp\/scratch$/mu);
  assert.match(text, /^ {2}diagnostic\n {2}cleanup failed$/mu);
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
  const text = renderVerb(
    "deliver",
    { contract: contractId("kei/preview"), dryRun: true },
    { kind: "returned", value: result },
    RECEIPT_CONTEXT,
  );
  assert.equal(text.split("\n")[0], "deliver --dry-run accepted  kei/preview");
  assert.match(text, /^ {2}gate {2}verified$/mu);
  assert.match(text, /^ {2}requirement {2}historical-check$/mu);
  assert.match(text, /^ {2}state {2}unsatisfied$/mu);
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
  assert.match(
    renderVerb("amend", { contract }, { kind: "returned", value: base }, RECEIPT_CONTEXT),
    /^amend accepted {2}kei\/gate-only\n {2}terms {2}unchanged$/u,
  );
  const gates = renderVerb(
    "amend",
    { contract },
    { kind: "returned", value: acceptedReceipt("amend", { contractId: contract, gatesChanged: true }) },
    RECEIPT_CONTEXT,
  );
  assert.match(gates, /^amend accepted  kei\/gate-only\n  gates  changed\n  admitted  amend$/u);
  assert.doesNotMatch(gates, /terms {2}unchanged/u);
  assert.match(
    renderVerb(
      "amend",
      { contract },
      { kind: "returned", value: acceptedReceipt("amend", { contractId: contract, afterChanged: true }) },
      RECEIPT_CONTEXT,
    ),
    /^ {2}after {2}changed$/mu,
  );
});

test("amend summarizes changed sections and independently changed obligations", () => {
  const text = renderVerb(
    "amend",
    { contract: contractId("kei/changed-terms") },
    {
      kind: "returned",
      value: acceptedReceipt("amend", {
        contractId: contractId("kei/changed-terms"),
        changedSections: ["Design", "Criteria"],
        gatesChanged: true,
        afterChanged: true,
      }),
    },
    RECEIPT_CONTEXT,
  );
  assert.match(text, /^ {2}changed section {2}Design$/mu);
  assert.match(text, /^ {2}changed section {2}Criteria$/mu);
  assert.match(text, /^ {2}gates {2}changed$/mu);
  assert.match(text, /^ {2}after {2}changed$/mu);
  assert.match(text, /^ {2}admitted {2}amend$/mu);
  assert.doesNotMatch(text, /terms {2}unchanged/u);
});

test("receipt identities stay complete and distinct in text and in JSON", () => {
  const contract = contractId("kei/identity");
  const tender = snapshotId("a".repeat(40));
  const integration = snapshotId("b".repeat(40));
  const result = acceptedReceipt("deliver", {
    contractId: contract,
    ...deliveryIdentity(tender),
    ...placedDelivery(integration, tender),
  });
  const text = renderVerb("deliver", { contract }, { kind: "returned", value: result }, RECEIPT_CONTEXT);
  assert.match(text, new RegExp(`^ {2}candidate {2}${tender}$`, "mu"));
  assert.match(text, new RegExp(`^ {2}integration result {2}${integration}$`, "mu"));
  assert.match(text, /^ {2}content identity {2}0{40}$/mu);
  assert.match(text, /^ {2}destination {2}refs\/heads\/main$/mu);
  assert.match(text, new RegExp(`^ {2}before {2}${tender}$`, "mu"));
  assert.match(text, new RegExp(`^ {2}after {2}${integration}$`, "mu"));
  assert.doesNotMatch(text, /[.]{2,}/u, "no abbreviated identity pair survives in text");
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
  const counted = renderVerb("deliver", { contract, dryRun: true }, { kind: "returned", value: base }, RECEIPT_CONTEXT);
  assert.match(counted, /^ {2}target {2}placeable$/mu);
  assert.match(counted, /^ {2}reference {2}refs\/heads\/main$/mu);
  assert.match(counted, new RegExp(`^ {2}head {2}${head}$`, "mu"));
  assert.match(counted, /^ {2}behind {2}3$/mu);
  const unknown = renderVerb(
    "deliver",
    { contract, dryRun: true },
    {
      kind: "returned",
      value: { ...base, target: { kind: "placeable", ref: "refs/heads/main", head, behind: "unknown" } },
    },
    RECEIPT_CONTEXT,
  );
  assert.match(unknown, /^ {2}behind {2}unknown$/mu);
  assert.doesNotMatch(unknown, /behind 3|not.run|undeclared/u);
});

test("receipt hashes keep colliding identities whole instead of extending prefixes", () => {
  const contract = contractId("kei/hash-collision");
  const tender = snapshotId(`${"a".repeat(7)}0${"0".repeat(32)}`);
  const integration = snapshotId(`${"a".repeat(7)}1${"0".repeat(32)}`);
  const text = renderVerb(
    "deliver",
    { contract },
    {
      kind: "returned",
      value: acceptedReceipt("deliver", {
        contractId: contract,
        ...deliveryIdentity(tender),
        ...placedDelivery(integration, tender),
      }),
    },
    RECEIPT_CONTEXT,
  );
  assert.match(text, new RegExp(`^ {2}candidate {2}aaaaaaa0${"0".repeat(32)}$`, "mu"));
  assert.match(text, new RegExp(`^ {2}after {2}aaaaaaa1${"0".repeat(32)}$`, "mu"));
});

test("reconcile preserves repeated native effects without null sentinels", () => {
  const ref = {
    kind: "ref" as const,
    name: "refs/keiyaku/delivery/example",
    before: "a".repeat(40),
    after: null,
  };
  const text = renderVerb(
    "reconcile",
    { contract: reconcileId },
    { kind: "returned", value: reconcile({ effects: [ref, ref] }) },
    RECEIPT_CONTEXT,
  );
  const effect = [
    "  effect  ref",
    "  reference  refs/keiyaku/delivery/example",
    `  before  ${"a".repeat(40)}`,
    "  after  absent",
  ];
  assert.deepEqual(text.split("\n"), [`reconcile accepted  ${reconcileId}`, ...effect, ...effect]);
  assert.doesNotMatch(text, /null/u);
});

test("reconcile recovery snapshots keep their complete Git identity", () => {
  const snapshot = snapshotId("f".repeat(40));
  const text = renderVerb(
    "reconcile",
    { contract: reconcileId },
    { kind: "returned", value: reconcile({ effects: [{ kind: "recovery-snapshot", snapshot }] }) },
    RECEIPT_CONTEXT,
  );
  assert.match(text, /^ {2}effect {2}recovery snapshot$/mu);
  assert.match(text, new RegExp(`^ {2}recovery snapshot {2}${snapshot}$`, "mu"));
});

test("reconcile renders a healthy no-op as its native conclusion alone", () => {
  const result = reconcile({});
  assert.equal(
    renderVerb("reconcile", { contract: reconcileId }, { kind: "returned", value: result }, RECEIPT_CONTEXT),
    `reconcile accepted  ${reconcileId}`,
  );
});

test("reconcile failure keeps its native issue and diagnostic", () => {
  const result = reconcile({
    issues: [
      {
        kind: "reconcile-failed",
        severity: "required",
        diagnostic: "git failed",
      },
    ],
  });
  assert.deepEqual(
    renderVerb("reconcile", { contract: reconcileId }, { kind: "returned", value: result }, RECEIPT_CONTEXT).split("\n"),
    [`reconcile failed  ${reconcileId}`, "  issue  reconcile failed", "  diagnostic", "  git failed"],
  );
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
  const text = renderVerb("reconcile", { contract: reconcileId }, { kind: "returned", value: result }, RECEIPT_CONTEXT);
  assert.match(text, /^ {2}issue {2}worktree hook failed$/mu);
  assert.match(text, /^ {2}path {2}\/tmp\/wt$/mu);
  assert.match(text, /^ {2}name {2}"prepare"$/mu);
  assert.match(text, /^ {2}phase {2}create$/mu);
  assert.match(text, /^ {2}diagnostic\n {2}exit 7\n {2}hook failed$/mu);
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
  const text = renderVerb("reconcile", { contract: reconcileId }, { kind: "returned", value: result }, RECEIPT_CONTEXT);
  assert.match(text, /^ {2}issue {2}target checkout retained$/mu);
  assert.match(text, /^ {2}target {2}refs\/heads\/main$/mu);
  assert.match(text, /^ {2}path {2}\/repo\/file$/mu);
  assert.match(text, /^ {2}diagnostic\n {2}checkout failed$/mu);
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
  const text = renderVerb("reconcile", { contract: reconcileId }, { kind: "returned", value: result }, RECEIPT_CONTEXT);
  assert.match(text, /^reconcile failed {2}kei\/reconciled$/mu);
  assert.match(text, /^ {2}issue {2}diagnostic$/mu);
  assert.match(text, /^ {2}diagnostic\n {2}could not close publication seat$/mu);
});

test("CLI bind receipt keeps native hook diagnostics through their recovery text", async (t) => {
  const repo = makeGitRepository();
  repo.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const home = temporaryDirectory(t, "keiyaku-hook-receipt-home-");
  const diagnostic = `${"upstream output\n".repeat(100)}  inspect the recovery log: /retained/hook.log`;
  mkdirSync(join(repo.path, ".keiyaku"), { recursive: true });
  writeFileSync(join(repo.path, ".keiyaku", "settings.json"), JSON.stringify({
    worktree: { create: [{ name: "prepare", timeoutMs: 5000,
      argv: [process.execPath, "-e", `process.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode = 9`],
    }] },
  }));
  const receipt = await runCli(["-C", repo.path, "bind", "-"], {
    cwd: repo.path, environment: { HOME: home, USERPROFILE: home, KEIYAKU_HOME: home },
    readStdin: async () => contractMarkdown("Hook recovery receipt", {
      Context: "A local managed hook failed.", Objective: "Expose its supplied diagnostic.",
      Design: "Reconcile one appointment.", Region: "file.txt", Criteria: "### Recovery\nKeep the hook evidence.",
    }),
  });
  assert.equal(receipt.exit, 3, receipt.stderr || receipt.stdout);
  assert.match(receipt.stdout, /^  admitted  bind$/mu);
  assert.match(receipt.stdout, /^  issue  worktree hook failed$/mu);
  const payload = ["exit 9", "stderr:", ...diagnostic.split("\n")].map((line) => `  ${line}`).join("\n");
  assert.ok(receipt.stdout.includes(`  diagnostic\n${payload}`));
  assert.doesNotMatch(receipt.stdout, /^  available  /mu, "hook prose is not interpreted as a recovery call");
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
  const text = renderVerb("reconcile", { contract: reconcileId }, { kind: "returned", value: result }, RECEIPT_CONTEXT);
  assert.match(text, /^ {2}issue {2}contract file failed$/mu);
  assert.match(text, /^ {2}path {2}\.keiyaku\/KEIYAKU\.md$/mu);
  assert.match(text, /^ {2}diagnostic\n {2}write failed$/mu);
  assert.match(text, /^ {2}issue {2}settlement failed$/mu);
  assert.match(text, /^ {2}diagnostic\n {2}debt failed$/mu);
});

test("world reconcile failure renders its diagnostic", () => {
  const result = { kind: "world-observation-failed", diagnostic: "git failed" } as const;
  assert.deepEqual(
    renderVerb("reconcile", {}, { kind: "returned", value: result }, RECEIPT_CONTEXT).split("\n"),
    ["reconcile failed", "  diagnostic", "  git failed"],
  );
});

test("Verification create action names stay exact and distinct in text receipts", () => {
  const contract = contractId("kei/hostile-create-name");
  for (const name of ["prepare\nphase\u001b[31m", "prepare phase\u001b[31m"]) {
    const result = acceptedReceipt("verify", {
      contractId: contract,
      snapshot: snapshotId("snapshot"),
      checks: [{
        kind: "stopped",
        index: 1,
        requirement: "check-one",
        stop: { kind: "environment-hook-failure", name, diagnostic: "exit 17" },
      }],
    });
    const text = renderVerb("verify", { contract }, { kind: "returned", value: result }, RECEIPT_CONTEXT);
    const prefix = "  name  ";
    const nameLine = text.split("\n").find((line) => line.startsWith(prefix));
    assert.ok(nameLine);
    assert.equal(JSON.parse(nameLine.slice(prefix.length)), name);
    assert.doesNotMatch(text, /\u001b/u);
  }
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

  const text = renderVerb("verify", { contract }, { kind: "returned", value: result }, RECEIPT_CONTEXT);
  const prefix = "  name  ";
  const nameLine = text.split("\n").find((line) => line.startsWith(prefix));
  assert.ok(nameLine);
  assert.equal(JSON.parse(nameLine.slice(prefix.length)), name);
  assert.doesNotMatch(text, /[\r\u001b]/u);
});

test("accepted results preserve reconciliation lag without telemetry", () => {
  const contract = contractId("kei/followed");
  const lag = {
    kind: "worktree-follow-retained" as const,
    severity: "optional" as const,
    path: "/tmp/wt",
    reason: "head-moved" as const,
  };
  const text = renderVerb(
    "deliver",
    { contract },
    {
      kind: "returned",
      value: acceptedReceipt("deliver", { contractId: contract, issues: [lag], ...deliveryIdentity() }),
    },
    RECEIPT_CONTEXT,
  );
  assert.deepEqual(text.split("\n"), [
    "deliver accepted  kei/followed",
    "  candidate  tender",
    "  integration result  integration",
    "  content identity  0000000000000000000000000000000000000000",
    "  admitted  deliver",
    "  issue  worktree follow retained",
    "  path  /tmp/wt",
    "  detail  head moved",
  ]);
  assert.doesNotMatch(text, /elapsed|duration|milliseconds/u);
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
  assert.deepEqual(
    renderVerb("bind", { terms: "# Bound" }, { kind: "returned", value: result }, RECEIPT_CONTEXT).split("\n"),
    [
      "bind failed  kei/bound",
      "  workspace  /tmp/wt",
      "  admitted  bind",
      "  issue  diagnostic",
      "  diagnostic",
      "  seat close failed after publication",
    ],
  );
});

test("delivery distinguishes reused admission and keeps fresh input notes in context", () => {
  const contract = contractId("kei/delivery-admission");
  const fields = {
    contractId: contract,
    ...deliveryIdentity(snapshotId("tender-commit")),
    contentId: changeId("content-id"),
  };
  const fresh = renderVerb(
    "deliver",
    { contract, message: "fresh delivery" },
    { kind: "returned", value: acceptedReceipt("deliver", fields) },
    RECEIPT_CONTEXT,
  );
  assert.match(fresh, /^ {2}candidate {2}tender-commit$/mu);
  assert.match(fresh, /^ {2}content identity {2}content-id$/mu);
  assert.match(fresh, /^ {2}admitted {2}deliver$/mu);
  assert.match(fresh, /^ {2}note\n {2}fresh delivery$/mu);
  const reused = renderVerb(
    "deliver",
    { contract, message: "not newly admitted" },
    { kind: "returned", value: acceptedReceipt("deliver", { ...fields, admission: "reused" }) },
    RECEIPT_CONTEXT,
  );
  assert.match(reused, /^ {2}admission {2}reused$/mu);
  assert.doesNotMatch(reused, /not newly admitted/u);
  assert.doesNotMatch(reused, /admitted {2}deliver/u, "a reused admission is not a fresh one");
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
  const listed: readonly string[] = [
    "  reason  prerequisites unsatisfied",
    "  prerequisite  kei/active-prerequisite",
    "  state  active",
    "  prerequisite  kei/abandoned-prerequisite",
    "  state  abandoned",
    "  prerequisite  kei/missing-prerequisite",
    "  state  missing",
  ];
  const delivered = renderVerb(
    "deliver",
    { contract },
    { kind: "returned", value: acceptedReceipt("deliver", { contractId: contract, ...deliveryIdentity(), placement }) },
    RECEIPT_CONTEXT,
  ).split("\n");
  assert.equal(delivered[0], "deliver accepted  kei/waiting-on-prerequisites");
  assert.deepEqual(delivered.slice(-7), listed);

  const reviewed = renderVerb(
    "review",
    { contract, verdict: "satisfied", summary: "reviewed" },
    { kind: "returned", value: acceptedReceipt("review", { contractId: contract, placement }) },
    RECEIPT_CONTEXT,
  ).split("\n");
  assert.equal(reviewed[0], "review accepted  kei/waiting-on-prerequisites · satisfied");
  assert.deepEqual(reviewed.slice(-7), listed);
});

test("a satisfied review whose placement fails names the satisfied fact once and refuses in outcome words", () => {
  const contract = contractId("kei/review-refused-f911");
  const text = renderVerb(
    "review",
    { contract, verdict: "satisfied", summary: "reviewed the diff" },
    {
      kind: "returned",
      value: acceptedReceipt("review", {
        contractId: contract,
        placement: {
          kind: "failed",
          diagnostic: "fatal: could not read from remote repository",
        },
      }),
    },
    RECEIPT_CONTEXT,
  );
  assert.deepEqual(text.split("\n"), [
    "review failed  kei/review-refused-f911 · satisfied",
    "  admitted  review",
    "  reason  failed",
    "  diagnostic",
    "  fatal: could not read from remote repository",
  ]);
  assert.equal((text.match(/satisfied/gu) ?? []).length, 1, "the satisfied fact prints once");
  assert.doesNotMatch(text, /placement|continuation|reconciliation/u, "no internal phase name appears");
});

test("a gates-refused placement keeps each requirement's evidence and native state", () => {
  const contract = contractId("kei/blocked-review");
  const text = renderVerb(
    "deliver",
    { contract },
    {
      kind: "returned",
      value: acceptedReceipt("deliver", {
        contractId: contract,
        ...deliveryIdentity(),
        placement: {
          kind: "gates-unsatisfied",
          unmet: [
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
          ],
        },
      }),
    },
    RECEIPT_CONTEXT,
  );
  assert.deepEqual(text.split("\n").slice(-12), [
    "  reason  gates unsatisfied",
    "  gate  verified",
    "  requirement  check-one",
    "  state  unsatisfied",
    "  summary",
    "  [1 bash exit 1]",
    "  gate  reviewed",
    "  requirement  gate:reviewed",
    "  state  stale",
    "  gate  manual",
    "  requirement  gate:manual",
    "  state  missing",
  ]);
  assert.doesNotMatch(text, /awaiting/u, "no await tail is synthesized from native state");
  assert.doesNotMatch(text, /gates-unsatisfied/u, "no refusal kind prints");
});

test("a stale requirement keeps its native state without an invented await", () => {
  const contract = contractId("kei/two-missing");
  const text = renderVerb(
    "deliver",
    { contract },
    {
      kind: "returned",
      value: acceptedReceipt("deliver", {
        contractId: contract,
        ...deliveryIdentity(),
        placement: {
          kind: "gates-unsatisfied",
          unmet: [
            { gate: gate("reviewed"), requirement: requirementId("gate:reviewed"), state: "missing" },
            { gate: gate("verified"), requirement: requirementId("check-one"), state: "stale" },
          ],
        },
      }),
    },
    RECEIPT_CONTEXT,
  );
  assert.deepEqual(text.split("\n").slice(-6), [
    "  gate  reviewed",
    "  requirement  gate:reviewed",
    "  state  missing",
    "  gate  verified",
    "  requirement  check-one",
    "  state  stale",
  ]);
  assert.doesNotMatch(text, /awaiting/u, "a stale requirement is evidence, not a waiting event");
});

test("four or more unmet requirements still name every one", () => {
  const contract = contractId("kei/many-missing");
  const names = ["a", "b", "c", "d"];
  const text = renderVerb(
    "deliver",
    { contract },
    {
      kind: "returned",
      value: acceptedReceipt("deliver", {
        contractId: contract,
        ...deliveryIdentity(),
        placement: {
          kind: "gates-unsatisfied",
          unmet: names.map((name) => ({
            gate: gate(name),
            requirement: requirementId(`gate:${name}`),
            state: "missing" as const,
          })),
        },
      }),
    },
    RECEIPT_CONTEXT,
  );
  assert.deepEqual(
    text.split("\n").filter((line) => line.startsWith("  requirement  ")),
    names.map((name) => `  requirement  gate:${name}`),
  );
  assert.doesNotMatch(text, /awaiting|omitted/u, "every native requirement stays visible");
});

test("an admitted delivery retains the native unsatisfied gate state", () => {
  const contract = contractId("kei/recorded-only");
  const value = acceptedReceipt("deliver", {
    contractId: contract, ...deliveryIdentity(),
    placement: { kind: "gates-unsatisfied", unmet: [
      { gate: gate("verified"), requirement: requirementId("check-one"), state: "unsatisfied" },
    ] },
  });
  const text = renderVerb("deliver", { contract }, { kind: "returned", value }, RECEIPT_CONTEXT);
  assert.match(text, /^deliver accepted  kei\/recorded-only$/mu);
  assert.match(text, /reason  gates unsatisfied\n  gate  verified\n  requirement  check-one\n  state  unsatisfied$/u);
});

test("an unsatisfied review records its supplied verdict without claiming placement", () => {
  const contract = contractId("kei/review-unsatisfied");
  const text = renderVerb("review", { contract, verdict: "unsatisfied", summary: "Review found a defect" }, {
    kind: "returned", value: acceptedReceipt("review", { contractId: contract }),
  }, RECEIPT_CONTEXT);
  assert.equal(text, `review accepted  ${contract} · unsatisfied\n  admitted  review`);
});

test("completion stops project an ignored-checkout refusal fact", () => {
  const contract = contractId("kei/checkout-followability");
  const value = acceptedReceipt("deliver", {
    contractId: contract, ...deliveryIdentity(),
    placement: {
      kind: "checkout-not-followable", target: "refs/heads/main",
      path: "/repo/checkout", paths: ["ignored.tmp", 'quote"path.tmp'],
    },
  });
  const rendered = renderVerb("deliver", { contract }, { kind: "returned", value }, RECEIPT_CONTEXT);
  assert.match(rendered, /^deliver failed  kei\/checkout-followability$/mu);
  assert.deepEqual(rendered.split("\n").slice(-5), [
    "  reason  checkout not followable", "  target  refs/heads/main", "  path  /repo/checkout",
    "  path  ignored.tmp", '  path  quote"path.tmp',
  ]);
});

test("continuation checkout stop keeps its exact block after the dependent context", () => {
  const contract = contractId("kei/prerequisite-checkout");
  const dependent = contractId("kei/stopped-checkout-dependent");
  const value = acceptedReceipt("deliver", {
    contractId: contract, ...deliveryIdentity(),
    ...placedDelivery(snapshotId("2".repeat(40)), snapshotId("1".repeat(40))),
    continuation: { stopped: [{ contractId: dependent, stop: {
      kind: "checkout-not-followable", target: "refs/heads/main",
      path: "/repo/checkout", paths: ['quote"path.ts'],
    } }] },
  });
  const text = renderVerb("deliver", { contract }, { kind: "returned", value }, RECEIPT_CONTEXT);
  assert.deepEqual(text.split("\n").slice(-6), [
    "  placement  placed", `  dependent  ${dependent}`, "  reason  checkout not followable",
    "  target  refs/heads/main", "  path  /repo/checkout", '  path  quote"path.ts',
  ]);
});

test("retry stops keep their distinct native reasons and publication diagnostic", () => {
  assert.deepEqual(evidenceLines({ kind: "retry", reason: "exhausted" }), ["  reason  retry", "  detail  exhausted"]);
  assert.deepEqual(evidenceLines({ kind: "retry", reason: "collision" }), ["  reason  retry", "  detail  collision"]);
  assert.deepEqual(evidenceLines({ kind: "retry", reason: "publication-failed", diagnostic: "fatal: unable to create lock" }), [
    "  reason  retry", "  detail  publication failed", "  diagnostic", "  fatal: unable to create lock",
  ]);
});

test("a retry placement stop keeps the leading delivery admission", () => {
  const contract = contractId("kei/retry-stops-receipt");
  const value = acceptedReceipt("deliver", {
    contractId: contract, ...deliveryIdentity(),
    placement: { kind: "retry", reason: "publication-failed", diagnostic: "fatal: unable to create lock" },
  });
  const text = renderVerb("deliver", { contract }, { kind: "returned", value }, RECEIPT_CONTEXT);
  assert.match(text, /^deliver retryable  kei\/retry-stops-receipt$/mu);
  assert.match(text, /admitted  deliver\n  reason  retry\n  detail  publication failed\n  diagnostic\n  fatal: unable to create lock$/u);
});

test("a dependent conflict retains the child subject without a parent or fresh-tender recovery call", () => {
  const contract = contractId("kei/completed-parent");
  const dependent = contractId("kei/conflicted-dependent");
  const targetHead = snapshotId("b".repeat(40));
  const value = acceptedReceipt("deliver", {
    contractId: contract, ...deliveryIdentity(), ...placedDelivery(),
    continuation: { stopped: [{ contractId: dependent, stop: {
      kind: "integration-conflict", targetHead, conflictPaths: ["candidate.txt"],
    } }] },
  });
  const text = renderVerb("deliver", { contract }, { kind: "returned", value }, {
    ...RECEIPT_CONTEXT, recoveryCoordinates: { cwd: "/repo" },
  });
  assert.match(text, /dependent  kei\/conflicted-dependent\n  reason  integration conflict/u);
  assert.ok(text.includes(`  target head  ${targetHead}\n  conflict  candidate.txt`));
  assert.doesNotMatch(text, /^  available  /mu);
});

test("delivery and review share confirmed placement evidence without claiming check execution", () => {
  const delivery = contractId("kei/completion");
  const review = contractId("kei/placement-reuse");
  const delivered = renderVerb("deliver", { contract: delivery }, {
    kind: "returned", value: acceptedReceipt("deliver", { contractId: delivery, ...deliveryIdentity(), ...placedDelivery() }),
  }, RECEIPT_CONTEXT);
  const reviewed = renderVerb("review", { contract: review, verdict: "satisfied", summary: "Confirmed" }, {
    kind: "returned", value: acceptedReceipt("review", { contractId: review, placement: movement() }),
  }, RECEIPT_CONTEXT);
  const expected = [
    "  destination  refs/heads/main", `  before  ${"3".repeat(40)}`, `  after  ${"4".repeat(40)}`, "  placement  placed",
  ];
  for (const text of [delivered, reviewed]) {
    assert.deepEqual(text.split("\n").slice(-4), expected);
    assert.doesNotMatch(text, /^  check  /mu);
  }
});

test("a deliver receipt keeps candidate, integration and content identities distinct", () => {
  const contract = contractId("kei/standalone-subject");
  const value = acceptedReceipt("deliver", {
    contractId: contract, candidate: snapshotId("b".repeat(40)),
    integration: snapshotId("d".repeat(40)), contentId: changeId("c".repeat(40)),
  });
  const text = renderVerb("deliver", { contract }, { kind: "returned", value }, RECEIPT_CONTEXT);
  assert.deepEqual(text.split("\n").slice(1, 4), [
    `  candidate  ${value.candidate}`, `  integration result  ${value.integration}`, `  content identity  ${value.contentId}`,
  ]);
});

test("a retained worktree path stays visible in terminal and nonterminal receipts", () => {
  const contract = contractId("kei/retained-worktree");
  const issues = [{ kind: "worktree-retained" as const, severity: "optional" as const, path: "/tmp/wt" }];
  const terminal = renderVerb("abandon", { contract }, {
    kind: "returned", value: acceptedReceipt("abandon", { contractId: contract, issues }),
  }, RECEIPT_CONTEXT);
  const nonterminal = renderVerb("review", { contract, verdict: "satisfied", summary: "Confirmed" }, {
    kind: "returned", value: acceptedReceipt("review", { contractId: contract, issues }),
  }, RECEIPT_CONTEXT);
  for (const text of [terminal, nonterminal]) {
    assert.match(text, /accepted  kei\/retained-worktree/u);
    assert.match(text, /^  issue  worktree retained\n  path  \/tmp\/wt$/mu);
  }
});

test("every supplied checkout lag remains visible even without placement", () => {
  const contract = contractId("kei/retained-checkout");
  const issues = ["/repo", "/repo/.keiyaku/wt/fridge"].map((path) => ({
    kind: "target-checkout-retained" as const, severity: "required" as const,
    path, target: "refs/heads/main", diagnostic: "kept",
  }));
  for (const placement of [movement(), undefined]) {
    const value = acceptedReceipt("review", { contractId: contract, issues, ...(placement === undefined ? {} : { placement }) });
    const text = renderVerb("review", { contract, verdict: "satisfied", summary: "Confirmed" }, {
      kind: "returned", value,
    }, RECEIPT_CONTEXT);
    assert.match(text, /^review failed  kei\/retained-checkout · satisfied$/mu);
    assert.equal(text.includes("  placement  placed"), placement !== undefined);
    assert.deepEqual(text.split("\n").filter((line) => line.startsWith("  path  ")), [
      "  path  /repo", "  path  /repo/.keiyaku/wt/fridge",
    ]);
    assert.equal(text.split("  issue  target checkout retained").length - 1, 2);
  }
});

test("deliver renders accepted and stopped continuations from the accepted result", () => {
  const contract = contractId("kei/prerequisite");
  const claimed = contractId("kei/claimed-dependent");
  const stopped = contractId("kei/stopped-dependent");
  const value = acceptedReceipt("deliver", {
    contractId: contract, ...deliveryIdentity(), ...placedDelivery(),
    continuation: { claimed: [claimed], stopped: [{ contractId: stopped, stop: {
      kind: "gates-unsatisfied", unmet: [{ gate: gate("reviewed"), requirement: requirementId("gate:reviewed"), state: "missing" }],
    } }] },
  });
  const text = renderVerb("deliver", { contract }, { kind: "returned", value }, RECEIPT_CONTEXT);
  assert.deepEqual(text.split("\n").slice(-7), [
    "  placement  placed", `  dependent placed  ${claimed}`, `  dependent  ${stopped}`,
    "  reason  gates unsatisfied", "  gate  reviewed", "  requirement  gate:reviewed", "  state  missing",
  ]);
});

test("movement preserves final placement and an exhausted target-movement stop", () => {
  const contract = contractId("kei/reintegrated");
  const placed = acceptedReceipt("deliver", {
    contractId: contract, ...deliveryIdentity(), ...placedDelivery(snapshotId("integration-4"), snapshotId("target-3")),
  });
  const complete = renderVerb("deliver", { contract }, { kind: "returned", value: placed }, RECEIPT_CONTEXT);
  assert.match(complete, /before  target-3\n  after  integration-4\n  placement  placed$/u);
  const value = acceptedReceipt("deliver", {
    contractId: contract, ...deliveryIdentity(),
    placement: { kind: "target-moved", target: "refs/heads/main", integration: snapshotId("integration-2"), observed: null },
  });
  const stopped = renderVerb("deliver", { contract }, { kind: "returned", value }, RECEIPT_CONTEXT);
  assert.match(stopped, /^deliver failed  kei\/reintegrated$/mu);
  assert.match(stopped, /admitted  deliver\n  reason  target moved\n  target  refs\/heads\/main\n  observed  absent\n  integration result  integration-2$/u);
});

test("a multi-line invalid-document diagnostic preserves both causes", () => {
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
      "bind refused",
      "  reason  invalid document",
      "  diagnostic",
      "  contract document is missing ## Design",
      "  contract document is missing ## Region",
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
  const text = renderVerb("deliver", { contract: result.contractId, materializeConflict: true },
    { kind: "returned", value: result }, { ...RECEIPT_CONTEXT, recoveryCoordinates: { cwd: "/repo" } });
  assert.deepEqual(text.split("\n"), [
    `deliver accepted  ${result.contractId} · conflict handoff`, `  workspace  ${result.worktreePath}`,
    `  target head  ${result.targetHead}`, "  delivery  none", "  conflict  a.txt", "  conflict  b.txt",
    `  handoff base  ${result.handoffBase}`, `  available  keiyaku -C /repo deliver ${result.contractId} --include-dirty`,
  ]);
  assert.equal(JSON.parse(JSON.stringify(result)).handoffBase, result.handoffBase);
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
  const status = statusOf("aku/worker/aaaa0001", "running", openRows([row]));
  const text = nativeHistoryText({ kind: "akuma", akumaId: status.id, events: [row] }, {});
  assert.match(text, /! run \(bash\) 1\n  \$[^…\n]+…\n  detail  exit 7\n  cause\n/u);
  assert.equal(text.split("\n").at(-1), `    ${diagnostic}`);
  const short = completedTool(2, "bash", { kind: "run", command: "npm test" }, { status: "error", message: "hook failed" });
  const textShort = nativeHistoryText({ kind: "akuma", akumaId: status.id, events: [short] }, {});
  assert.equal(textShort.split("hook failed").length - 1, 1, "a complete inline diagnostic is not repeated");
});

test("native history bounds long diagnostics with a visible omission", () => {
  const message = "diagnostic word ".repeat(1000);
  const row = completedTool(1, "bash", { kind: "run", command: "npm test" }, { status: "error", message });
  const status = statusOf("aku/worker/aaaa0001", "running", openRows([row]));
  const text = nativeHistoryText({ kind: "akuma", akumaId: status.id, events: [row] }, {});
  assert.equal(text.split("\n").at(-1), `    ${message.slice(0, 160)}…`);
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
  const text = nativeHistoryText({ kind: "akuma", akumaId: parseAkumaId(id).id, events: rows }, {});
  assert.match(text, /^ {2}read 1\n  path  src\/a\.ts\n  detail  L0-0$/mu, "a settled tool spends no mark");
  assert.match(text, /^▎ 2\n  spoken$/mu, "speech keeps its distinct mark and no quotes");
  assert.match(text, /^▸ tell\/mark-law · 3\n  told direction$/mu, "a told input keeps its input lead");
  assert.equal((text.match(/✓/gu) ?? []).length, 0, "settled work adds no completion to running status");
});

test("generic tool rows preserve observed JSON arguments", () => {
  assert.deepEqual(genericLines([
    [1, "future_tool", preview({ alpha: 1, beta: "x", gamma: { delta: [true, null] } })],
    [2, "silent"],
    [3, "silent", preview({})],
    [4, "future_tool", { json: '{"alpha":1,"beta":"long', truncated: true }],
  ]), [
    "  future_tool 1",
    '  {"alpha":1,"beta":"x","gamma":{"delta":[true,null]}}',
    "  silent 2",
    "  silent 3",
    "  {}",
    "  future_tool 4",
    '  {"alpha":1,"beta":"long…',
  ]);
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
  const text = nativeHistoryText({ kind: "akuma", akumaId: parseAkumaId("aku/worker/abcd1234").id, events }, {});
  for (const [pattern, message] of [
    [/\{"alpha":1\}\n  detail  error\n  cause\n    refused$/mu, "argument, failure and cause remain distinct"],
    [/future_tool 2\n  \{\}\n  detail  exit 7$/mu, "an empty argument object never swallows failure evidence"],
  ] as const)
    assert.match(text, pattern, message);
  assert.doesNotMatch(text, / — ok/u);
  const legacy = nativeHistoryText({ kind: "akuma", akumaId: parseAkumaId("aku/worker/abcd1234").id,
    events: [completedTool(1, "mystery", { kind: "other" }, { status: "error", message: "refused" })],
  }, {});
  assert.match(legacy, /mystery 1\n  detail  error\n  cause\n    refused$/mu);
  assert.equal((legacy.match(/refused/gu) ?? []).length, 1, "a name-only failure states its diagnostic once");
});

test("generic tool names are complete; only argument previews use the content aperture", () => {
  const name = "long-tool-name-".repeat(20);
  const family = "👨‍👩‍👧‍👦";
  const args = preview({ text: family.repeat(180) });
  assert.deepEqual(genericLines([[123456789, name, args], [2, name, { json: "", truncated: true }]]), [
    `  ${name} 123456789`,
    `  {"text":"${family.repeat(151)}…`,
    `  ${name} 2`,
    "  …",
  ]);
});

test("long read paths and read ranges sit outside the text preview budget", () => {
  const path = `/work/${"source/".repeat(30)}nested.ts`;
  const row = completedTool(1, "read", { kind: "read", path, offset: 7, limit: 4 });
  const page = { kind: "akuma" as const, akumaId: parseAkumaId("aku/worker/abcd1234").id, events: [row] };
  assert.deepEqual(nativeHistoryText(page, {}).split("\n").slice(1), ["  read 1", `  path  ${path}`, "  detail  L7-10"]);
});

test("status and World keep the complete native summary and retained activity ID", () => {
  const id = "aku/worker/aabb0009";
  const path = `/work/${"source/".repeat(30)}nested.ts`;
  const sequence = 123456789;
  const rows = openRows([startedTool(sequence, "read", { kind: "read", path, offset: 7, limit: 4 })]);
  const view = observation(statusOf(id, "running", rows));
  const report = akumaWorldReport([activityAkumaRow(id, "running", rows)]);
  const line = `${sequence} read ${path} · L7-10`;
  for (const columns of [12, 120]) {
    const context = { columns, color: false };
    assert.equal(snapshotText(view, context).split("\n").filter((row) => row === line).length, 1);
    assert.equal(renderKanshiText(report, context).split("\n").filter((row) => row === `  ${line}`).length, 1);
  }
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
  const summary = projectCurrentWork(truncated).summary!;
  assert.equal(summary.clipped, true);
  assert.ok(summary.text.endsWith("…"));
  assert.equal(truncatedRoster.split("\n").at(-1), `  ${summary.id} ${summary.text}`);
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
    {}
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
    [id, "  /work/tree", "● running"],
    "the execution directory is a static coordinate before the observed life",
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
    {}
  );
  assert.match(historyText, /internal thought/u, "history keeps retained thought narration");
  assert.match(historyText, /^ {2}··· 55 earlier events · showing last 13/mu);
  assert.doesNotMatch(historyText, /earlier turns/u);
  assert.doesNotMatch(historyText, /●/u, "history never asserts live activity");
  for (const command of ["c4", "c5", "c6", "c7"])
    assert.match(historyText, new RegExp(`\\$ ${command}`, "u"), `history keeps intermediate tool ${command}`);
});

test("status current work follows the native overlapping-tool frontier", () => {
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
  const snapshot = (facts: readonly TimelineFact[]) =>
    snapshotText(observation(statusOf(id, "running", facts.map(projectFact))), DEFAULT_CONTEXT);
  assert.match(snapshot(first), /run \$ B/u);
  assert.match(snapshot(second), /run \$ A/u);
  assert.match(snapshot(third), /running/u);
  assert.doesNotMatch(snapshot(third), /\$ [AB]/u, "settled tools are no longer current work");
  const completions = third.map(projectFact).filter(row => row.kind === "tool" && row.phase === "completed");
  const history = nativeHistoryText({ kind: "akuma", akumaId: id, events: completions }, {});
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
    {}
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
  const text = nativeWaitText({ kind: "akuma", reason: "completed", results }, {});
  assert.equal(
    text,
    [`✓ ${complete.id} — completed`, `⧗ ${pending.id} — pending tell`].join("\n"),
    "each peer keeps its own final state on one line",
  );
});

test("paged CLI history distinguishes authored ellipsis from display omission", async (t) => {
  const { path: cwd } = makeGitRepository();
  const home = temporaryDirectory(t, "keiyaku-preview-home-");
  const { allocated, holder, body } = await bornBody(cwd, "aabb1234", AKUMA_ACTIVITY_AT);
  try {
    const turn = await beginTurn(allocated.paths, { bodySequence: body.sequence, startedAt: AKUMA_ACTIVITY_AT });
    const prefix = `${"a".repeat(159)}…`;
    const stored = [prefix, `${prefix}LOST`];
    const ids: number[] = [];
    for (const text of stored) {
      ids.push(await appendActivity(allocated.paths, {
        turnSequence: turn.sequence, at: AKUMA_ACTIVITY_AT, event: { type: "assistant", text },
      }));
    }
    const runtime = { cwd, environment: { HOME: home, USERPROFILE: home, KEIYAKU_HOME: home } };
    const history = await runCli(["history", allocated.id], runtime);
    assert.equal(history.exit, 0, history.stderr);
    assert.deepEqual(history.stdout.split("\n").filter((line) => line.startsWith(`  ${prefix}`)), [
      `  ${prefix}`,
      `  ${prefix}…`,
    ]);
    const exact = await runCli(["history", allocated.id, "--id", String(ids[1])], runtime);
    assert.equal(exact.exit, 0, exact.stderr);
    assert.equal(exact.stdout, `said: ${stored[1]}`);
  } finally {
    holder.release();
  }
});

test("settings CLI scope coordinates containing controls round-trip to the actual file", { skip: process.platform === "win32" }, async (t) => {
  const root = temporaryDirectory(t, "keiyaku-settings-path-");
  const cwd = join(root, 'project\t\u001b"\\\u200d');
  const home = join(root, "home with space");
  mkdirSync(join(cwd, ".keiyaku"), { recursive: true });
  mkdirSync(home);
  execFileSync("git", ["init", "--quiet", cwd]);
  const projectPath = join(cwd, ".keiyaku", "settings.json");
  const userPath = join(home, "settings.json");
  writeFileSync(projectPath, "{}");
  writeFileSync(userPath, "{}");
  const runtime = { cwd, environment: { HOME: home, USERPROFILE: home, KEIYAKU_HOME: home } };
  const argv = ["-C", cwd, "settings"];
  const json = await cliJson<Pick<Settings, "scopes">>(argv, runtime);
  const text = await runCli(argv, runtime);
  assert.equal(json.exit, 0, json.stderr);
  assert.equal(text.exit, 0, text.stderr);
  const projectLead = "  project  read  ";
  const line = text.stdout.split("\n").find((row) => row.startsWith(projectLead));
  assert.ok(line);
  assert.doesNotMatch(line, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  assert.equal(JSON.parse(line.slice(projectLead.length)), realpathSync.native(projectPath));
  assert.equal(json.value.scopes.project.path, realpathSync.native(projectPath));
  assert.ok(text.stdout.split("\n").includes(`  user  read  ${realpathSync.native(userPath)}`));
});

test("preview clips whole graphemes, excludes its prefix from the budget, and marks native omission once", () => {
  const content = "👨‍👩‍👧‍👦🇺🇸e\u0301👍🏽".repeat(40);
  const prefix = `${"identity/".repeat(35)} `;
  assert.deepEqual(previewLines(content, prefix), [prefix + content]);
  assert.deepEqual(previewLines(`${content}x`, prefix, 1, true), [`${prefix}${content}…`]);
  assert.deepEqual(previewLines("", prefix, 3, true), [`${prefix}…`]);
  assert.deepEqual(previewLines("retained…", "  ", 3, true), ["  retained……"]);
  assert.deepEqual(previewLines("\t one\n\n two  ", "  ", 1), ["  one two"]);
  assert.deepEqual(previewLines("one\n  two\n    three\n", "  "), ["  one", "    two", "      three…"]);
  const long = "x".repeat(158);
  assert.deepEqual(previewLines(`${long}\n  end`, "  "), [`  ${long}`, "    …"]);
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
