import { summarizeFrontier } from "../src/akuma/status-projection.js";
import {
  acceptedReceipt,
  contractDetail,
  contractReport,
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
  gate,
  requirementId,
  snapshotId,
} from "../src/core/facts/types.js";
import {
  historyText as nativeHistoryText,
  snapshotText,
} from "../src/cli/render/akuma-activity.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import { liveStatusObservationSchema } from "../src/akuma/akuma-selection-execution.js";
import type { LiveStatusObservation } from "../src/akuma/akuma-observe.js";
import { type ActivityRow, type ToolRow } from "../src/akuma/projection.js";
import type { AkumaObservation, DeliverOutcome, Placed } from "../src/index.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import {
  activityAkumaRow,
  akumaWorldReport,
  completedTool,
  startedTool,
  turnStarted,
  AKUMA_ACTIVITY_AT,
} from "./support/kanshi-activity.js";
import { bornBody } from "./support/akuma-fixtures.js";
import { makeGitRepository } from "./support/git.js";
import { temporaryDirectory } from "./support/process.js";
import { contractMarkdown } from "./support/markdown.js";
import { appendActivity, beginTurn } from "../src/akuma/heart/index.js";
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
import type { ContractHistoryEvent } from "../src/index.js";
import { compactTimelineItem } from "../src/akuma/timeline-text.js";

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
        outcome: { state: "canceled", turn: `turn/${row.turnSequence}`, at: row.at },
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
    work: summarizeFrontier(rows, "/work").work,

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
    events: rows.map(([sequence, name, input]) => compactTimelineItem(genericTool(sequence, name, input))),
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
  return {
    kind: "debt-catalogue",
    rows,
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
  assert.match(issues, /^! doctor$/mu);
  assert.match(issues, /^! missing-target debt\/a needs debt\/b$/mu);
  assert.match(issues, /^! self-relation debt\/a needs$/mu);
  assert.match(issues, /^! cycle needs debt\/a debt\/c$/mu);
  assert.equal(renderDoctor({ kind: "absent" }), "debt world absent");
});

test("empty World status has one explicit empty row", () => {
  assert.equal(
    renderKanshiText(
      {
        kind: "world",
        observedAt: "2026-08-12T00:00:00.000Z",
        contracts: {},
        debts: {},
        akumas: {},
      },
      { columns: 120, color: false },
    ),
    "○ world empty",
  );
});
test("Debt listings retain empty and absent observations", () => {
  const empty = debtPage([]);
  assert.equal(renderDebtList(empty), "debts  none");
  assert.equal(renderDebtList({ kind: "debt-catalogue", absent: true }), "debt world absent");
  const text = renderDebtList(debtPage([debtSummary({ id: "debt/one-row", title: "One row" })], true));
  assert.match(text, /^DEBTS$/mu);
  assert.match(text, /^○ debt\/one-row · ready · P2 · One row$/mu);
  assert.ok(text.endsWith("\n…"));
});


test("selected Contract roster preserves terminal associations and unavailable observations", () => {
  const attached = { akumaId: parseAkumaId("aku/worker/11110001").id, aliases: [parseAkumaAlias("@lead")] };
  const peer = { akumaId: parseAkumaId("aku/worker/22220002").id };
  const report = contractReport(
    contractDetail({
      phase: "claimed",
      associations: [attached, peer, { kind: "unavailable", source: "aliases", diagnostic: "Alias read failed" }],
    }),
  );
  const text = renderKanshiText(report, { columns: 80, color: false });
  assert.match(text, /aku\/worker\/11110001 \(@lead\)/u);
  assert.match(text, /aku\/worker\/22220002/u);
  assert.match(text, /aliases unavailable · Alias read failed/u);
  assert.match(text, /worktree  \/tmp\/wt/u);
  assert.doesNotMatch(text, /activity|candidate/u);
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

test("native history retains diagnostics beneath a bounded command row", () => {
  const diagnostic = "hook failed; retained diagnostic words; log /work/recovery/log.txt";
  const row = completedTool(1, "bash", { kind: "run", command: `bash -lc 'npm test ${"long-file ".repeat(30)}'` },
    { status: "error", exitCode: 7, message: diagnostic });
  const status = statusOf("aku/worker/aaaa0001", "running", openRows([row]));
  const text = nativeHistoryText({ kind: "akuma", akumaId: status.id, events: [compactTimelineItem(row)] }, {});
  assert.match(text, /! run \(bash\) 1\n  \$[^…\n]+…\n  detail  exit 7\n  cause\n/u);
  assert.equal(text.split("\n").at(-1), `    ${diagnostic}`);
  const short = completedTool(2, "bash", { kind: "run", command: "npm test" }, { status: "error", message: "hook failed" });
  const textShort = nativeHistoryText({ kind: "akuma", akumaId: status.id, events: [compactTimelineItem(short)] }, {});
  assert.equal(textShort.split("hook failed").length - 1, 1, "a complete inline diagnostic is not repeated");
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
  const text = nativeHistoryText({ kind: "akuma", akumaId: parseAkumaId("aku/worker/abcd1234").id, events: events.map(compactTimelineItem) }, {});
  for (const [pattern, message] of [
    [/\{"alpha":1\}\n  detail  error\n  cause\n    refused$/mu, "argument, failure and cause remain distinct"],
    [/future_tool 2\n  \{\}\n  detail  exit 7$/mu, "an empty argument object never swallows failure evidence"],
  ] as const)
    assert.match(text, pattern, message);
  assert.doesNotMatch(text, / — ok/u);
  const legacy = nativeHistoryText({ kind: "akuma", akumaId: parseAkumaId("aku/worker/abcd1234").id,
    events: [compactTimelineItem(completedTool(1, "mystery", { kind: "other" }, { status: "error", message: "refused" }))],
  }, {});
  assert.match(legacy, /mystery 1\n  detail  error\n  cause\n    refused$/mu);
  assert.equal((legacy.match(/refused/gu) ?? []).length, 1, "a name-only failure states its diagnostic once");
});

test("long read paths and read ranges sit outside the text preview budget", () => {
  const path = `/work/${"source/".repeat(30)}nested.ts`;
  const row = completedTool(1, "read", { kind: "read", path, offset: 7, limit: 4 });
  const page = { kind: "akuma" as const, akumaId: parseAkumaId("aku/worker/abcd1234").id, events: [compactTimelineItem(row)] };
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

test("a selected Contract renders its explicit held Debt and unavailable association", () => {
  const report = contractReport(contractDetail({ associations: [{ kind: "debt", debtId: "debt/held-work" }] }));
  assert.match(renderKanshiText(report, { columns: 120, color: false }), /holder  debt\/held-work/u);
  const failed = contractReport(contractDetail({ associations: [{ kind: "unavailable", source: "holder", diagnostic: "Holder read failed" }] }));
  assert.match(renderKanshiText(failed, { columns: 120, color: false }), /holder  unavailable · Holder read failed/u);
});
