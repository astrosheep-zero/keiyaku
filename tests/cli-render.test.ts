import { receipt } from "./support/cli-fixtures.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { changeId, contractHead, contractId, entryUlid, gate, snapshotId } from "../src/core/facts/types.js";
import type { InvocationResult } from "../src/cli/result.js";
import { renderCatalogText } from "../src/cli/render/catalog.js";
import type { CallObservation } from "../src/library/akuma-creation.js";
import {
  activityStream,
  akumaRawAnswer,
  callObservationStream,
  frameRule,
  snapshotActivityLines,
  snapshotText,
  waitObservationStream,
  waitText,
} from "../src/cli/render/akuma-activity.js";
import type { AkumaInvocationResult } from "../src/cli/commands/akuma-invoke.js";
import {
  parseAkumaStatus,
  type ActivityRow,
  type AkumaStatus,
  type CompletedToolRow,
  type OutcomeRow,
} from "../src/akuma/akuma.js";
import type { WaitObservedAkuma } from "../src/akuma/selection-execution.js";
import type { DispatchAssociation } from "../src/index.js";
import { parseAkumaAlias, type AkumaAlias } from "../src/identity/selector.js";
import { renderAkuma } from "../src/cli/render/kanshi-akuma.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import {
  displayColumns,
  orderRefusalFacts,
  renderOpaqueBlock,
  takeDisplayColumns,
  truncateDisplayText,
} from "../src/cli/render/terminal.js";
import { stopLines } from "../src/cli/render/receipt.js";
import { renderDiffstat } from "../src/cli/render/akuma-tool.js";
import { renderText } from "../src/cli/render/text.js";
import {
  activeTool,
  activityAkumaRow,
  akumaWorldReport,
  answeredOutcome,
  completedTool,
  idleAkumaSnapshot,
  openAkumaSnapshot,
  snapshotRow,
  AKUMA_ACTIVITY_AT,
  type ActivityToolCall,
} from "./support/kanshi-activity.js";
import type { Catalog } from "../src/cli/catalog.js";
import type { ContractRow } from "../src/protocol/read/status.js";
import type { WorldRoot } from "../src/world.js";
import { parseArgv } from "../src/cli/parse.js";
import { renderAkumaJson, renderAkumaText, askProgressStream } from "../src/cli/render/akuma.js";
import { projectTurns, selectSnapshot } from "../src/akuma/projection.js";
import { activityFact } from "./support/akuma-fixtures.js";
import type { TimelineFact } from "../src/akuma/heart/index.js";
import { parseAkuId } from "../src/akuma/identity.js";
import { renderTaskText } from "../src/cli/render/task.js";
import { reuseLines } from "../src/cli/render/receipt.js";
import { renderContractHistory } from "../src/cli/render/contract-history.js";
import { progressStrip } from "../src/cli/render/contract-observation.js";
import type { ContractHistoryEvent } from "../src/index.js";
import { parseTaskCommand } from "../src/cli/commands/task.js";
import { renderContractHelp } from "../src/cli/commands/contract-help.js";
import { renderAkumaHelp } from "../src/cli/commands/akuma.js";

const worldRoot = "/world" as WorldRoot;

/** The terminal clock a moment renders as, matching the renderer's local-time clock. */
function clockAt(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Rows carried by a live observation; focused renderer fixtures need no second projection. */
function activityRows(timeline: AkumaStatus["timeline"]): readonly ActivityRow[] {
  return timeline.entries.flatMap((entry) => (entry.kind === "row" ? [entry.row] : []));
}

function live(status: AkumaStatus, rows: readonly ActivityRow[] = activityRows(status.timeline)) {
  return { status, rows };
}

function liveActivity(snapshot: AkumaStatus["timeline"], rows: readonly ActivityRow[] = activityRows(snapshot)) {
  return { snapshot, rows };
}

/** One generic tool row carrying the admitted bounded argument preview an adapter retains. */
function genericTool(
  sequence: number,
  name: string,
  input?: Readonly<{ json: string; truncated: boolean }>,
): CompletedToolRow {
  return completedTool(sequence, name, {
    kind: "other",
    display: name,
    ...(input === undefined ? {} : { input }),
  });
}

/** The compact preview the shared admission helper builds for structured arguments. */
function preview(value: unknown, truncated = false): Readonly<{ json: string; truncated: boolean }> {
  return { json: JSON.stringify(value), truncated };
}

type GenericFixture = readonly [number, string, ReturnType<typeof preview>?];
const genericLines = (rows: readonly GenericFixture[], columns: number) =>
  snapshotActivityLines(
    openAkumaSnapshot(rows.map(([sequence, name, input]) => snapshotRow(genericTool(sequence, name, input)))),
    { columns, color: false },
  );
/** One observed Akuma as the wait's observation seam reports it: status plus identity facts. */
function observed(
  status: AkumaStatus,
  facts: Readonly<{ alias?: AkumaAlias; contract: DispatchAssociation }> = { contract: { kind: "none" } },
  rows: readonly ActivityRow[] = activityRows(status.timeline),
): WaitObservedAkuma {
  return { status, rows, ...facts };
}

function callObservation(
  observation: Extract<CallObservation, { kind: "observed" }>["observation"],
  completedAt: string | null = AKUMA_ACTIVITY_AT,
): CallObservation {
  return {
    kind: "observed",
    tell: {
      admission: { tellId: "tell/call-render", fact: "recorded" },
      row: {
        kind: "tell",
        sequence: 1,
        at: AKUMA_ACTIVITY_AT,
        tellId: "tell/call-render",
        text: "call input",
        state: "told",
        deliveries: [],
      },
      wake: { kind: "told" },
    },
    observation,
    completedAt,
  };
}

test("receipt and history rendering keeps journal ids and zero counts out of text", () => {
  assert.deepEqual(reuseLines({ entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FBG"), verdict: "satisfied" }, 120), [
    "  reuse  verified · satisfied",
  ]);
  assert.equal(
    renderContractHistory({ id: "kei/empty-history" as never, state: "snapshot" as never, events: [] }),
    "history  kei/empty-history · bound\n",
  );
  assert.equal(
    renderContractHistory({ id: "kei/empty-history" as never, state: "snapshot" as never, events: [] }, { full: true }),
    "history  kei/empty-history\n",
  );
});

test("the progress strip renders the road to claim from current-candidate chips", () => {
  const strip = (delivery: unknown, reports: readonly unknown[]): string =>
    progressStrip({ delivery, gates: { reports } } as never);
  const review = (current: unknown): unknown => ({ gate: "reviewed", current });

  assert.equal(strip(null, [review({ kind: "missing" })]), "[ ] delivery  [ ] review", "bound");
  assert.equal(strip(null, []), "[ ] delivery", "a gate-less contract shows the delivery chip alone");
  assert.equal(strip({}, [review({ kind: "missing" })]), "[✓] delivery  [ ] review", "a candidate without a review");
  assert.equal(
    strip({}, [review({ kind: "attested", verdict: "unsatisfied" })]),
    "[✓] delivery  [×] review",
    "a denied review",
  );
  assert.equal(
    strip({}, [review({ kind: "attested", verdict: "satisfied" })]),
    "[✓] delivery  [✓] review",
    "a satisfied review",
  );
  assert.equal(
    strip({}, [review({ kind: "stale", priorVerdict: "satisfied" })]),
    "[✓] delivery  [ ] review",
    "a satisfied review over a superseded candidate does not fill the box",
  );
  assert.equal(
    strip({}, [{ gate: "verified", current: { kind: "attested", verdict: "satisfied" } }]),
    "[✓] delivery  [✓] verification",
    "gate display names are nouns",
  );
});

test("skeleton history fuses beats and keeps evidence out of the row grammar", () => {
  const watch = contractId("kei/history-test");
  const start = snapshotId("a".repeat(40));
  const candidateA = snapshotId("b".repeat(40));
  const integrationA = snapshotId("c".repeat(40));
  const candidateB = snapshotId("d".repeat(40));
  const integrationB = snapshotId("e".repeat(40));
  const later = snapshotId("f".repeat(40));
  let suffix = 0;
  const nextEntry = (): string => {
    suffix += 1;
    return entryUlid(`01ARZ3NDEKTSV4RRFFQ69G5F${String(suffix).padStart(2, "0")}`);
  };
  const journal = (kind: string, at: string, data: unknown): ContractHistoryEvent => ({
    source: "journal",
    fact: { v: 1, kind, contract: watch, entry: nextEntry(), at, data } as never,
  });
  const deliverData = (tender: string, predecessor: string, snapshot: string) => ({
    tenderSnapshot: tender,
    integration: { predecessor, snapshot, changeId: changeId(snapshot) },
    method: "squash",
    policy: { requireBranchesToBeUpToDate: false },
  });
  const verification = (snapshot: string, verdict: "satisfied" | "unsatisfied"): unknown => ({
    gate: "verified",
    subject: JSON.stringify([["snapshot", snapshot]]),
    verdict,
    summary: `verification ${verdict}\nsecond line`,
  });
  const events: ContractHistoryEvent[] = [
    journal("bind", "2026-09-28T15:18:31.946Z", {
      coordinates: { start, target: "refs/heads/main", workspace: "worktree" },
      terms: { gates: ["reviewed", "verified"], after: [] },
    }),
    {
      source: "dispatch",
      dispatch: {
        akuId: parseAkuId("aku/intern/33dd4670").id,
        contractId: watch,
        dispatchedAt: "2026-09-28T15:20:00.000Z",
      },
    },
    journal("bound", "2026-09-28T15:21:00.000Z", {}),
    journal("deliver", "2026-09-28T16:00:00.000Z", deliverData(candidateA, start, integrationA)),
    journal("attestation", "2026-09-28T16:01:00.000Z", verification(integrationA, "unsatisfied")),
    journal("amend", "2026-09-28T16:11:00.000Z", { gates: ["reviewed", "verified"], after: [] }),
    journal("deliver", "2026-09-28T16:18:00.000Z", deliverData(candidateB, start, integrationB)),
    journal("attestation", "2026-09-28T16:19:00.000Z", verification(integrationB, "satisfied")),
    journal("attestation", "2026-09-28T16:38:00.000Z", {
      gate: "reviewed",
      subject: JSON.stringify([["snapshot", integrationB]]),
      verdict: "satisfied",
      summary: "review summary",
    }),
    journal("reintegrated", "2026-09-28T16:38:30.000Z", { predecessor: integrationB, snapshot: later }),
    journal("attestation", "2026-09-28T16:39:00.000Z", verification(later, "satisfied")),
    journal("arc", "2026-09-29T09:00:00.000Z", { seq: 1, title: "Chapter One", body: "freeform body\nline two" }),
    journal("claimed", "2026-09-29T09:30:00.000Z", { delivery: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5F99") }),
  ];
  const journals = events.filter((event) => event.source === "journal").length;
  const text = renderContractHistory({ id: watch, state: start, events });

  assert.equal(
    text.split("\n")[0],
    `history  kei/history-test · accepted · ${journals} entries · 1 dispatch`,
    "the header carries state, plural counts, and no journal word",
  );
  assert.doesNotMatch(text, /journal/u);
  assert.equal((text.match(/^\d{4}-\d{2}-\d{2}$/gmu) ?? []).length, 2, "one bare day divider per day");
  assert.match(text, /^15:18 bound to main @ aaaaaaa · gates review · verification · @intern$/mu);
  assert.match(text, /^16:00 delivered bbbbbbb · × verification · \d+ lines$/mu, "a denied fused deliver beat");
  assert.match(text, /^16:11 amended · gates$/mu, "amend names its facets");
  assert.match(text, /^16:18 delivered ddddddd · ✓ verification · \d+ lines$/mu, "a satisfied fused deliver beat");
  assert.match(text, /^16:38 ✓ review · \d+ lines$/mu, "a mark-first review beat");
  assert.match(
    text,
    /^16:38 integrated eeeeeee\.\.fffffff · ✓ verification · \d+ lines$/mu,
    "a fused reintegration beat",
  );
  assert.match(text, /^09:00 arc Chapter One · 2 lines$/mu, "the chapter title is visible with its body folded");
  assert.match(text, /^09:30 accepted$/mu);
  assert.doesNotMatch(text, /freeform body|verification satisfied|verification unsatisfied/u, "evidence stays folded");
  assert.doesNotMatch(text, /\[[ ✓×]\]/u, "history rows never carry state checkboxes");
  assert.doesNotMatch(text, /T\d{2}:\d{2}:\d{2}|Z /u, "skeleton rows carry HH:MM only");
  assert.doesNotMatch(text, /satisfied|unsatisfied/u, "the mark carries the verdict");

  const full = renderContractHistory({ id: watch, state: start, events }, { full: true });
  assert.match(full, /^history  kei\/history-test · \d+ journal entries · 1 dispatch$/mu);
  assert.match(full, /2026-09-28T15:18:31\.946Z bind · 01ARZ3NDEKTSV4RRFFQ69G5F01/u, "full keeps ISO stamps");
  assert.match(full, /candidate  bbbbbbb/u, "full keeps complete fields");

  const help = renderAkumaHelp("history");
  assert.match(help, /\[--full\]/u, "help advertises the full mode");
  assert.match(help, /defaults to a causal skeleton/u, "help documents the default skeleton");
  assert.match(help, /--full prints every event/u, "help documents the full mode");
});

test("a task title wraps its em-dash and title as one unit", () => {
  const context = { columns: 60, color: false } as const;
  const text = renderTaskText(
    parseTaskCommand(["ls"]),
    {
      kind: "accepted",
      value: {
        rows: [
          {
            id: "task/usability/a-very-long-task-title-that-cannot-fit-here" as never,
            title:
              "a very long task title that cannot fit inside one narrow rendered row and keeps going well past the terminal",
            state: "open",
            priority: 2,
            disposition: "ready",
            updatedAt: "2026-08-12T00:00:00.000Z",
            bodyPresent: false,
          },
        ],
        hasMore: false,
      },
    },
    context,
  );
  for (const line of text.split("\n")) assert.ok(!line.trimEnd().endsWith("—"), line);
  assert.match(text, /^  — a very long/mu, "the em-dash moves with its title to the continuation line");
});

test("compose plan renders positions and titles instead of provisional Task ids", () => {
  const command = parseArgv(["task", "compose", "--plan", "-"]);
  assert.ok("command" in command);
  if (!command.command || command.command.command !== "task") throw new Error("expected task command");
  const text = renderTaskText(command.command, {
    kind: "planned",
    aliases: [{ alias: "alpha", position: 1 }],
    admissionOrder: [{ position: 1, alias: "alpha" }],
    admissions: [{ position: 1, kind: "new", alias: "alpha", title: "Alpha" }],
    bodies: [],
  });
  assert.equal(text, "compose plan · 1 documents\nalias ^alpha 1\nadmit 1  + Alpha  as ^alpha");
  assert.doesNotMatch(text, /task\//u);
});

test("task receipts report fields and admissions without projection diffs", () => {
  const task = {
    id: "task/alpha" as never,
    namespace: [],
    title: "Alpha",
    state: "open" as const,
    priority: 2 as const,
    needs: [],
    parent: null,
    supersedes: [],
    relates: [],
    note: "new note",
    body: "first line\nsecond line",
    createdAt: "2026-08-12T00:00:00.123Z",
    updatedAt: "2026-08-12T00:01:00.456Z",
  };
  const update = renderTaskText(parseTaskCommand(["update", "task/alpha", "--note", "new note"]), {
    kind: "accepted",
    value: {
      task,
      documentDiff: "--- task/alpha.md\n+++ task/alpha.md\n+updatedAt: noise",
      changedFields: [{ field: "note", action: "replaced" }],
    },
  });
  assert.match(update, /^✓ updated  task\/alpha\n/mu);
  assert.match(update, /^  note  replaced$/mu);
  assert.doesNotMatch(update, /diff|updatedAt: noise/u);
  const added = renderTaskText(parseTaskCommand(["add", "Alpha"]), { kind: "accepted", value: task });
  assert.match(added, /^✓ added  task\/alpha/u);
  const composed = renderTaskText(parseTaskCommand(["compose", "-"]), {
    kind: "accepted",
    aliases: [{ alias: "alpha", taskId: task.id }],
    admissionOrder: [task.id],
    admissions: [{ position: 1, kind: "new", title: "Alpha", alias: "alpha" }],
    documentChanges: [{ taskId: task.id, kind: "created", documentDiff: "+updatedAt: noise" }],
  });
  assert.match(composed, /^✓ composed · 1 changed/mu);
  assert.match(composed, /^admit 1  \+ Alpha  as \^alpha$/mu);
  assert.doesNotMatch(composed, /diff|updatedAt/u);
  const shown = renderTaskText(parseTaskCommand(["show", "task/alpha"]), {
    task,
    needs: [],
    blockers: [],
    blocks: [],
    parent: null,
    children: [],
    supersedes: [],
    supersededBy: [],
    related: [],
  });
  assert.match(shown, /^  created  2026-08-12T00:00:00Z$/mu);
  assert.match(shown, /^  updated  2026-08-12T00:01:00Z$/mu);
  assert.match(shown, /^  note\n  new note/mu);
  assert.match(shown, /^  body\n  first line/mu);
});

test("catalog text renders only the selected identity layer", () => {
  assert.equal(
    renderCatalogText({
      kind: "tasks",
      root: "/world" as never,
      namespace: [],
      rows: [
        {
          id: "task/catalog-row" as never,
          title: "Catalog row",
          state: "open",
          priority: 2,
          disposition: "ready",
          updatedAt: "2026-08-12T00:00:00.000Z",
          bodyPresent: false,
        },
      ],
      hasMore: true,
    }),
    ["TASKS // root", "○ task/catalog-row · ready · P2 — Catalog row", "…"].join("\n"),
  );
  assert.equal(
    renderCatalogText({
      kind: "archetypes",
      rows: [{ name: "reviewer", model: "codex-5", description: "Read the complete change without truncation." }],
      hasMore: false,
    }),
    ["AKUMA NAMES // available", "", "reviewer  codex-5", "  Read the complete change without truncation."].join("\n"),
  );
  assert.equal(
    renderCatalogText({
      kind: "akuma",
      root: worldRoot,
      archetype: "worker",
      observedAt: "2026-08-12T00:00:00.000Z",
      rows: [{ id: "aku/worker/deadbeef" as never, life: "unborn", aliases: [] }],
      searched: ["/world/.keiyaku/akuma/run"],
      hasMore: false,
    }),
    ["AKUMA // worker", "", "○ aku/worker/deadbeef · unborn"].join("\n"),
  );
  assert.equal(
    renderCatalogText({
      kind: "akuma",
      root: worldRoot,
      archetype: "worker",
      observedAt: "2026-08-12T00:00:00.000Z",
      rows: [
        {
          id: "aku/worker/deadbeef" as never,
          archetype: "worker",
          life: "asleep",
          lifeAt: "2026-08-11T23:00:00.000Z",
          lastActivityAt: "2026-08-11T23:30:00.000Z",
          pending: [],
          aliases: ["@lead" as never, "@shadow" as never],
        },
      ],
      searched: ["/world/.keiyaku/akuma/run"],
      hasMore: false,
    }),
    ["AKUMA // worker", "", "○ aku/worker/deadbeef (@lead @shadow) · asleep · 1h · activity 30m"].join("\n"),
  );
});

test("ls help names Akuma names and states the catalog-vs-fleet mapping", () => {
  const help = renderContractHelp("ls");
  assert.doesNotMatch(help, /archetype/iu);
  assert.ok(help.includes("ls aku[/] [--limit <count>]"));
  assert.ok(help.includes("ls aku/<name>"));
  assert.ok(help.includes('ls "aku/<name>/*"'));
  assert.ok(help.includes('ls "aku/*/*"'));
  assert.ok(help.includes("callable Akuma-name catalog"));
  assert.ok(help.includes("living Akumas under one name"));
  assert.ok(help.includes("every living Akuma"));
});

test("rendered Akuma catalog header names Akuma names, never archetype", () => {
  const text = renderCatalogText({
    kind: "archetypes",
    rows: [{ name: "reviewer" }],
    hasMore: false,
  });
  assert.ok(text.startsWith("AKUMA NAMES // available"));
  assert.doesNotMatch(text, /archetype/iu);
});

test("root Task catalogue marks every disposition with its own state", () => {
  const cases = [
    ["ready", "○"],
    ["in_progress", "●"],
    ["blocked", "‖"],
    ["on_hold", "⧗"],
    ["done", "✓"],
    ["drop", "×"],
  ] as const;
  const catalog: Extract<Catalog, { kind: "tasks" }> = {
    kind: "tasks",
    root: worldRoot,
    namespace: [],
    hasMore: false,
    rows: cases.map(([disposition]) => ({
      id: `task/${disposition}` as never,
      title: disposition,
      priority: 1,
      state: disposition === "ready" || disposition === "blocked" ? "open" : disposition,
      disposition,
      updatedAt: "2026-08-12T00:00:00.000Z",
      bodyPresent: false,
    })),
  };
  assert.equal(
    renderCatalogText(catalog),
    [
      "TASKS // root",
      ...cases.map(
        ([state, mark]) =>
          `${mark} task/${state} · ${state === "drop" ? "dropped" : state.replaceAll("_", " ")} · P1 — ${state}`,
      ),
    ].join("\n"),
  );
});

test("empty World status has one explicit empty row", () => {
  assert.equal(
    renderKanshiText(
      {
        root: worldRoot,
        observedAt: "2026-08-12T00:00:00.000Z",
        branch: null,
        contracts: {
          kind: "present",
          value: { root: worldRoot, state: null, observedAt: "2026-08-12T00:00:00.000Z", rows: [], hasMore: false },
        },
        tasks: { kind: "present", value: { root: worldRoot, rows: [], hasMore: false } },
        akuma: {
          kind: "present",
          value: { observedAt: "2026-08-12T00:00:00.000Z", searched: [], rows: [], hasMore: false },
        },
      },
      { columns: 120, color: false },
    ),
    "○ world empty",
  );
});

test("empty catalogues share a surface-named none state", () => {
  assert.equal(
    renderCatalogText({ kind: "tasks", root: worldRoot, namespace: [], rows: [], hasMore: false }),
    "tasks  none",
  );
  assert.equal(
    renderCatalogText({
      kind: "contracts",
      root: "/repo",
      state: null,
      observedAt: "2026-08-12T00:00:00.000Z",
      rows: [],
      hasMore: false,
    }),
    "contracts  none",
  );
  assert.equal(
    renderCatalogText({
      kind: "akuma",
      root: worldRoot,
      archetype: "worker",
      observedAt: "2026-08-12T00:00:00.000Z",
      rows: [],
      searched: [],
      hasMore: false,
    }),
    "akuma  none",
  );
});

test("World roster names a bound Contract once without a bare unavailable parenthetical", () => {
  const snapshot = idleAkumaSnapshot([]);
  const bound = (observed: "active" | "terminal" | "missing" | "unavailable") => ({
    ...activityAkumaRow("aku/worker/11110001", "asleep", snapshot),
    contract: { id: contractId("kei/bound-contract"), observed },
  });
  const boundText = renderAkuma(akumaWorldReport([bound("terminal")]), { columns: 120, color: false }).join("\n");
  assert.match(boundText, /· kei\/bound-contract$/mu);
  assert.doesNotMatch(boundText, /bound to|unbound/u);
  assert.doesNotMatch(boundText, /->/u);
  const unresolved = renderAkuma(akumaWorldReport([bound("unavailable")]), { columns: 120, color: false }).join("\n");
  assert.match(unresolved, /· kei\/bound-contract$/mu);
  assert.doesNotMatch(unresolved, /bound to|unbound|unavailable/u);
  const missing = renderAkuma(akumaWorldReport([bound("missing")]), { columns: 120, color: false }).join("\n");
  assert.match(missing, /· kei\/bound-contract \(missing\)$/mu);
  assert.doesNotMatch(missing, /bound to|unbound/u);
  const free = renderAkuma(akumaWorldReport([activityAkumaRow("aku/worker/22220002", "asleep", snapshot)]), {
    columns: 120,
    color: false,
  }).join("\n");
  assert.match(free, /○ aku\/worker\/22220002 · asleep · 5s$/mu);
  assert.doesNotMatch(free, /bound to|unbound/u);
  assert.doesNotMatch(free, /·\s*$/mu);
});

test("Task family uses qualified empty frames and omits absent body facts", () => {
  const context = { columns: 120, color: false } as const;
  const empty = { kind: "accepted" as const, value: { rows: [], hasMore: false } };
  assert.equal(renderTaskText(parseTaskCommand(["ls"]), empty, context), "tasks  none");
  assert.equal(renderTaskText(parseTaskCommand(["ready"]), empty, context), "ready  none");
  assert.equal(renderTaskText(parseTaskCommand(["blocked"]), empty, context), "blocked  none");
  assert.equal(renderTaskText(parseTaskCommand(["query"]), empty, context), "query  none");
  const text = renderTaskText(
    parseTaskCommand(["ls"]),
    {
      kind: "accepted",
      value: {
        rows: [
          {
            id: "task/no-body" as never,
            title: "No body",
            state: "open",
            priority: 1,
            disposition: "ready",
            updatedAt: "2026-08-12T00:00:00.000Z",
            bodyPresent: false,
          },
        ],
        hasMore: false,
      },
    },
    context,
  );
  assert.match(text, /^TASKS \/\/ current namespace\n/u);
  assert.doesNotMatch(text, /no body/u);
});

test("Task catalogue rows omit absent body facts", () => {
  const text = renderCatalogText({
    kind: "tasks",
    root: worldRoot,
    namespace: [],
    rows: [
      {
        id: "task/no-body" as never,
        title: "No body",
        state: "open",
        priority: 1,
        disposition: "ready",
        updatedAt: "2026-08-12T00:00:00.000Z",
        bodyPresent: false,
      },
    ],
    hasMore: false,
  });
  assert.doesNotMatch(text, /no body/u);
});

test("World status task rows state a Contract association only when one exists", () => {
  const taskRow = {
    id: "task/standalone" as never,
    title: "Standalone task",
    state: "open" as const,
    priority: 1 as const,
    disposition: "ready" as const,
    updatedAt: "2026-01-01T09:00:00.000Z",
    bodyPresent: false,
  };
  const text = renderKanshiText(
    {
      ...akumaWorldReport([]),
      tasks: { kind: "present", value: { root: worldRoot, rows: [taskRow], hasMore: false } },
    },
    { columns: 120, color: false },
  );
  assert.match(text, /○ task\/standalone · ready · P1 · Standalone task$/mu);
  assert.doesNotMatch(text, /bound to|unbound/u);
  assert.doesNotMatch(text, /·\s*$/mu);
});

test("World roster states the activity age only when it differs from the state age", () => {
  const snapshot = idleAkumaSnapshot([]);
  const equal = activityAkumaRow("aku/worker/33330003", "asleep", snapshot);
  const equalText = renderAkuma(akumaWorldReport([equal]), { columns: 120, color: false }).join("\n");
  assert.match(equalText, /asleep · 5s/u);
  assert.doesNotMatch(equalText, /activity/u);
  const distinct = { ...equal, lastActivityAt: "2026-01-01T09:59:00.000Z" };
  const distinctText = renderAkuma(akumaWorldReport([distinct]), { columns: 120, color: false }).join("\n");
  assert.match(distinctText, /activity 1m/u);
});

test("scoped Akuma catalog text preserves bounded membership and marks further rows", () => {
  const catalog: Extract<Catalog, { kind: "akuma" }> = {
    kind: "akuma",
    root: worldRoot,
    archetype: "worker",
    observedAt: "2026-08-12T00:00:00.000Z",
    rows: Array.from({ length: 11 }, (_, index) => ({
      id: `aku/worker/${String(index).padStart(8, "0")}` as never,
      life: "unborn" as const,
      aliases: [],
    })),
    searched: [],
    hasMore: true,
  };
  const text = renderCatalogText(catalog);
  assert.match(text, /AKUMA \/\/ worker/u);
  assert.equal(text.endsWith("…"), true);
  assert.equal((text.match(/aku\/worker\//gu) ?? []).length, catalog.rows.length);
  assert.doesNotMatch(text, /aku\/\*\/\*/u);
  assert.doesNotMatch(text, /--all|next:|not shown|full|more available/u);
  assert.deepEqual(
    JSON.parse(JSON.stringify(catalog)).rows.map((row: { id: string }) => row.id),
    catalog.rows.map((row) => row.id),
  );
});

test("Akuma catalog renders future ages as now", () => {
  const futureRow = {
    id: "aku/worker/future" as never,
    archetype: "worker",
    life: "unborn" as const,
    lifeAt: "2026-08-12T00:00:01.000Z",
    lastActivityAt: null,
    pending: [],
    aliases: [],
  };
  const text = renderCatalogText({
    kind: "akuma",
    root: worldRoot,
    archetype: "worker",
    observedAt: "2026-08-12T00:00:00.000Z",
    rows: [futureRow],
    searched: [],
    hasMore: false,
  });
  assert.match(text, /○ aku\/worker\/future · unborn · now/u);
  assert.doesNotMatch(text, /0s/u);
});

test("Contract catalog keeps domain IDs complete and makes every gate state legible", () => {
  const state = snapshotId("a".repeat(40));
  const row: ContractRow = {
    id: contractId("kei/selected-contract"),
    title: "Selected Contract",
    phase: "bound",
    phaseAt: "2026-08-12T00:00:00.000Z",
    lastJournalAt: "2026-08-12T00:00:00.000Z",
    disposition: "active",
    workspace: "worktree",
    worktreePath: null,
    workspaceObservation: {
      kind: "clean",
      location: { kind: "worktree", path: "/tmp/wt" },
      counts: { staged: 0, unstaged: 0, untracked: 0, submodules: 0 },
      merge: null,
    },
    target: null,
    targetLag: { kind: "none" },
    delivery: null,
    targetObservation: null,
    gates: {
      satisfied: false,
      reports: [
        { gate: "reviewed", current: { kind: "attested", verdict: "satisfied", at: "2026-08-12T00:00:00.000Z" } },
        { gate: "verified", current: { kind: "attested", verdict: "unsatisfied", at: "2026-08-12T00:00:00.000Z" } },
        { gate: "security", current: { kind: "stale", priorVerdict: "satisfied" } },
        { gate: "manual", current: { kind: "missing" } },
      ],
    },
    after: [
      { contractId: contractId("kei/claimed-prerequisite"), endpoint: { kind: "claimed" } },
      { contractId: contractId("kei/active-prerequisite"), endpoint: { kind: "active", phase: "bound" } },
      { contractId: contractId("kei/abandoned-prerequisite"), endpoint: { kind: "abandoned" } },
      { contractId: contractId("kei/missing-prerequisite"), endpoint: { kind: "missing" } },
    ],
    dependents: [{ contractId: contractId("kei/dependent-contract"), phase: "bound" }],
  };
  const catalog: Catalog = {
    kind: "contracts",
    root: "/repo",
    state,
    observedAt: "2026-08-12T00:00:00.000Z",
    rows: [row],
    hasMore: true,
  };
  const text = renderCatalogText(catalog);

  assert.match(text, /! kei\/selected-contract · 0s · Selected Contract/u);
  assert.match(text, /\[ \] delivery  \[✓\] review  \[×\] verification  \[ \] security  \[ \] manual/u);
  assert.doesNotMatch(text, /bound|awaiting/u);
  assert.doesNotMatch(text, /candidate|predecessor|method|content identity|behind|workspace/u);
  assert.doesNotMatch(text, new RegExp(state, "u"));
  assert.doesNotMatch(text, /not shown|full|next:|--all/u);
  assert.equal(text.endsWith("…"), true);

  const snap = snapshotId("b".repeat(40));
  const delivered = renderCatalogText({
    ...catalog,
    rows: [
      {
        ...row,
        phase: "delivered",
        verification: { kind: "unrecorded" },
        delivery: {
          tenderSnapshot: snap,
          integration: { predecessor: snap, snapshot: snap, changeId: changeId("chg-selected-contract") },
          method: "squash",
          policy: { requireBranchesToBeUpToDate: false },
        },
      },
    ],
  });
  assert.match(delivered, /\[✓\] delivery  \[✓\] review  \[×\] verification  \[ \] security  \[ \] manual/u);
  assert.doesNotMatch(delivered, /awaiting/u);
  assert.doesNotMatch(delivered, /candidate|predecessor|content identity|method|behind/u);

  const expected = snapshotId("b".repeat(40));
  const observed = snapshotId("c".repeat(40));
  const moved = renderCatalogText({
    ...catalog,
    rows: [
      {
        ...row,
        target: "refs/heads/main",
        targetLag: { kind: "counted", behind: 0, subject: { kind: "worktree", path: "/repo/.keiyaku/wt/catalog" } },
        targetObservation: { head: observed, drift: true },
        phase: "delivered",
        delivery: {
          tenderSnapshot: expected,
          integration: { predecessor: expected, snapshot: expected, changeId: changeId("chg-target-moved") },
          method: "squash",
          policy: { requireBranchesToBeUpToDate: false },
        },
      },
    ],
  });
  assert.match(moved, /\[✓\] delivery  \[✓\] review  \[×\] verification  \[ \] security  \[ \] manual/u);
  assert.doesNotMatch(moved, /candidate|predecessor|content identity|behind/u);

  const disappeared = renderCatalogText({
    ...catalog,
    rows: [
      {
        ...row,
        target: "refs/heads/main",
        targetLag: { kind: "unknown" },
        targetObservation: { head: null, drift: true },
        phase: "delivered",
        delivery: {
          tenderSnapshot: expected,
          integration: { predecessor: expected, snapshot: expected, changeId: changeId("chg-target-null") },
          method: "squash",
          policy: { requireBranchesToBeUpToDate: false },
        },
      },
    ],
  });
  assert.match(disappeared, /\[✓\] delivery  \[✓\] review  \[×\] verification  \[ \] security  \[ \] manual/u);
  assert.doesNotMatch(disappeared, /candidate|predecessor|content identity|behind/u);
});

test("Contract status cards collapse terminal mechanics and bound testimony like Akuma answers", () => {
  const integration = snapshotId("a".repeat(40));
  const tender = snapshotId("b".repeat(40));
  const long = "👩‍💻".repeat(120);
  const base = {
    ...catalogRow(),
    phase: "bound" as const,
    disposition: "active" as const,
    worktreePath: "/tmp/wt",
    delivery: null,
    gates: { satisfied: false, reports: [{ gate: "reviewed", current: { kind: "missing" as const } }] },
  };
  const delivery = {
    tenderSnapshot: tender,
    integration: { predecessor: tender, snapshot: integration, changeId: changeId("chg-card") },
    method: "squash" as const,
    policy: { requireBranchesToBeUpToDate: false },
  };
  const show = (row: ContractRow, selection: "world" | "contract" = "contract") =>
    renderKanshiText(
      {
        ...akumaWorldReport([]),
        observedAt: "2026-08-12T00:00:05.000Z",
        contracts: {
          kind: "present",
          value: {
            root: "/repo",
            state: null,
            observedAt: "2026-08-12T00:00:05.000Z",
            rows: [{ ...row, holder: { kind: "none" }, roster: [] }],
          },
        },
      },
      { columns: 60, color: false },
      selection,
    );
  const bound = show(base);
  assert.match(bound, /⧗ bound · 5s/u);
  assert.match(bound, /○ review/u);
  assert.match(bound, /\[ \] delivery  \[ \] review/u);
  assert.doesNotMatch(bound, /awaiting delivery/u);
  assert.match(bound, /worktree  \/tmp\/wt/u);
  const delivered = show({ ...base, phase: "delivered", delivery });
  assert.match(delivered, /\[✓\] delivery  \[ \] review/u);
  assert.doesNotMatch(delivered, /awaiting gates/u);
  assert.match(delivered, /candidate  bbbbbbb/u);
  assert.match(delivered, /integration result  aaaaaaa/u);
  assert.doesNotMatch(delivered, /predecessor|method|content identity|behind/u);
  const denied = show({
    ...base,
    phase: "delivered",
    delivery,
    gates: {
      satisfied: false,
      reports: [
        {
          gate: "reviewed",
          current: {
            kind: "attested",
            verdict: "unsatisfied",
            at: "2026-08-12T00:00:00.000Z",
            summary: "Fix missing coverage",
          },
        },
      ],
    },
  });
  assert.match(denied, /review  ×  “Fix missing coverage”/u);
  assert.match(denied, /\[×\] review/u);
  assert.doesNotMatch(denied, /× reviewed/u);
  assert.equal((denied.match(/Fix missing coverage/gu) ?? []).length, 1);
  const stale = show({
    ...base,
    phase: "delivered",
    delivery,
    gates: {
      satisfied: false,
      reports: [{ gate: "reviewed", current: { kind: "stale", priorVerdict: "satisfied" } }],
    },
  });
  assert.match(stale, /\[✓\] delivery  \[ \] review/u, "a superseded review does not fill the chip");
  assert.match(stale, /! review · stale/u, "the card body keeps the stale review detail");
  const blocked = show({
    ...base,
    phase: "delivered",
    delivery,
    gates: { satisfied: true, reports: [] },
    after: [{ contractId: contractId("kei/other"), endpoint: { kind: "active", phase: "bound" } }],
  });
  assert.match(blocked, /\[✓\] delivery/u);
  assert.match(blocked, /^  blocked by  kei\/other · bound$/mu);
  const moved = show({
    ...base,
    phase: "delivered",
    delivery,
    gates: { satisfied: true, reports: [] },
    target: "refs/heads/main",
    targetObservation: { head: tender, drift: true },
  });
  assert.match(moved, /^  integration result  aaaaaaa · target moved since$/mu);
  assert.match(moved, /^  target moved  aaaaaaa -> bbbbbbb$/mu);
  assert.doesNotMatch(moved, /awaiting/u);
  const claimed = show({
    ...base,
    phase: "claimed",
    disposition: "terminal",
    delivery,
    gates: {
      satisfied: true,
      reports: [
        {
          gate: "reviewed",
          current: { kind: "attested", verdict: "satisfied", at: "2026-08-12T00:00:00.000Z", summary: long },
        },
      ],
    },
    targetObservation: { head: tender, drift: true },
    targetLag: { kind: "counted", behind: 5, subject: { kind: "worktree", path: "/tmp/wt" } },
  });
  assert.match(claimed, /landed  aaaaaaa/u);
  assert.doesNotMatch(claimed, /when  5s/u);
  assert.match(claimed, /review  “/u);
  assert.match(claimed, /│ /u);
  assert.match(claimed, /…”/u);
  assert.doesNotMatch(claimed, /candidate|candidate|predecessor|method|content identity|target moved|behind|worktree/u);
  const answer = snapshotActivityLines(idleAkumaSnapshot([], answeredOutcome(2, long)), {
    columns: 60,
    color: false,
  }).join("\n");
  assert.match(answer, /“/u);
  assert.match(answer, /│ /u);
  assert.match(answer, /…”/u);
  const abandoned = show({ ...base, phase: "abandoned", disposition: "terminal", abandonNote: long });
  assert.match(abandoned, /× abandoned/u);
  assert.match(abandoned, /note  “/u);
  assert.match(abandoned, /…”/u);
  assert.doesNotMatch(abandoned, /worktree|candidate|when  /u);
  assert.equal((abandoned.match(/× abandoned/gu) ?? []).length, 1);
  const world = show({ ...base, phase: "delivered", delivery }, "world");
  assert.match(world, /\[✓\] delivery  \[ \] review/u);
  assert.doesNotMatch(world, /awaiting gates/u);
  assert.doesNotMatch(world, /candidate|predecessor|method|content identity|behind/u);
});

function catalogRow(verification?: ContractRow["verification"]): ContractRow {
  return {
    id: contractId("kei/verified-commit"),
    title: "Verified commit",
    phase: "claimed",
    phaseAt: "2026-08-12T00:00:00.000Z",
    lastJournalAt: "2026-08-12T00:00:00.000Z",
    disposition: "terminal",
    workspace: "worktree",
    worktreePath: null,
    workspaceObservation: { kind: "unappointed" },
    target: "refs/heads/main",
    targetLag: { kind: "none" },
    delivery: null,
    targetObservation: null,
    ...(verification === undefined ? {} : { verification }),
    gates: { satisfied: true, reports: [] },
    after: [],
    dependents: [],
  };
}

test("recorded verification names the snapshot the verdict covers", () => {
  const integration = snapshotId("4".repeat(40));
  const catalog: Catalog = {
    kind: "contracts",
    root: "/repo",
    state: null,
    observedAt: "2026-08-12T00:00:00.000Z",
    rows: [
      catalogRow({ kind: "recorded", verdict: "satisfied", at: "2026-08-12T00:00:00.000Z", snapshot: integration }),
    ],
    hasMore: false,
  };
  assert.match(renderCatalogText(catalog), /✓ accepted/u);
  assert.doesNotMatch(renderCatalogText(catalog), /verification|snapshot 4444444/u);

  const bare = renderCatalogText({
    ...catalog,
    rows: [catalogRow({ kind: "recorded", verdict: "unsatisfied", at: "2026-08-12T00:00:00.000Z" })],
  });
  assert.match(bare, /✓ accepted/u);
  assert.doesNotMatch(bare, /verification|snapshot/u);
});

test("every verb receipt states facts without journal rows or entry ids", () => {
  const contract = contractId("kei/receipt-vocabulary");
  const entry = "01K4AJ8F6K7JH8Y6Q5NEPRT41V";
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    facts: [{ contract, entry, kind: "bound" as const }],
    settlementLags: [],
  };
  const receipts: readonly InvocationResult[] = [
    { ...envelope, verb: "bind", target: null, overlaps: [] },
    { ...envelope, verb: "amend", diff: "", changes: {} },
    { ...envelope, verb: "arc", chapter: { seq: 2, title: "Second chapter" } },
    { ...envelope, verb: "abandon" },
    { ...envelope, verb: "deliver" },
    { ...envelope, verb: "review", verdict: "satisfied" },
  ];
  for (const receipt of receipts) {
    const text = renderText(receipt);
    assert.doesNotMatch(text, /journal/u, text);
    assert.doesNotMatch(text, new RegExp(entry, "u"), text);
  }
  assert.equal(renderText(receipts[2]!), "✓ chapter 2 opened · Second chapter  kei/receipt-vocabulary");
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

test("reconcile reports retained workspace and failed cleanup in human words", () => {
  const result: InvocationResult = {
    kind: "reconcile",
    report: {
      effects: [],
      lag: [
        { kind: "worktree-retained", path: "/tmp/wt", diagnostic: "scratch removal failed" },
        {
          kind: "worktree-hook-failed",
          phase: "destroy",
          path: "/tmp/wt",
          command: 0,
          name: "cleanup",
          failure: { kind: "exit", code: 7, stdout: "", stderr: "", truncated: false },
        },
      ],
      settlement: { actions: [], lags: [] },
    },
  };
  const text = renderText(result);
  assert.match(text, /^  worktree retained at  \/tmp\/wt$/mu);
  assert.match(text, /^  reason  scratch removal failed$/mu);
  assert.match(text, /! reconcile  hook  destroy  \/tmp\/wt  cleanup  command 0  exit 7/u);
  assert.doesNotMatch(text, /!.*worktree-retained/u);
});

test("verb receipts keep retained workspace and scratch residue in typed results only", () => {
  for (const verb of ["amend", "review", "deliver"] as const) {
    const contract = contractId("kei/residue");
    const base = {
      contract,
      lag: [{ kind: "worktree-retained" as const, path: "/tmp/wt", affects: "none" as const }] as const,
      cleanup: [
        {
          kind: "worktree-leak" as const,
          contractId: contract,
          leak: { path: "/tmp/scratch", diagnostic: "cleanup failed" },
        },
      ],
    };
    const result: InvocationResult =
      verb === "amend"
        ? receipt({ ...base, verb, diff: "", changes: {}, overlaps: [] })
        : verb === "review"
          ? receipt({ ...base, verb, verdict: "satisfied" })
          : receipt({ ...base, verb });
    const text = renderText(result);
    assert.doesNotMatch(text, /lag  worktree|leak  worktree|\/tmp\//u);
    assert.equal(base.cleanup[0]?.kind, "worktree-leak");
  }
});

test("audit verification summary names declarations without changing raw evidence", () => {
  const summary = "[1 bash exit 1]";
  const result = receipt({
    verb: "audit",
    contract: contractId("kei/missing"),
    report: {
      candidate: { kind: "blocked", refusal: { kind: "worktree-missing", contractId: contractId("kei/missing") } },
      verification: { kind: "unsatisfied", passed: 0, total: 1, summary },
      target: { kind: "not-observed" },
    },
  });
  assert.match(renderText(result), /declaration 1 · bash exit 1/u);
  assert.doesNotMatch(renderText(result), /\[1 bash exit 1\]/u);
  assert.equal(
    result.report.verification.kind === "unsatisfied" ? result.report.verification.summary : undefined,
    summary,
  );
});

test("refusals use reason and option for missing contract and nuke confirmation", () => {
  const missing = renderText({
    kind: "refused",
    verb: "show",
    refusal: { kind: "contract-missing", contractId: contractId("kei/missing") },
  });
  assert.match(missing, /reason  contract missing/u);
  const nuke = renderText({
    kind: "refused",
    verb: "nuke",
    refusal: { kind: "nuke-confirmation-required", world: "/repo" },
  });
  assert.match(nuke, /reason  nuke confirmation required/u);
  assert.match(nuke, /option  keiyaku nuke --confirm '\/repo'/u);
});

test("query displays dropped while the Task state remains drop", () => {
  const row = {
    id: "task/dropped" as never,
    title: "Retired",
    priority: 1 as const,
    state: "drop" as const,
    disposition: "drop" as const,
    updatedAt: "2026-08-12T00:00:00.000Z",
    bodyPresent: false,
  };
  const text = renderTaskText(parseTaskCommand(["query"]), {
    kind: "accepted",
    value: { rows: [row], hasMore: false },
  });
  assert.match(text, /task\/dropped · dropped · P1/u);
  assert.equal(row.state, "drop");
});

test("amend receipt names gate and prerequisite changes even without document diff", () => {
  const contract = contractId("kei/gate-only");
  const base = receipt({ verb: "amend" as const, contract, diff: "", changes: {} });
  assert.match(renderText(base), /✓ amended  kei\/gate-only\n  terms  unchanged/u);
  const gates = renderText({ ...base, changes: { gates: ["reviewed", "holder-smelled"] } });
  assert.match(gates, /✓ amended[\s\S]*gates  reviewed · holder-smelled/u);
  assert.doesNotMatch(gates, /terms  unchanged/u);
  assert.match(
    renderText({ ...base, changes: { after: [contractId("kei/prerequisite")] } }),
    /after  kei\/prerequisite/u,
  );
});

test("amend terms diff keeps comparison headers without the banner or header whitespace", () => {
  const diff =
    "===================================================================\n--- before\t\n+++ after\t\n@@ -1 +1 @@\n-old\n+new\n";
  const text = renderText(receipt({ verb: "amend", contract: contractId("kei/diff"), diff, changes: {} }));
  assert.match(text, /^✓ amended  kei\/diff\n  terms diff\n  --- before\n  \+\+\+ after\n  @@/u);
  assert.doesNotMatch(text, /^  ===|before\t|after\t/mu);
});

test("receipt ids abbreviate in text, omit empty content, and remain full in JSON", () => {
  const contract = contractId("kei/identity");
  const tender = snapshotId("a".repeat(40));
  const integration = snapshotId("b".repeat(40));
  const result: InvocationResult = receipt({
    verb: "deliver",
    contract,
    tenderSnapshot: tender,
    integration: { changeId: changeId("0".repeat(40)) },
    completion: { predecessor: tender, integration, target: "refs/heads/main" },
  });
  const text = renderText(result);
  assert.match(text, /candidate  aaaaaaa/u);
  assert.match(text, /target  aaaaaaa\.\.bbbbbbb/u);
  assert.match(text, /✓ accepted/u);
  assert.doesNotMatch(text, /a{40}|b{40}|0{40}|content identity/u);
  assert.equal(JSON.parse(JSON.stringify(result)).tenderSnapshot, tender);
});

test("audit declares Verification once and names target lag from its typed report", () => {
  const contract = contractId("kei/audit-lag");
  const head = snapshotId("a".repeat(40));
  const integrated = snapshotId("b".repeat(40));
  const base = receipt({
    verb: "audit" as const,
    contract,
    report: {
      candidate: {
        kind: "ready" as const,
        workspace: { kind: "worktree" as const, path: "/repo/.keiyaku/wt/audit-lag" },
        identity: {
          tenderSnapshot: head,
          integration: { predecessor: head, snapshot: integrated, changeId: changeId("0".repeat(40)) },
          method: "squash" as const,
          policy: { requireBranchesToBeUpToDate: false },
        },
        scope: { filesChanged: 0, insertions: 0, deletions: 0 },
      },
      delivery: {
        changeId: changeId("0".repeat(40)),
        relation: "identical" as const,
        verification: { kind: "undeclared" as const },
      },
      verification: { kind: "undeclared" as const },
      target: { kind: "placeable" as const, ref: "refs/heads/main", head },
      targetLag: {
        kind: "counted" as const,
        behind: 3,
        subject: { kind: "worktree" as const, path: "/repo/.keiyaku/wt/audit-lag" },
      },
    },
  });
  const counted = renderText(base);
  assert.match(counted, /^  verification  none declared$/mu);
  assert.equal((counted.match(/verification/gu) ?? []).length, 1);
  assert.match(counted, /^  target  placeable  main @ aaaaaaa · behind 3$/mu);
  const unknown = renderText({ ...base, report: { ...base.report, targetLag: { kind: "unknown" as const } } });
  assert.match(unknown, /^  target  placeable  main @ aaaaaaa · behind unknown$/mu);
  assert.doesNotMatch(unknown, /behind 3|not.run|undeclared/u);
});

test("receipt hashes extend their prefixes when IDs collide within one receipt", () => {
  const tender = snapshotId(`${"a".repeat(7)}0${"0".repeat(32)}`);
  const integration = snapshotId(`${"a".repeat(7)}1${"0".repeat(32)}`);
  const text = renderText(
    receipt({
      verb: "deliver",
      contract: contractId("kei/hash-collision"),
      tenderSnapshot: tender,
      integration: { changeId: changeId("0".repeat(40)) },
      completion: { predecessor: tender, integration, target: "refs/heads/main" },
    }),
  );
  assert.match(text, /candidate  aaaaaaa0/u);
  assert.match(text, /target  aaaaaaa0\.\.aaaaaaa1/u);
});

test("reconcile lists changed effects once with path last and no null sentinels", () => {
  const ref = {
    kind: "ref" as const,
    name: "refs/keiyaku/delivery/example",
    action: "removed" as const,
    before: "a".repeat(40) as never,
    after: null,
  };
  const text = renderText({
    kind: "reconcile",
    report: {
      effects: [ref, ref, { ...ref, action: "unchanged" as const, before: null }],
      lag: [],
      settlement: { actions: [], lags: [] },
    },
  });
  assert.equal(text, "✓ reconcile\n  effect  ref  removed · aaaaaaa  refs/keiyaku/delivery/example");
  assert.doesNotMatch(text, /null/u);
});

test("reconcile recovery snapshots use receipt-length Git identities", () => {
  const text = renderText({
    kind: "reconcile",
    report: {
      effects: [
        { kind: "recovery-snapshot", action: "created", snapshot: snapshotId("f".repeat(40)), retention: "ephemeral" },
      ],
      lag: [],
      settlement: { actions: [], lags: [] },
    },
  });
  assert.match(text, /effect  recovery-snapshot  created  fffffff/u);
  assert.doesNotMatch(text, /f{40}/u);
});

test("reconcile renders a healthy no-op compactly", () => {
  const result: InvocationResult = {
    kind: "reconcile",
    report: { effects: [], lag: [], settlement: { actions: [], lags: [] } },
  };
  assert.equal(renderText(result), "✓ reconcile\n  already consistent");
});

test("reconcile failure renders mark and facts", () => {
  const result: InvocationResult = {
    kind: "reconcile",
    report: {
      effects: [],
      lag: [{ kind: "reconcile-failed", stage: "effect", diagnostic: "git failed" }],
      settlement: { actions: [], lags: [] },
    },
  };
  assert.equal(renderText(result), "✓ reconcile\n! reconcile  effect  git failed");
});

test("reconcile renders worktree hook failure as attention", () => {
  const result: InvocationResult = {
    kind: "reconcile",
    report: {
      effects: [],
      lag: [
        {
          kind: "worktree-hook-failed",
          phase: "create",
          path: "/tmp/wt",
          command: 0,
          name: "prepare",
          failure: { kind: "exit", code: 7, stdout: "", stderr: "hook failed", truncated: false },
        },
      ],
      settlement: { actions: [], lags: [] },
    },
  };
  assert.match(renderText(result), /! reconcile  hook  create  \/tmp\/wt  prepare  command 0  exit 7/u);
});

test("reconcile renders target checkout retention as attention", () => {
  const result: InvocationResult = {
    kind: "reconcile",
    report: {
      effects: [],
      lag: [
        {
          kind: "target-checkout-retained",
          target: "refs/heads/main",
          path: "/repo/file",
          diagnostic: "checkout failed",
        },
      ],
      settlement: { actions: [], lags: [] },
    },
  };
  const text = renderText(result);
  assert.match(text, /! target checkout kept at  \/repo\/file  · refs\/heads\/main/u);
  assert.match(text, /  reason  checkout failed/u);
});

test("reconcile renders private-state seat-close failure and diagnostic", () => {
  const result: InvocationResult = {
    kind: "reconcile",
    report: {
      effects: [],
      lag: [],
      settlement: {
        actions: [],
        lags: [],
        seatClose: [{ kind: "private-state-seat-close-failed", diagnostic: "could not close publication seat" }],
      },
    },
  };
  const text = renderText(result);
  assert.match(text, /! settlement  private-state-seat-close-failed/u);
  assert.match(text, /! reason  could not close publication seat/u);
});

test("reconcile hook payloads preserve lines and remain bounded", () => {
  const result: InvocationResult = {
    kind: "reconcile",
    report: {
      effects: [],
      lag: [
        {
          kind: "worktree-hook-failed",
          phase: "destroy",
          path: "/tmp/wt",
          command: 1,
          name: "cleanup",
          failure: {
            kind: "exit",
            code: 9,
            stdout: "",
            stderr: `${"line\n".repeat(100)}tail`,
            truncated: false,
          },
        },
      ],
      settlement: { actions: [], lags: [] },
    },
  };
  const lines = renderText(result).split("\n");
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
  const result: InvocationResult = {
    kind: "reconcile",
    report: {
      effects: [],
      lag: [
        { kind: "contract-file-failed", worktree: "/tmp/wt", path: ".keiyaku/KEIYAKU.md", diagnostic: "write failed" },
      ],
      settlement: {
        actions: [],
        lags: [
          {
            kind: "settlement-failed",
            surface: "task",
            contractId: contractId("kei/example"),
            diagnostic: "task failed",
          },
        ],
      },
    },
  };
  const text = renderText(result);
  assert.match(text, /! contract file unavailable  \/tmp\/wt  · \.keiyaku\/KEIYAKU\.md/u);
  assert.match(text, /! settlement  surface task  contractId kei\/example  diagnostic task failed/u);
});

test("world reconcile failure renders its diagnostic", () => {
  const result: InvocationResult = {
    kind: "reconcile",
    report: { kind: "world-observation-failed", diagnostic: "git failed" },
  };
  assert.equal(renderText(result), "✓ reconcile\n! reconcile  git failed");
});

test("Verification create action names are safe in text receipts", () => {
  const name = "prepare\nINJECT\u001b[31m";
  const result: InvocationResult = receipt({
    verb: "deliver",
    contract: contractId("kei/hostile-create-name"),
    verification: {
      failure: "environment-failure",
      name,
      detail: { kind: "exit", code: 17, stdout: "", stderr: "", truncated: false },
    },
  });

  const text = renderText(result, { columns: 200, color: false });
  assert.equal(text.includes('name "prepare\\nINJECT\\u001b[31m"'), true);
  assert.doesNotMatch(text, /\nINJECT/u);
  assert.doesNotMatch(text, /\u001b/u);
  const verification = result.verification;
  assert.equal(verification !== undefined && "name" in verification ? verification.name : undefined, name);
});

test("Verification cleanup action names are safe in text receipts", () => {
  const name = "destroy\rINJECT\u001b[2J";
  const result: InvocationResult = receipt({
    verb: "deliver",
    contract: contractId("kei/hostile-cleanup-name"),
    cleanup: [
      {
        kind: "verification-cleanup",
        contractId: contractId("kei/hostile-cleanup-name"),
        failure: { phase: "destroy", name, detail: { kind: "timeout" } },
      },
    ],
  });

  const text = renderText(result, { columns: 200, color: false });
  assert.equal(text.includes('name "destroy\\rINJECT\\u001b[2J"'), true);
  assert.doesNotMatch(text, /\rINJECT/u);
  assert.doesNotMatch(text, /\u001b/u);
  const cleanup = result.cleanup?.[0];
  assert.equal(cleanup?.kind === "verification-cleanup" ? cleanup.failure.name : undefined, name);
});

test("accepted results preserve reconciliation lag without telemetry", () => {
  const contract = contractId("kei/followed");
  const tender = snapshotId("tender");
  const head = snapshotId("head");
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("record"),
    facts: [],
    lag: [
      {
        kind: "worktree-follow-retained" as const,
        path: "/tmp/wt",
        tender,
        head,
        reason: "head-moved" as const,
        affects: "continuation",
      },
    ] as const,
    settlementLags: [],
  };
  assert.equal(
    renderText({ ...envelope, verb: "deliver" }),
    ["✓ delivered  kei/followed", "  candidate  kept"].join("\n"),
  );
  assert.deepEqual(envelope.lag[0], {
    kind: "worktree-follow-retained",
    path: "/tmp/wt",
    tender,
    head,
    reason: "head-moved",
    affects: "continuation",
  });
});

test("accepted bind receipts expose confirmed private-state seat close lag", () => {
  const contract = contractId("kei/bound");
  const result: InvocationResult = receipt({
    verb: "bind",
    contract,
    facts: [{ contract, entry: "bind", kind: "bound" }],
    workspace: { kind: "worktree", path: "/tmp/wt" },
    target: null,
    overlaps: [],
    cleanup: [
      {
        kind: "private-state-seat-close",
        contractId: contract,
        failure: { kind: "private-state-seat-close-failed", diagnostic: "seat close failed after publication" },
      },
    ],
  });
  assert.equal(
    renderText(result),
    [
      "✓ bound  kei/bound",
      "  worktree  /tmp/wt",
      "  no target",
      "! lag  private-state-seat-close-failed",
      "  reason",
      "  seat close failed after publication",
      "",
    ].join("\n"),
  );
});

test("accepted bind receipts surface Region lint warnings", () => {
  const contract = contractId("kei/warned");
  const result: InvocationResult = receipt({
    verb: "bind",
    contract,
    facts: [{ contract, entry: "bind", kind: "bound" }],
    target: null,
    overlaps: [],
    warnings: ["Region pattern 'src/a b' contains whitespace and will never match a path"],
  });
  assert.match(renderText(result), /! region warning[\s\S]*src\/a b[\s\S]*contains whitespace/u);
});

test("accepted receipts omit execution telemetry and retain recovery snapshots", () => {
  const contract = contractId("kei/unchanged-mechanics");
  const head = contractHead("journal-blob-oid");
  const result: InvocationResult = {
    kind: "accepted",
    verb: "deliver",
    contract,
    head,
    facts: [{ contract, entry: "claim", kind: "claimed" }],
    lag: [{ kind: "unsealed-bytes", path: "/repo/.keiyaku/wt/contract", paths: [], affects: "none" }],
    settlementLags: [],
    recoverySnapshot: snapshotId("recovery"),
    leading: { kind: "already-admitted", fact: "01K4AJ8F6K7JH8Y6Q5NEPRT41V" as never },
    tenderSnapshot: snapshotId("tender-commit"),
    integration: { changeId: changeId("content-id") },
    completion: { integration: snapshotId("integration") },
  };

  const text = renderText(result);
  assert.match(text, /candidate  tender-commit[\s\S]*content identity \(not commit\)  content-id/u);
  assert.match(text, /leading\s+already admitted/u);
  assert.doesNotMatch(text, /01K4AJ8F6K7JH8Y6Q5NEPRT41V/u);
  assert.doesNotMatch(text, /journal-blob-oid/u);
  assert.doesNotMatch(text, /ref updated|contract-file|worktree unchanged/u);
  assert.doesNotMatch(text, /ephemeral/u);
  assert.match(text, /recovery snapshot  recovery/u);
  assert.doesNotMatch(text, /unsealed bytes|\/repo\/\.keiyaku\/wt\/contract/u);
  assert.equal(JSON.parse(JSON.stringify(result)).recoverySnapshot, result.recoverySnapshot);
});

test("direct placement stops render the public unmet prerequisites in order", () => {
  const contract = contractId("kei/waiting-on-prerequisites");
  const unmet = [
    { contractId: contractId("kei/active-prerequisite"), state: "active" as const },
    { contractId: contractId("kei/abandoned-prerequisite"), state: "abandoned" as const },
    { contractId: contractId("kei/missing-prerequisite"), state: "missing" as const },
  ];
  const placement = {
    refusal: { kind: "prerequisites-unsatisfied" as const, contractId: contract, unmet },
  };
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    facts: [],
    settlementLags: [],
  };

  const deliver: InvocationResult = { ...envelope, verb: "deliver", placement };
  assert.equal(
    renderText(deliver),
    [
      "✓ delivered  kei/waiting-on-prerequisites",
      "! prerequisites unsatisfied",
      "  prerequisite  kei/active-prerequisite  ·  active",
      "  prerequisite  kei/abandoned-prerequisite  ·  abandoned",
      "  prerequisite  kei/missing-prerequisite  ·  missing",
      "  candidate  kept",
    ].join("\n"),
  );

  const review: InvocationResult = { ...envelope, verb: "review", verdict: "satisfied", placement };
  assert.equal(
    renderText(review),
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
  const review: InvocationResult = {
    kind: "accepted",
    contract,
    head: contractHead("head"),
    facts: [{ contract, entry: "review", kind: "attestation" }],
    settlementLags: [],
    verb: "review",
    verdict: "satisfied",
    placement: { failure: "target-placement-failed", diagnostic: "fatal: could not read from remote repository" },
  };
  const text = renderText(review);
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

test("direct gate stops render the sole placement report without another read", () => {
  const contract = contractId("kei/waiting-on-gates");
  assert.equal(
    renderText(
      receipt({
        verb: "deliver",
        contract,
        placement: {
          refusal: {
            kind: "gates-unsatisfied",
            contractId: contract,
            unmet: [
              {
                gate: gate("verified"),
                current: {
                  kind: "attested",
                  verdict: "unsatisfied",
                  summary: "[1 bash exit 1]",
                  at: "2026-08-01T00:00:00.000Z",
                },
              },
              { gate: gate("reviewed"), current: { kind: "stale", priorVerdict: "satisfied" } },
              { gate: gate("manual"), current: { kind: "missing" } },
            ],
          },
        },
      }),
    ),
    [
      "✓ delivered  kei/waiting-on-gates",
      "! gates unsatisfied",
      "  gate  verified  ·  unsatisfied  · at 2026-08-01T00:00:00.000Z",
      "  summary verified",
      "  [1 bash exit 1]",
      "",
      "  gate  reviewed  · stale  · prior satisfied",
      "  gate  manual  · missing",
      "  candidate  kept",
    ].join("\n"),
  );
});

test("completion stops project every checkout-followability refusal fact", () => {
  const contract = contractId("kei/checkout-followability");
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    facts: [],
    settlementLags: [],
  };
  const cases = [
    {
      reason: "staged" as const,
      paths: ["staged.ts", 'quote"path.ts'],
      text: [
        "! checkout-not-followable",
        "  checkout  /repo/checkout",
        "  target  refs/heads/main",
        "  reason  staged",
        "  paths",
        "    staged.ts",
        '    quote"path.ts',
      ],
    },
    {
      reason: "dirty-tracked" as const,
      paths: ["conflict.ts"],
      text: [
        "! checkout-not-followable",
        "  checkout  /repo/checkout",
        "  target  refs/heads/main",
        "  reason  dirty-tracked",
        "  paths",
        "    conflict.ts",
      ],
    },
    {
      reason: "untracked" as const,
      paths: [],
      text: [
        "! checkout-not-followable",
        "  checkout  /repo/checkout",
        "  target  refs/heads/main",
        "  reason  untracked",
        "  paths  none",
      ],
    },
  ];

  for (const { reason, paths, text } of cases) {
    const rendered = renderText({
      ...envelope,
      verb: "deliver",
      placement: {
        refusal: {
          kind: "checkout-not-followable",
          contractId: contract,
          target: "refs/heads/main",
          path: "/repo/checkout",
          reason,
          paths,
        },
      },
    } as InvocationResult);
    const renderedLines = rendered.split("\n");
    const start = renderedLines.indexOf("! checkout-not-followable");
    assert.notEqual(start, -1);
    assert.deepEqual(renderedLines.slice(start, start + text.length), text);
  }
});

test("continuation checkout stop keeps its exact block after the dependent context", () => {
  const contract = contractId("kei/prerequisite-checkout");
  const dependent = contractId("kei/stopped-checkout-dependent");
  assert.equal(
    renderText(
      receipt({
        verb: "deliver",
        contract,
        completion: {
          integration: snapshotId("2".repeat(40)),
          predecessor: snapshotId("1".repeat(40)),
          target: "refs/heads/main",
        },
        continuation: {
          claimed: [],
          stopped: [
            {
              contractId: dependent,
              stop: {
                refusal: {
                  kind: "checkout-not-followable",
                  contractId: dependent,
                  target: "refs/heads/main",
                  path: "/repo/checkout",
                  reason: "untracked",
                  paths: ['quote"path.ts'],
                },
              },
            },
          ],
        },
      }),
    ),
    [
      "✓ delivered  kei/prerequisite-checkout",
      "  target  1111111..2222222  refs/heads/main",
      "✓ accepted",
      "! dependent  kei/stopped-checkout-dependent",
      "! checkout-not-followable",
      "  checkout  /repo/checkout",
      "  target  refs/heads/main",
      "  reason  untracked",
      "  paths",
      '    quote"path.ts',
    ].join("\n"),
  );
});

test("retry stops name their retry class in outcome vocabulary", () => {
  const addressed = contractId("kei/retry-stop");
  const dependent = contractId("kei/retry-dependent");
  assert.deepEqual(stopLines({ retry: { kind: "exhausted" } }, 100, addressed), ["? retry  exhausted"]);
  assert.deepEqual(stopLines({ retry: { kind: "collision" } }, 100, addressed), ["? retry  collision"]);
  assert.deepEqual(
    stopLines({ retry: { kind: "publication-failed", diagnostic: "fatal: unable to create lock" } }, 100, addressed),
    ["? retry  publication failed", "  reason", "  fatal: unable to create lock", ""],
  );
  assert.deepEqual(stopLines({ retry: { kind: "collision" } }, 100, addressed, dependent), [
    `? retry  collision  ·  ${dependent}`,
  ]);

  for (const retry of [
    { kind: "exhausted" as const },
    { kind: "collision" as const },
    { kind: "publication-failed" as const, diagnostic: "fatal: unable to create lock" },
  ]) {
    const text = stopLines({ retry }, 100, addressed, dependent).join("\n");
    assert.match(text, /^\? retry  /u);
    assert.doesNotMatch(text, /!/u);
  }
});

test("a retry placement stop renders through the delivered receipt without the failure mark", () => {
  const contract = contractId("kei/retry-stops-receipt");
  assert.equal(
    renderText(
      receipt({
        verb: "deliver",
        contract,
        placement: { retry: { kind: "publication-failed", diagnostic: "fatal: unable to create lock" } },
      }),
    ),
    [
      "✓ delivered  kei/retry-stops-receipt",
      "? retry  publication failed",
      "  reason",
      "  fatal: unable to create lock",
      "",
      "  candidate  kept",
    ].join("\n"),
  );
});

test("detail facts sink behind ordered refusal facts", () => {
  assert.deepEqual(
    orderRefusalFacts(["reason  first", "detail  alpha", "path  /repo", "detail  beta", "task  t"]),
    ["reason  first", "path  /repo", "task  t", "detail  alpha", "detail  beta"],
  );
  assert.deepEqual(orderRefusalFacts(["detail  only", "reason  kept"]), ["reason  kept", "detail  only"]);
});

test("deliver projects a ran Verification completion", () => {
  const contract = contractId("kei/completion");
  const integration = snapshotId("4".repeat(40));
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    facts: [{ contract, entry: "claim", kind: "claimed" as const }],
    settlementLags: [],
  };
  const text = renderText({
    ...envelope,
    verb: "deliver",
    completion: {
      integration,
      predecessor: snapshotId("3".repeat(40)),
      target: "refs/heads/main",
      verification: { mode: "ran", verdict: "satisfied" },
    },
  });
  assert.equal(
    text,
    [
      "✓ delivered  kei/completion",
      "  target  3333333..4444444  refs/heads/main",
      "  integration result  4444444 · verification satisfied",
      "✓ accepted",
    ].join("\n"),
  );
  assertModeWordingAbsent(text);
});

test("placement receipts name reused provenance in the audit surface's vocabulary", () => {
  const contract = contractId("kei/placement-reuse");
  const text = renderText(
    receipt({
      verb: "review",
      contract,
      verdict: "satisfied",
      completion: {
        integration: snapshotId("4".repeat(40)),
        predecessor: snapshotId("3".repeat(40)),
        target: "refs/heads/main",
        verification: { mode: "reused", verdict: "satisfied" },
      },
    }),
  );
  assert.equal(
    text,
    [
      "✓ review satisfied  kei/placement-reuse",
      "  target  3333333..4444444  refs/heads/main",
      "  integration result  4444444 · verification reused satisfied",
      "✓ accepted",
    ].join("\n"),
  );
});

test("a deliver receipt without placement names the verdict's exact snapshot and provenance", () => {
  const contract = contractId("kei/standalone-subject");
  const integration = snapshotId("a".repeat(40));
  assert.equal(
    renderText(
      receipt({
        verb: "deliver",
        contract,
        tenderSnapshot: snapshotId("b".repeat(40)),
        integration: { changeId: changeId("c".repeat(40)) },
        verificationSubject: { snapshot: integration, mode: "reused", verdict: "satisfied" },
      }),
    ),
    [
      "✓ delivered  kei/standalone-subject",
      "  candidate  bbbbbbb",
      "  content identity (not commit)  ccccccc",
      "  integration result  aaaaaaa · verification reused satisfied",
      "  candidate  kept",
    ].join("\n"),
  );
  const fresh = renderText(
    receipt({
      verb: "deliver",
      contract,
      verificationSubject: { snapshot: integration, mode: "ran", verdict: "unsatisfied" },
    }),
  );
  assert.match(fresh, /^  integration result  aaaaaaa · verification unsatisfied$/mu);
  assert.equal((fresh.match(/integration result/gu) ?? []).length, 1);
});

test("a placed deliver keeps the verdict on the placement integration row only", () => {
  const contract = contractId("kei/one-row");
  const integration = snapshotId("4".repeat(40));
  const text = renderText(
    receipt({
      verb: "deliver",
      contract,
      completion: {
        integration,
        predecessor: snapshotId("3".repeat(40)),
        target: "refs/heads/main",
        verification: { mode: "reused", verdict: "satisfied" },
      },
      verificationSubject: { snapshot: integration, mode: "reused", verdict: "satisfied" },
    }),
  );
  assert.equal((text.match(/integration result/gu) ?? []).length, 1);
  assert.match(text, /^  integration result  4444444 · verification reused satisfied$/mu);
});

test("terminal receipts name the retired worktree last", () => {
  const review = renderText(
    receipt({
      verb: "review",
      contract: contractId("kei/retired-review"),
      verdict: "satisfied",
      completion: {
        integration: snapshotId("4".repeat(40)),
        predecessor: snapshotId("3".repeat(40)),
        target: "refs/heads/main",
        verification: { mode: "ran", verdict: "satisfied" },
      },
      retiredWorktree: "fridge",
    }),
  );
  assert.match(review, /^  worktree  fridge retired$/mu);
  assert.match(review, /retired$/u);
  const abandoned = renderText(
    receipt({ verb: "abandon", contract: contractId("kei/retired-abandon"), retiredWorktree: "shed" }),
  );
  assert.match(abandoned, /^  worktree  shed retired$/mu);
  const active = renderText(receipt({ verb: "review", contract: contractId("kei/active"), verdict: "satisfied" }));
  assert.doesNotMatch(active, /retired/u);
});

test("a terminal receipt names a retained worktree in place of the obituary", () => {
  const retained = renderText(
    receipt({
      verb: "abandon",
      contract: contractId("kei/retained-abandon"),
      retainedWorktree: "/repo/.keiyaku/wt/fridge",
    }),
  );
  assert.match(retained, /^! lag  worktree retained  \/repo\/\.keiyaku\/wt\/fridge$/mu);
  assert.doesNotMatch(retained, /retired/u);
  const preexisting = renderText(
    receipt({
      verb: "review",
      contract: contractId("kei/preexisting-residue"),
      verdict: "satisfied",
      lag: [{ kind: "worktree-retained", path: "/tmp/wt", affects: "none" }],
    }),
  );
  assert.doesNotMatch(preexisting, /lag  worktree|\/tmp\//u, "pre-existing residue stays typed-only");
});

test("a completed placement names the landed diff's shape through the shared diffstat rule", () => {
  const contract = contractId("kei/landed-shape");
  const text = renderText(
    receipt({
      verb: "review",
      contract,
      verdict: "satisfied",
      completion: {
        integration: snapshotId("4".repeat(40)),
        predecessor: snapshotId("3".repeat(40)),
        target: "refs/heads/main",
        scope: { filesChanged: 3, insertions: 4, deletions: 1 },
        verification: { mode: "ran", verdict: "satisfied" },
      },
    }),
  );
  assert.equal(
    text,
    [
      "✓ review satisfied  kei/landed-shape",
      "  target  3333333..4444444  refs/heads/main",
      "  integration result  4444444 · verification satisfied",
      `  changes  3 files · ${renderDiffstat({ added: 4, removed: 1 })}`,
      "✓ accepted",
    ].join("\n"),
  );
  const single = renderText(
    receipt({
      verb: "deliver",
      contract,
      completion: {
        integration: snapshotId("6".repeat(40)),
        predecessor: snapshotId("5".repeat(40)),
        target: "refs/heads/main",
        scope: { filesChanged: 1, insertions: 2, deletions: 0 },
      },
    }),
  );
  assert.ok(single.split("\n").includes(`  changes  1 file · ${renderDiffstat({ added: 2, removed: 0 })}`));
  const unplaced = renderText(
    receipt({
      verb: "deliver",
      contract,
      verificationSubject: { snapshot: snapshotId("a".repeat(40)), mode: "ran", verdict: "satisfied" },
    }),
  );
  assert.doesNotMatch(unplaced, /changes/u, "a deliver without placement carries no changes row");
});

test("deliver renders accepted and stopped continuations from the accepted result", () => {
  const contract = contractId("kei/prerequisite");
  const claimed = contractId("kei/claimed-dependent");
  const stopped = contractId("kei/stopped-dependent");
  assert.equal(
    renderText(
      receipt({
        verb: "deliver",
        contract,
        completion: {
          integration: snapshotId("6".repeat(40)),
          predecessor: snapshotId("5".repeat(40)),
          target: "refs/heads/main",
        },
        continuation: {
          claimed: [claimed],
          stopped: [
            {
              contractId: stopped,
              stop: {
                refusal: {
                  kind: "gates-unsatisfied",
                  contractId: stopped,
                  unmet: [{ gate: gate("reviewed"), current: { kind: "missing" } }],
                },
              },
            },
          ],
        },
      }),
    ),
    [
      "✓ delivered  kei/prerequisite",
      "  target  5555555..6666666  refs/heads/main",
      "✓ accepted",
      "✓ dependent  complete  kei/claimed-dependent",
      "! kei/stopped-dependent  ·  gates unsatisfied",
      "  gate  reviewed  · missing",
    ].join("\n"),
  );
});

const reviewWorkspace = {
  staged: ["src/staged.ts"],
  unstaged: ["src/unstaged.ts"],
  untracked: ["untracked.txt"],
  unmergedPaths: [],
  shortStat: { filesChanged: 3, insertions: 4, deletions: 1 },
} as const;

function assertModeWordingAbsent(text: string): void {
  assert.doesNotMatch(text, /verified now|verification reused from delivery/u);
}

test("review projects a reused unsatisfied Verification as non-gating completion", () => {
  const contract = contractId("kei/review-completion-unsatisfied");
  const predecessor = snapshotId("7".repeat(40));
  const integration = snapshotId("8".repeat(40));
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    facts: [{ contract, entry: "claim", kind: "claimed" as const }],
    settlementLags: [],
  };
  assert.equal(
    renderText({
      ...envelope,
      verb: "review",
      verdict: "satisfied",
      completion: {
        integration,
        predecessor,
        target: "refs/heads/main",
        verification: { mode: "reused", verdict: "unsatisfied" },
      },
      verificationSummary: "[reused bash exit 1]",
      workspace: reviewWorkspace,
    }),
    [
      "✓ review satisfied  kei/review-completion-unsatisfied",
      "  target  7777777..8888888  refs/heads/main",
      "! verification  reused  unsatisfied  · not required by Contract gates",
      "  summary",
      "  [reused bash exit 1]",
      "",
      "✓ accepted",
    ].join("\n"),
  );
});

test("movement projects its deviation and reintegration coordinates", () => {
  const contract = contractId("kei/reintegrated");
  const predecessor = snapshotId("target-1");
  const integrated = snapshotId("integration-2");
  const secondPredecessor = snapshotId("target-3");
  const secondIntegrated = snapshotId("integration-4");
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    settlementLags: [],
  };
  const facts: readonly import("../src/cli/result.js").AcceptedFact[] = [
    {
      contract,
      entry: "reintegration",
      kind: "reintegrated" as const,
      data: { predecessor, snapshot: integrated },
    },
    {
      contract,
      entry: "reintegration-2",
      kind: "reintegrated" as const,
      data: { predecessor: secondPredecessor, snapshot: secondIntegrated },
    },
    { contract, entry: "claim", kind: "claimed" as const },
  ];

  assert.equal(
    renderText({
      ...envelope,
      verb: "deliver",
      facts,
      completion: { integration: secondIntegrated, predecessor: secondPredecessor, target: "refs/heads/main" },
    }),
    ["✓ delivered  kei/reintegrated", "  target  target-3..integration-4  refs/heads/main", "✓ accepted"].join("\n"),
  );

  assert.equal(
    renderText({
      ...envelope,
      verb: "deliver",
      facts: facts.slice(0, 2),
      placement: {
        failure: "target-moved",
        contractId: contract,
        target: "refs/heads/main",
        integratedAt: integrated,
        observed: null,
        attempts: 3,
        observedTreeEqualsCandidate: false,
      },
    }),
    [
      "✓ delivered  kei/reintegrated",
      "! target  moved · re-integrated x2",
      "! target moved  refs/heads/main  integration-2 -> null  attempts 3",
      "  candidate  kept",
    ].join("\n"),
  );
});

test("unmerged index paths render as a complete public refusal", () => {
  const contract = contractId("kei/conflicted");
  assert.equal(
    renderText({
      kind: "refused",
      verb: "deliver",
      contract,
      refusal: { kind: "unmerged-paths", contractId: contract, paths: ["a.txt", "z.txt"] },
    }),
    [
      "× deliver refused",
      "  contract  kei/conflicted",
      "  reason  unmerged paths",
      "  paths",
      "    a.txt",
      "    z.txt",
    ].join("\n"),
  );
});

test("materialized conflict text keeps the exact recovery projection", () => {
  const result: InvocationResult = {
    kind: "integration-conflict-materialized",
    targetHead: snapshotId("b".repeat(40)),
    conflictPaths: ["a.txt", "b.txt"],
    workspace: { kind: "worktree", path: "/repo/.keiyaku/wt/x" },
    handoffBase: snapshotId("a".repeat(40)),
    recovery: {
      deliver: "deliver --include-dirty",
      staging: "not-required",
      materialize: "deliver --materialize-conflict --include-dirty",
    },
  };
  assert.equal(
    renderText(result),
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
      "  option  deliver  deliver --include-dirty · reads worktree bytes, not index",
    ].join("\n"),
  );
  assert.equal(JSON.parse(JSON.stringify(result)).handoffBase, result.handoffBase);
  assert.doesNotMatch(renderText(result), /staging|not-required|UU|please|next|then/u);
});

test("World roster reuses snapshot activity rendering for concrete tool work", () => {
  const calls: readonly Readonly<{ name: string; call: ActivityToolCall; evidence: string }>[] = [
    { name: "read", call: { kind: "read", path: "src/a.ts", offset: 10, limit: 5 }, evidence: "src/a.ts · L10-14" },
    {
      name: "grep",
      call: { kind: "search", query: "snapshot", scope: "content", path: "src" },
      evidence: "snapshot · src",
    },
    {
      name: "edit",
      call: { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts", diffstat: { added: 2, removed: 1 } }] },
      evidence: "src/a.ts — +2 -1",
    },
    {
      name: "bash",
      call: { kind: "run", command: "npm test -- tests/cli-render.test.ts" },
      evidence: "$ npm test -- tests/cli-render.test.ts",
    },
  ];
  const snapshot = openAkumaSnapshot(
    calls.map((member, index) => snapshotRow(completedTool(index + 1, member.name, member.call))),
  );
  const targeted = snapshotActivityLines(snapshot, { columns: 118, color: false });
  for (const member of calls)
    assert.ok(
      targeted.some((line) => line.includes(member.evidence)),
      member.evidence,
    );
  const roster = renderAkuma(akumaWorldReport([activityAkumaRow("aku/worker/aaaa0001", "running", snapshot)]), {
    columns: 120,
    color: false,
  });
  const bounded = snapshotActivityLines(snapshot, { columns: 118, color: false }, { latest: true });
  assert.deepEqual(
    roster.slice(-bounded.length),
    bounded.map((line) => `  ${line}`),
  );
  assert.match(roster.at(-1)!, /✓ run    \$ npm test -- tests\/cli-render\.test\.ts/u);
  assert.doesNotMatch(roster.join("\n"), /src\/a\.ts|activity "/u);
});

test("World answer previews keep the conclusion, while detail keeps its opening", () => {
  const answer = `${"premise ".repeat(35)}conclusion: ship the fix`;
  const snapshot = idleAkumaSnapshot([], answeredOutcome(1, answer));
  const context = { columns: 70, color: false };
  const board = renderAkuma(
    akumaWorldReport([activityAkumaRow("aku/worker/aaaa0001", "asleep", snapshot)]),
    context,
  ).join("\n");
  assert.match(board, /answer “\u2026/u);
  assert.match(board, /conclusion: ship the fix”/u);
  assert.doesNotMatch(board, /premise premise premise premise premise premise/u);
  const detail = snapshotActivityLines(snapshot, context).join("\n");
  assert.match(detail, /“premise premise/u);
  assert.doesNotMatch(detail, /“\.\.\./u);
});

test("long read and edit previews keep path tails with range and diffstat detail", () => {
  const longRead = "/worktrees/one/very/deep/project/architecture/reader/ReadMeber.ts";
  const longEdit = "/worktrees/one/very/deep/project/architecture/changes/ChangedFile.ts";
  const rows = [
    snapshotRow(completedTool(1, "read", { kind: "read", path: longRead, offset: 20, limit: 3 })),
    snapshotRow(
      completedTool(2, "edit", {
        kind: "fileChange",
        changes: [{ op: "update", path: longEdit, diffstat: { added: 5, removed: 2 } }],
      }),
    ),
  ];

  for (const columns of [100, 48]) {
    const lines = snapshotActivityLines(openAkumaSnapshot(rows), { columns, color: false });
    const readPath = columns === 100 ? longRead : "…/reader/ReadMeber.ts";
    const editPath = columns === 100 ? longEdit : "…/changes/ChangedFile.ts";
    assert.ok(
      lines.some((line) => line.includes(`${readPath} · L20-22`)),
      lines.join("\\n"),
    );
    assert.ok(
      lines.some((line) => line.includes(`${editPath} — +5 -2`)),
      lines.join("\\n"),
    );
    for (const line of lines) assert.ok(displayColumns(line) <= columns, `${columns} columns: ${line}`);
  }

  const short = snapshotActivityLines(
    openAkumaSnapshot([
      snapshotRow(completedTool(1, "read", { kind: "read", path: "src/short.ts", offset: 2, limit: 2 })),
    ]),
    { columns: 100, color: false },
  );
  assert.ok(short.some((line) => line.includes("src/short.ts · L2-3")));
  assert.ok(short.every((line) => !line.includes("…")));
});

test("settled file changes retain exact stats or show unknown stats", () => {
  const snapshot = openAkumaSnapshot([
    snapshotRow(
      completedTool(1, "edit", {
        kind: "fileChange",
        changes: [{ op: "update", path: "src/exact.ts", diffstat: { added: 2, removed: 1 } }],
      }),
    ),
    snapshotRow(completedTool(2, "write", { kind: "fileChange", changes: [{ op: "add", path: "src/unknown.ts" }] })),
    snapshotRow(
      completedTool(3, "edit", {
        kind: "fileChange",
        changes: [
          { op: "update", path: "src/known.ts", diffstat: { added: 3, removed: 2 } },
          { op: "update", path: "src/unknown.ts" },
        ],
      }),
    ),
  ]);
  const lines = snapshotActivityLines(snapshot, { columns: 120, color: false });

  assert.ok(lines.some((line) => line.includes("src/exact.ts — +2 -1")));
  assert.ok(lines.some((line) => line.includes("src/unknown.ts — ~")));
  assert.ok(lines.some((line) => line.includes("2 files · src/known.ts ... — ~")));
});

test("World roster keeps the honest fallback for unknown tool calls", () => {
  const snapshot = openAkumaSnapshot([
    snapshotRow(completedTool(1, "mystery", { kind: "other", display: "Mystery Tool" })),
    snapshotRow(completedTool(2, "custom-tool", { kind: "other", display: "" })),
  ]);
  const roster = renderAkuma(akumaWorldReport([activityAkumaRow("aku/worker/cccc0003", "running", snapshot)]), {
    columns: 120,
    color: false,
  }).join("\n");
  assert.match(roster, /✓ custom-tool/u);
});

test("the output law names the current mark vocabulary and retires the one-check sentence", () => {
  const law = readFileSync(fileURLToPath(new URL("../docs/cli-output.md", import.meta.url)), "utf8");
  assert.doesNotMatch(law, /at most once per stream/u, "the retired one-check law is gone");
  assert.doesNotMatch(law, /settled intermediate activity uses the plain/u);
  assert.match(law, /`✓` marks a\s+successfully completed action row/u, "the replacement law exists");
  assert.match(law, /`│` is the neutral rail for voice rows and told Tells/u);
});

test("a settled successful tool wears ✓ again while voice rows and told Tells stay on the rail", () => {
  const id = "aku/worker/abcd0040";
  const status = parseAkumaStatus({
    id,
    life: "asleep",
    allowed: [],
    timeline: idleAkumaSnapshot([
      { kind: "row", row: completedTool(1, "read", { kind: "read", path: "src/a.ts", offset: 0, limit: 1 }) },
      {
        kind: "row",
        row: { kind: "said", sequence: 2, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "spoken" },
      },
      {
        kind: "row",
        row: {
          kind: "tell",
          sequence: 3,
          at: AKUMA_ACTIVITY_AT,
          tellId: "tell/mark-law",
          text: "told direction",
          state: "told",
          deliveries: [{ route: "launch", turnSequence: 1, deliveredAt: AKUMA_ACTIVITY_AT }],
        },
      },
    ]),
  });
  const text = snapshotText({ status, contract: { kind: "none" } }, { columns: 100, color: false });
  assert.match(text, /✓ read/u, "a settled tool action affirms success");
  assert.match(text, /│ say/u, "a voice row stays on the rail");
  assert.match(text, /│ told/u, "a told Tell stays on the rail");
  assert.ok((text.match(/✓/gu) ?? []).length >= 2, "multiple success marks are normal on one stream");
});

test("generic tool rows preserve semantic and common summaries", () => {
  const lines = genericLines(
    [
      [1, "future_tool", preview({ alpha: 1, beta: "x", gamma: { delta: [true, null] } })],
      [2, "mystery", preview({})],
      [3, "silent"],
      [4, "notes_read", preview({ address: "project/notes.md", offset_chars: 12, limit_chars: 400 })],
      [5, "notes_read", preview({ path: "legacy.md" })],
      [6, "history_read", preview({ item_id: "item-9", window_id: "win-2", offset_chars: 0, limit_chars: 50 })],
      [7, "history_list", preview({ role: "assistant", recent_first: false, limit: 20 })],
      [8, "history_list", preview({ role: "user" })],
      [9, "get_context_remaining", preview({})],
      [10, "future_tool", { json: '{"alpha":1,"beta":"long', truncated: true }],
    ],
    200,
  );
  const text = lines.join("\n");
  assert.match(
    text,
    /future_tool\s+\{"alpha":1,"beta":"x","gamma":\{"delta":\[true,null\]\}\}/u,
    "nested compact JSON keeps types and order",
  );
  assert.match(text, /notes_read\s+project\/notes\.md · from 12 · 400 chars/u);
  assert.match(text, /notes_read\s+legacy\.md/u, "legacy path remains an admissible notes_read address");
  assert.match(text, /history_read\s+item-9 · win-2 · from 0 · 50 chars/u);
  assert.match(text, /history_list\s+role assistant · oldest first · 20 rows/u);
  assert.match(text, /future_tool\s+\{"alpha":1,"beta":"long…/u, "a truncated capture keeps its explicit ellipsis");
  assert.doesNotMatch(text, /(?:^|\s)use(?:\s|$)/u, "a generic row never renders the retired use verb");
  assert.match(text, /history_list\s+role user(?:\s|$)/u, "absent list options stay absent, never defaulted");
  assert.doesNotMatch(text, /newest first · 20 rows/u);
  for (const name of ["mystery", "silent", "get_context_remaining"])
    assert.ok(
      lines.some((line) => new RegExp(`✓ ${name}$`, "u").test(line)),
      `${name} with empty or absent arguments renders no summary`,
    );
});

test("generic tool rows preserve whole-field and indivisible-value omission", () => {
  const cases = [
    {
      columns: 40,
      name: "future_tool",
      input: preview({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }),
      expected: /future_tool\s+\{"a":1\} \+5 fields$/u,
      absent: undefined,
      message: "leading whole fields survive with an explicit trailing-field count",
    },
    {
      columns: 40,
      name: "future_tool",
      input: preview({ data: "x".repeat(400) }),
      expected: /future_tool\s+\{"data":"x+…$/u,
      absent: undefined,
      message: "a first value too large becomes one visibly truncated prefix",
    },
    {
      columns: 30,
      name: "ft",
      input: preview({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }),
      expected: /…$/u,
      absent: /"f":6/u,
      message: "an unfittable field count still shows omission",
    },
    {
      columns: 24,
      name: "ft",
      input: preview({ data: "x".repeat(400) }),
      expected: /…$/u,
      absent: undefined,
      message: "an indivisible value truncates visibly",
    },
  ] as const;
  for (const { columns, name, input, expected, absent, message } of cases) {
    const line = genericLines([[1, name, input]], columns)[0]!;
    assert.match(line, expected, message);
    if (absent) assert.doesNotMatch(line, absent, "trailing fields are never silently present");
  }
});

test("generic tool rows keep failure diagnostics beside argument previews", () => {
  const lines = snapshotActivityLines(
    openAkumaSnapshot([
      snapshotRow(
        completedTool(
          1,
          "future_tool",
          { kind: "other", display: "future_tool", input: preview({ alpha: 1 }) },
          { status: "error", message: "refused" },
        ),
      ),
      snapshotRow(
        completedTool(
          2,
          "future_tool",
          { kind: "other", display: "future_tool", input: preview({}) },
          { status: "error", exitCode: 7 },
        ),
      ),
    ]),
    { columns: 200, color: false },
  );
  for (const [pattern, message] of [
    [/\{"alpha":1\} — error · refused$/u, "argument evidence and its failure stay together"],
    [/future_tool\s+— exit 7$/u, "an empty argument object never swallows failure evidence"],
  ] as const)
    assert.ok(
      lines.some((line) => pattern.test(line)),
      `${message}: ${lines.join("\n")}`,
    );
  assert.doesNotMatch(lines.join("\n"), / — ok/u);
  const legacy = snapshotActivityLines(
    openAkumaSnapshot([
      snapshotRow(
        completedTool(
          1,
          "mystery",
          { kind: "other", display: "Mystery Tool" },
          { status: "error", message: "refused" },
        ),
      ),
    ]),
    { columns: 120, color: false },
  ).join("\n");
  assert.match(legacy, /mystery\s+— error · refused$/mu);
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
  assert.doesNotMatch(lines[3]!, /\{/u, "its arguments trim away entirely");
  for (const line of lines.slice(4, 6)) {
    assert.ok(line.includes(family), "a ZWJ family stays whole");
    assert.doesNotMatch(line, /\uFFFD/u, "ZWJ is never replaced by a replacement character");
  }
  assert.equal(lines[6]!.indexOf("{"), 16, "a name longer than six cells uses its own action width");
  assert.ok(lines[7]!.includes("a_very_long_tool_name_here"), "an over-long name stays complete");
  assert.ok(lines[7]!.endsWith("…"), "args truncate before the name does");
  assert.ok(lines[8]!.includes("🙂") && lines[8]!.endsWith("…"), "a truncated emoji argument stays grapheme-safe");
});

test("activity rows share one six-cell default action column in plain and plural layouts", () => {
  const note = { kind: "note", sequence: 1, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "payload" } as const;
  const plainNote = snapshotActivityLines(openAkumaSnapshot([snapshotRow(note)]), { columns: 80, color: false })[0]!;
  const plainTool = genericLines([[1, "tool", preview({ value: 1 })]], 80)[0]!;
  assert.equal(plainNote.indexOf("payload"), plainTool.indexOf("{"), "plain rows share the default action column");

  const first = "aku/worker/abcd0050";
  const second = "aku/worker/abcd0051";
  const baseline = (id: string) =>
    parseAkumaStatus({ id, life: "running", allowed: [], timeline: openAkumaSnapshot([]) });
  const noted = parseAkumaStatus({
    id: first,
    life: "running",
    allowed: [],
    timeline: openAkumaSnapshot([snapshotRow(note)]),
  });
  const tooled = parseAkumaStatus({
    id: second,
    life: "running",
    allowed: [],
    timeline: openAkumaSnapshot([snapshotRow(genericTool(1, "tool", preview({ value: 1 })))]),
  });
  const stream = waitObservationStream({ columns: 80, color: false }, { now: () => 0 });
  stream.select([{ id: first }, { id: second }]);
  stream.observe([observed(baseline(first)), observed(baseline(second))]);
  const pluralRows = stream.observe([observed(noted), observed(tooled)]);
  const pluralNote = pluralRows.find((line) => line.includes("payload"));
  const pluralTool = pluralRows.find((line) => line.includes('{"value":1}'));
  assert.ok(pluralNote, "plural narrative row is present");
  assert.ok(pluralTool, "plural tool row is present");
  assert.equal(pluralNote.indexOf("payload"), pluralTool.indexOf("{"), "plural rows share the default action column");
});

test("a plural wait aligns generic tool rows under one source column", () => {
  const targets = [
    { id: "aku/worker/abcd0050", alias: "@first", body: "alpha" },
    { id: "aku/worker/abcd0051", alias: "@second", body: "beta" },
  ] as const;
  const baseline = (id: string) =>
    parseAkumaStatus({ id, life: "running", allowed: [], timeline: openAkumaSnapshot([]) });
  const noticed = (id: string, body: string) =>
    parseAkumaStatus({
      id,
      life: "running",
      allowed: [],
      timeline: openAkumaSnapshot([snapshotRow(genericTool(1, "future_tool", preview({ body })))]),
    });
  const stream = waitObservationStream({ columns: 80, color: false }, { now: () => 0 });
  stream.select(targets.map(({ id, alias }) => ({ id, alias })));
  stream.observe(targets.map(({ id }) => observed(baseline(id))));
  const lines = stream.observe(targets.map(({ id, body }) => observed(noticed(id, body))));
  const rows = lines.filter((line) => line.includes("future_tool"));
  assert.equal(rows.length, 2, "one attributed row per source");
  assert.equal(new Set(rows.map((line) => line.indexOf("✓"))).size, 1, "the mark and source column stay aligned");
  for (const row of rows) assert.ok(displayColumns(row) <= 80, `one line within 80 columns: ${row}`);
  assert.ok(rows.some((row) => row.includes('{"body":"alpha"}')));
  assert.ok(rows.some((row) => row.includes('{"body":"beta"}')));
});

test("World roster keeps active, error and truncated activity marks truthful", () => {
  const active = openAkumaSnapshot([
    snapshotRow(activeTool(1, "bash", { kind: "run", command: "keiyaku wait --all" })),
  ]);
  const activeRoster = renderAkuma(akumaWorldReport([activityAkumaRow("aku/worker/aabb0006", "running", active)]), {
    columns: 120,
    color: false,
  }).join("\n");
  assert.match(activeRoster, /\? run    \$ keiyaku wait --all/u);
  assert.doesNotMatch(activeRoster, /— ok/u);

  const failed = openAkumaSnapshot([
    snapshotRow(completedTool(2, "bash", { kind: "run", command: "npm test" }, { status: "error", exitCode: 1 })),
  ]);
  const failedRoster = renderAkuma(akumaWorldReport([activityAkumaRow("aku/worker/ccdd0007", "running", failed)]), {
    columns: 120,
    color: false,
  }).join("\n");
  assert.match(failedRoster, /! run    \$ npm test — exit 1/u);

  const truncated = openAkumaSnapshot([
    snapshotRow({ kind: "said", sequence: 3, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "x".repeat(400) }),
  ]);
  const truncatedActivity = snapshotActivityLines(truncated, { columns: 120, color: false });
  assert.equal(truncatedActivity.length, 2, "a said row renders within its bounded line budget");
  const truncatedRoster = renderAkuma(
    akumaWorldReport([activityAkumaRow("aku/worker/eeff0008", "running", truncated)]),
    { columns: 120, color: false },
  ).join("\n");
  assert.match(truncatedRoster, /…”/u);
  assert.ok(!truncatedRoster.includes("x".repeat(200)), "truncation bounds retained said text");
});

test("a sleeping worker's outcome row is its ending, not a repeated completion mark", () => {
  const sleeping = parseAkumaStatus({
    id: "aku/worker/abcd0001",
    life: "asleep",
    allowed: [],
    timeline: idleAkumaSnapshot([], answeredOutcome(1, "the answer")),
  });
  const snapshot = snapshotText({ status: sleeping, contract: { kind: "none" } }, { columns: 80, color: false });
  assert.match(snapshot, /✓ answer “the answer”$/u, "the timeline ends at its outcome row");
  assert.doesNotMatch(snapshot, /✓ completed/u, "the answered outcome is already the ending");
  assert.equal((snapshot.match(/✓/gu) ?? []).length, 1, "one check on one stream");

  const answerless = parseAkumaStatus({
    id: "aku/worker/abcd0002",
    life: "asleep",
    allowed: [],
    timeline: idleAkumaSnapshot([]),
  });
  const answerlessText = snapshotText(
    { status: answerless, contract: { kind: "none" } },
    { columns: 80, color: false },
  );
  assert.match(answerlessText, /✓ completed$/mu, "an answer-less sleeper keeps its closer");

  const returned = waitText(
    {
      kind: "akuma",
      action: "wait",
      result: {
        mode: "all",
        reason: "completed",
        observations: [{ status: sleeping, contract: { kind: "none" }, createdTasks: { kind: "present", rows: [] } }],
        unobserved: [],
      },
    },
    { columns: 80, color: false },
  );
  assert.match(returned, /^✓ answered aku\/worker\/abcd0001$/mu, "an outcome surface uses an outcome verb");
  assert.doesNotMatch(returned, /came back/u, "the retired life label is absent");
});

test("status text and JSON report the Akuma execution workdir", () => {
  const id = "aku/worker/abcd0009";
  const status = parseAkumaStatus({
    id,
    life: "running",
    cwd: "/work/tree",
    allowed: [],
    timeline: openAkumaSnapshot([]),
  });
  const invocation = parseArgv(["status", id]);
  assert.ok("command" in invocation);
  const result: Extract<AkumaInvocationResult, { action: "status" }> = {
    kind: "akuma",
    action: "status",
    status: { status, contract: { kind: "none" }, createdTasks: { kind: "present", rows: [] } },
  };
  assert.match(renderAkumaText(invocation.command, result), /^cwd {2}\/work\/tree$/mu);
  const json = JSON.parse(renderAkumaJson(result)) as { status: { cwd?: string } };
  assert.equal(json.status.cwd, "/work/tree");
});

test("status renders selected activity evidence while preserving history and compact selection", () => {
  const id = "aku/worker/abcd0040";
  const thought = {
    kind: "thought" as const,
    sequence: 1,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text: "internal thought",
  };
  const completed = (sequence: number, command: string) => completedTool(sequence, "bash", { kind: "run", command });
  const active = (sequence: number, command: string) => activeTool(sequence, "bash", { kind: "run", command });

  for (const count of [0, 1, 2, 3, 4, 5]) {
    const lines = snapshotActivityLines(
      openAkumaSnapshot(
        Array.from({ length: count }, (_, index) => snapshotRow(completed(index + 1, `small-${index + 1}`))),
      ),
      { columns: 120, color: false },
    );
    assert.doesNotMatch(lines.join("\n"), /omitted/u, `${count} tools fit the focused snapshot budget`);
    for (let sequence = 1; sequence <= count; sequence += 1)
      assert.equal(
        lines.filter((line) => line.includes(`small-${sequence}`)).length,
        1,
        `tool ${sequence} renders once`,
      );
  }

  const providerGaps = snapshotActivityLines(
    openAkumaSnapshot([
      ...Array.from({ length: 4 }, (_, index) => snapshotRow(completed(index + 1, `gap-${index + 1}`))),
      { kind: "gap", count: 2 },
      ...Array.from({ length: 5 }, (_, index) => snapshotRow(completed(index + 5, `gap-${index + 5}`))),
    ]),
    { columns: 120, color: false },
  );
  assert.deepEqual(
    providerGaps.filter((line) => line.includes("omitted")),
    [`${" ".repeat(5)} ⋮ 2 omitted`],
  );

  const adjacentGaps = snapshotActivityLines(
    openAkumaSnapshot([
      { kind: "gap", count: 1 },
      { kind: "gap", count: 2 },
      snapshotRow(completed(3, "after-adjacent-gaps")),
    ]),
    { columns: 120, color: false },
  );
  assert.deepEqual(
    adjacentGaps.filter((line) => line.includes("omitted")),
    [`${" ".repeat(5)} ⋮ 3 omitted`],
  );

  const separatedGaps = snapshotActivityLines(
    openAkumaSnapshot([
      { kind: "gap", count: 1 },
      snapshotRow({ kind: "note", sequence: 2, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "visible separator" }),
      { kind: "gap", count: 2 },
    ]),
    { columns: 120, color: false },
  );
  assert.deepEqual(
    separatedGaps.filter((line) => line.includes("omitted")),
    [`${" ".repeat(5)} ⋮ 1 omitted`, `${" ".repeat(5)} ⋮ 2 omitted`],
  );

  const focusedEntries = [
    snapshotRow(thought),
    snapshotRow(completed(2, "c1")),
    snapshotRow(completed(3, "c2")),
    snapshotRow(completed(4, "c3")),
    snapshotRow(completed(5, "c4")),
    snapshotRow({ kind: "note" as const, sequence: 6, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "between" }),
    snapshotRow(completed(7, "c5")),
    snapshotRow(completed(8, "c6")),
    snapshotRow(completed(9, "c7")),
    snapshotRow({ kind: "said" as const, sequence: 10, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "after" }),
    snapshotRow(completed(11, "c8")),
    snapshotRow(active(12, "c9")),
  ];
  const snapshot = openAkumaSnapshot(focusedEntries);
  const status = parseAkumaStatus({ id, life: "running", allowed: [], timeline: snapshot });
  const statusInvocation = parseArgv(["status", id]);
  assert.ok("command" in statusInvocation);
  const statusText = renderAkumaText(statusInvocation.command, {
    kind: "akuma",
    action: "status",
    status: { status, contract: { kind: "none" }, createdTasks: { kind: "present", rows: [] } },
  });
  assert.doesNotMatch(statusText, /internal thought/u);
  for (const command of ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"])
    assert.equal(
      (statusText.match(new RegExp(`\\$ ${command}`, "gu")) ?? []).length,
      1,
      `selected ${command} renders once`,
    );
  assert.match(statusText, /\? run    \$ c9/u, "the active final tool remains visible as unsettled");
  assert.doesNotMatch(statusText, /● run\s+\$/u, "status never asserts live activity");
  assert.doesNotMatch(statusText, /omitted/u, "status does not re-fold the selected tool evidence");
  assert.ok(statusText.indexOf("$ c4") < statusText.indexOf("between"));
  assert.ok(statusText.indexOf("between") < statusText.indexOf("$ c5"));
  assert.ok(statusText.indexOf("$ c7") < statusText.indexOf("after"));
  assert.ok(statusText.indexOf("after") < statusText.indexOf("$ c8"));

  const compact = snapshotActivityLines(snapshot, { columns: 120, color: false }, { latest: true }).join("\n");
  assert.match(compact, /\$ c9/u);
  assert.doesNotMatch(compact, /c1|omitted/u, "latest-only callers keep their compact selection");

  const outcomeSnapshot = idleAkumaSnapshot(
    [
      snapshotRow(completed(2, "c1")),
      snapshotRow(completed(3, "c2")),
      snapshotRow(completed(4, "c3")),
      snapshotRow(completed(5, "c4")),
      snapshotRow({ kind: "note" as const, sequence: 6, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "between" }),
      snapshotRow(completed(7, "c5")),
      snapshotRow(completed(8, "c6")),
      snapshotRow(completed(9, "c7")),
      snapshotRow({ kind: "said" as const, sequence: 10, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "after" }),
      snapshotRow(completed(11, "c8")),
      snapshotRow(completed(12, "c9")),
    ],
    answeredOutcome(13, "final outcome"),
  );
  const answeredStatus = parseAkumaStatus({ id, life: "asleep", allowed: [], timeline: outcomeSnapshot });
  const outcomeText = renderAkumaText(statusInvocation.command, {
    kind: "akuma",
    action: "status",
    status: { status: answeredStatus, contract: { kind: "none" }, createdTasks: { kind: "present", rows: [] } },
  });
  assert.match(outcomeText, /final outcome/u, "an answered status retains its complete outcome");
  assert.doesNotMatch(outcomeText, /✓ say\s+“”/u, "a retained answer never becomes an empty say");
  assert.match(outcomeText, /\$ c5/u, "settled status retains selected activity around its outcome");

  const failedOutcome: OutcomeRow = {
    kind: "outcome",
    sequence: 13,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    outcome: { kind: "failed", historyId: "history-1", diagnostic: "retained provider diagnostic" },
  };
  const failedText = renderAkumaText(statusInvocation.command, {
    kind: "akuma",
    action: "status",
    status: {
      status: parseAkumaStatus({
        id,
        life: "asleep",
        allowed: [],
        timeline: idleAkumaSnapshot(outcomeSnapshot.entries, failedOutcome),
      }),
      contract: { kind: "none" },
      createdTasks: { kind: "present", rows: [] },
    },
  });
  assert.match(failedText, /retained provider diagnostic/u, "a failed status retains its diagnostic");
  assert.match(failedText, /\$ c5/u, "failed status retains selected activity around its diagnostic");

  const historyInvocation = parseArgv(["history", id]);
  assert.ok("command" in historyInvocation);
  const history = {
    rows: focusedEntries.flatMap((entry) => (entry.kind === "row" ? [entry.row] : [])),
    omitted: 55,
    hasEarlier: true,
    hasLater: false,
    historyLost: false,
    lowestRetained: 1,
    highest: 12,
  };
  const historyText = renderAkumaText(historyInvocation.command, {
    kind: "akuma",
    action: "history",
    akuma: status.id,
    mode: "page",
    history,
    historyResult: { kind: "history", id: status.id, history, contract: { kind: "none" } },
  });
  assert.match(historyText, /internal thought/u, "history keeps retained thought narration");
  assert.match(historyText, /      ⋮ 55 earlier events · showing last 12/u);
  assert.doesNotMatch(historyText, /earlier turns/u);
  assert.doesNotMatch(historyText, /●/u, "history never asserts live activity");
  for (const command of ["c4", "c5", "c6", "c7"])
    assert.match(historyText, new RegExp(`\\$ ${command}`, "u"), `history keeps intermediate tool ${command}`);
});

test("open full snapshots preserve projected evidence order", () => {
  const context = { columns: 120, color: false } as const;
  const call = snapshotRow({
    kind: "call" as const,
    sequence: 1,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text: "initial commission",
  });
  const callSnapshot = {
    ...openAkumaSnapshot([
      call,
      { kind: "gap" as const, count: 2 },
      snapshotRow(completedTool(4, "bash", { kind: "run", command: "after-call-gap" })),
      { kind: "gap" as const, count: 3 },
      snapshotRow(activeTool(8, "bash", { kind: "run", command: "call-active" })),
    ]),
    openingSequence: 1,
  };
  const launchTell = snapshotRow({
    kind: "tell" as const,
    sequence: 1,
    at: AKUMA_ACTIVITY_AT,
    tellId: "tell/opening-launch",
    text: "initial launch direction",
    state: "told" as const,
    deliveries: [{ route: "launch" as const, turnSequence: 1, deliveredAt: AKUMA_ACTIVITY_AT }],
  });
  const tellSnapshot = {
    ...openAkumaSnapshot([
      launchTell,
      { kind: "gap" as const, count: 1 },
      snapshotRow(completedTool(3, "bash", { kind: "run", command: "after-tell-gap" })),
      { kind: "gap" as const, count: 4 },
      snapshotRow(activeTool(8, "bash", { kind: "run", command: "tell-active" })),
    ]),
    openingSequence: 1,
  };
  const assertEvidenceOrder = (text: string, expected: readonly string[]): void => {
    let previous = -1;
    for (const evidence of expected) {
      const index = text.indexOf(evidence);
      assert.ok(index > previous, `${evidence} follows its projected predecessor:\n${text}`);
      assert.equal(text.split(evidence).length - 1, 1, `${evidence} renders once:\n${text}`);
      previous = index;
    }
  };

  assertEvidenceOrder(snapshotActivityLines(callSnapshot, context).join("\n"), [
    "initial commission",
    "⋮ 2 omitted",
    "$ after-call-gap",
    "⋮ 3 omitted",
    "$ call-active",
  ]);
  assertEvidenceOrder(snapshotActivityLines(tellSnapshot, context).join("\n"), [
    "initial launch direction",
    "⋮ 1 omitted",
    "$ after-tell-gap",
    "⋮ 4 omitted",
    "$ tell-active",
  ]);
});

test("current attempt boundaries lead live streams exactly once", () => {
  const context = { columns: 120, color: false } as const;
  const call = snapshotRow({
    kind: "call" as const,
    sequence: 1,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text: "initial commission",
  });
  const tool = snapshotRow(completedTool(2, "bash", { kind: "run", command: "after-boundary" }));
  const active = snapshotRow(activeTool(3, "bash", { kind: "run", command: "still-running" }));
  const initial = { ...openAkumaSnapshot([call, tool, active]), openingSequence: 1 };
  const snapshot = snapshotActivityLines(initial, context).join("\n");
  assert.match(snapshot, /^\d{2}:\d{2} │ call +initial commission/mu);
  assert.ok(snapshot.indexOf("initial commission") < snapshot.indexOf("after-boundary"));
  assert.equal((snapshot.match(/initial commission/gu) ?? []).length, 1);
  assert.match(snapshotActivityLines(initial, context, { latest: true }).join("\n"), /still-running/u);

  const live = activityStream(context);
  const liveRows = [...live(liveActivity(initial)), ...live(liveActivity(initial)), ...live.flush()].join("\n");
  assert.match(liveRows, /^\d{2}:\d{2} │ call +initial commission/mu);
  assert.ok(liveRows.indexOf("initial commission") < liveRows.indexOf("after-boundary"));
  assert.equal((liveRows.match(/initial commission/gu) ?? []).length, 1);

  const id = "aku/worker/abcd0101";
  const status = parseAkumaStatus({ id, life: "running", allowed: [], timeline: initial });
  const statusText = snapshotText({ status, contract: { kind: "none" } }, context);
  assert.ok(statusText.indexOf("initial commission") < statusText.indexOf("after-boundary"));

  const wait = waitObservationStream(context, { now: () => 0 });
  const opening = wait.observe([observed(status)]).join("\n");
  assert.match(opening, /initial commission/u);
  assert.doesNotMatch(opening, /after-boundary/u, "the wait baseline keeps its ordinary rows out of the live budget");
  assert.equal((opening.match(/initial commission/gu) ?? []).length, 1);

  const wake = snapshotRow({
    kind: "tell" as const,
    sequence: 4,
    at: AKUMA_ACTIVITY_AT,
    tellId: "tell/wake",
    text: "resume with the new direction",
    state: "told" as const,
    deliveries: [{ route: "launch" as const, turnSequence: 1, deliveredAt: AKUMA_ACTIVITY_AT }],
  });
  const woken = {
    ...openAkumaSnapshot([
      wake,
      snapshotRow(completedTool(5, "bash", { kind: "run", command: "after-wake" })),
      snapshotRow(activeTool(6, "bash", { kind: "run", command: "waking" })),
    ]),
    openingSequence: 4,
  };
  const wakeSnapshot = snapshotActivityLines(woken, context).join("\n");
  assert.match(wakeSnapshot, /^\d{2}:\d{2} │ told +“resume with the new direction”/mu);
  assert.ok(wakeSnapshot.indexOf("resume with the new direction") < wakeSnapshot.indexOf("after-wake"));
  assert.equal((wakeSnapshot.match(/resume with the new direction/gu) ?? []).length, 1);
  const wakeStatusText = snapshotText(
    {
      status: parseAkumaStatus({ id: "aku/worker/abcd0102", life: "running", allowed: [], timeline: woken }),
      contract: { kind: "none" },
    },
    context,
  );
  assert.ok(wakeStatusText.indexOf("resume with the new direction") < wakeStatusText.indexOf("after-wake"));

  const wakeWait = waitObservationStream(context, { now: () => 0 });
  const wakeOpening = wakeWait
    .observe([observed(parseAkumaStatus({ id: "aku/worker/abcd0102", life: "running", allowed: [], timeline: woken }))])
    .join("\n");
  assert.match(wakeOpening, /│ told +“resume with the new direction”/u);
  assert.doesNotMatch(wakeOpening, /after-wake/u);
});

test("current attempt boundaries consume the projection opening identity", () => {
  const context = { columns: 120, color: false } as const;
  const named = snapshotRow({
    kind: "tell" as const,
    sequence: 1,
    at: AKUMA_ACTIVITY_AT,
    tellId: "tell/named-opening",
    text: "named opening",
    state: "told" as const,
    deliveries: [{ route: "launch" as const, turnSequence: 1, deliveredAt: AKUMA_ACTIVITY_AT }],
  });
  const activity = snapshotRow(completedTool(2, "bash", { kind: "run", command: "after-opening" }));
  const namedSnapshot = { ...openAkumaSnapshot([named, activity]), openingSequence: 1 };
  const seeded = activityStream(context).seed(liveActivity(namedSnapshot)).join("\n");
  assert.match(seeded, /named opening/u);
  assert.doesNotMatch(seeded, /after-opening/u);
  assert.match(seeded, /⋮ 1 omitted/u, "a seeded opening marks its skipped settled successor");
  assert.equal((seeded.match(/named opening/gu) ?? []).length, 1);

  assert.deepEqual(activityStream(context).seed(liveActivity(openAkumaSnapshot([named, activity]))), []);
});

test("live companion preserves one evicted mutable row across a wait baseline", () => {
  const id = "aku/worker/abcd0103";
  const opening: ActivityRow = {
    kind: "call",
    sequence: 1,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text: "companion opening",
  };
  const mutable = activeTool(3, "bash", { kind: "run", command: "mutable tool" });
  const baseline: ActivityRow = {
    kind: "note",
    sequence: 5,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text: "baseline note",
  };
  const sentinel = activeTool(6, "bash", { kind: "run", command: "still active" });
  const initialTimeline = {
    ...openAkumaSnapshot([snapshotRow(opening), snapshotRow(mutable), snapshotRow(baseline), snapshotRow(sentinel)]),
    openingSequence: 1,
  };
  const initialStatus = parseAkumaStatus({ id, life: "running", allowed: [], timeline: initialTimeline });
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => 0 });
  const seeded = stream.observe([
    observed(initialStatus, { contract: { kind: "none" } }, [opening, mutable, baseline, sentinel]),
  ]);
  assert.match(seeded.join("\n"), /companion opening[\s\S]*⋮ 1 omitted/u);
  assert.doesNotMatch(seeded.join("\n"), /baseline note|mutable tool/u);

  const completed = completedTool(8, "bash", { kind: "run", command: "mutable tool" });
  const fresh: ActivityRow = {
    kind: "note",
    sequence: 7,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text: "fresh note",
  };
  const laterStatus = parseAkumaStatus({ id, life: "asleep", allowed: [], timeline: idleAkumaSnapshot([]) });
  const later = observed(laterStatus, { contract: { kind: "none" } }, [opening, baseline, fresh, completed]);
  const text = stream.observe([later]).join("\n");
  assert.match(text, /fresh note[\s\S]*mutable tool/u);
  assert.deepEqual(stream.observe([later]), []);
});

test("call, wait, and ask stream projected overlapping tool completions once in completion order", () => {
  const id = parseAkuId("aku/worker/abcd0104").id;
  const at = (minute: number) => `2026-08-10T00:${String(minute).padStart(2, "0")}:00.000Z`;
  const tool = (sequence: number, phase: "started" | "completed", name: string): TimelineFact =>
    activityFact(sequence, 1, at(sequence), {
      type: "tool",
      phase,
      id: name,
      name: "bash",
      call: { kind: "run", command: name },
      ...(phase === "completed" ? { result: { status: "ok" as const } } : {}),
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
    const ledger = projectTurns(facts);
    return {
      status: parseAkumaStatus({
        id,
        life: "running",
        allowed: [],
        timeline: selectSnapshot(ledger, { aperture: "monitoring" }).snapshot,
      }),
      ordinarySelected: 0,
      rows: ledger.rows,
    };
  };
  const call = callObservationStream(
    { columns: 120, color: false },
    { id, contract: { kind: "none" }, facts: [] },
    { now: () => Date.parse(at(1)) },
  );
  const wait = waitObservationStream({ columns: 120, color: false }, { now: () => Date.parse(at(1)) });
  const ask = askProgressStream(undefined, undefined, { columns: 120, color: false });
  const admissionRow = projection(first).rows.find((row) => row.kind === "tell");
  assert.ok(admissionRow?.kind === "tell");
  ask.admitted(
    { admission: { fact: "recorded", tellId: "tell/overlap" }, row: admissionRow, wake: { kind: "told" } },
    id,
  );
  const streams = [
    (value: ReturnType<typeof projection>) => call.observe(value),
    (value: ReturnType<typeof projection>) =>
      wait.observe([observed(value.status, { contract: { kind: "none" } }, value.rows)]),
    (value: ReturnType<typeof projection>) => ask.observe(value),
  ];
  for (const observe of streams) {
    observe(projection(first));
    const b = observe(projection(second)).join("\n");
    const a = observe(projection(third)).join("\n");
    assert.match(b, /\$ B[\s\S]*between tools/u);
    assert.match(a, /\$ A/u);
    assert.match(b, new RegExp(clockAt(Date.parse(at(6))), "u"));
    assert.match(a, new RegExp(clockAt(Date.parse(at(8))), "u"));
    assert.deepEqual(observe(projection(third)), []);
  }
});

test("narrative selection is partition-invariant and repeated pending snapshots do not replay", () => {
  const tool = (sequence: number) =>
    snapshotRow(completedTool(sequence, "bash", { kind: "run", command: `c${sequence}` }));
  const rows = [
    tool(1),
    tool(2),
    tool(3),
    tool(4),
    snapshotRow({ kind: "thought", sequence: 5, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "hidden between" }),
    snapshotRow({ kind: "note", sequence: 6, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "between" }),
    tool(7),
    tool(8),
    snapshotRow({ kind: "thought", sequence: 9, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "hidden after" }),
    snapshotRow({ kind: "said", sequence: 10, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "after" }),
    tool(11),
    tool(12),
  ];
  const render = (partitions: readonly number[]): readonly string[] => {
    const stream = activityStream({ columns: 120, color: false });
    let seen = 0;
    const lines = partitions.flatMap((count) => {
      seen += count;
      return stream(liveActivity(idleAkumaSnapshot(rows.slice(0, seen))));
    });
    assert.deepEqual(
      stream(liveActivity(idleAkumaSnapshot(rows.slice(0, seen)))),
      [],
      "an identical pending snapshot replays nothing",
    );
    return [...lines, ...stream.flush()];
  };
  assert.deepEqual(render([rows.length]), render([4, 1, 2, 1, 2, 2]));
});

test("live activity keeps unsettled rows in the frame and accounts for them on close", () => {
  const active = snapshotRow(activeTool(1, "bash", { kind: "run", command: "slow" }));
  const complete = snapshotRow(completedTool(2, "bash", { kind: "run", command: "slow" }));
  const stream = activityStream({ columns: 120, color: false });

  assert.deepEqual(stream(liveActivity(openAkumaSnapshot([active]))), []);
  assert.match(stream.frame().join("\n"), /● run +\$ slow/u);

  const settled = stream(liveActivity(idleAkumaSnapshot([complete]))).join("\n");
  assert.match(settled, /✓ run +\$ slow/u);
  assert.equal(stream.frame().length, 0);
  assert.deepEqual(stream.flush(), []);

  const unresolved = activityStream({ columns: 120, color: false });
  unresolved(liveActivity(openAkumaSnapshot([active])));
  const closing = unresolved.flush().join("\n");
  assert.match(closing, /\? run +\$ slow/u);
  assert.equal((closing.match(/\$ slow/gu) ?? []).length, 1);
  assert.deepEqual(unresolved.flush(), []);
});

test("a live activity stream skips thoughts while advancing its sequence cursor", () => {
  const rows = [
    snapshotRow({ kind: "said" as const, sequence: 1, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "say-sentinel" }),
    snapshotRow({
      kind: "thought" as const,
      sequence: 2,
      turnSequence: 1,
      at: AKUMA_ACTIVITY_AT,
      text: "think-sentinel",
    }),
    snapshotRow({ kind: "note" as const, sequence: 3, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "note-sentinel" }),
    snapshotRow({ kind: "call" as const, sequence: 4, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "call-sentinel" }),
    snapshotRow({
      kind: "tell" as const,
      sequence: 5,
      at: AKUMA_ACTIVITY_AT,
      tellId: "tell/live-sentinel",
      text: "tell-sentinel",
      state: "told" as const,
      deliveries: [{ route: "launch" as const, turnSequence: 1, deliveredAt: AKUMA_ACTIVITY_AT }],
    }),
    snapshotRow(completedTool(6, "bash", { kind: "run", command: "tool-sentinel" })),
  ];
  const stream = activityStream({ columns: 120, color: false });
  stream.seed(liveActivity(openAkumaSnapshot([])));
  const initial = stream(liveActivity(idleAkumaSnapshot(rows.slice(0, 1), answeredOutcome(1, "outcome-sentinel"))));
  assert.match(initial.join("\n"), /say-sentinel/u, "eligible predecessors still stream");
  const thoughtOnly = idleAkumaSnapshot(rows.slice(0, 2), answeredOutcome(1, "outcome-sentinel"));
  assert.deepEqual(stream(liveActivity(thoughtOnly)), [], "a thought-only update advances the durable cursor");
  const updated = idleAkumaSnapshot(rows, answeredOutcome(1, "outcome-sentinel"));
  const text = [...initial, ...stream(liveActivity(updated)), ...stream(liveActivity(updated)), ...stream.flush()].join(
    "\n",
  );
  for (const sentinel of ["say-sentinel", "note-sentinel", "call-sentinel", "tell-sentinel", "tool-sentinel"])
    assert.equal((text.match(new RegExp(sentinel, "gu")) ?? []).length, 1, `${sentinel} streams once`);
  assert.doesNotMatch(text, /think-sentinel/u, "thought narration is never live evidence");
  assert.doesNotMatch(text, /outcome-sentinel/u, "outcomes remain conclusion evidence, not live narration");
});

test("thoughts do not consume a live stream's tool or omission budgets", () => {
  const tool = (sequence: number) =>
    snapshotRow(completedTool(sequence, "bash", { kind: "run", command: `tool-${sequence}` }));
  const rows = [
    tool(1),
    snapshotRow({ kind: "thought" as const, sequence: 2, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "hidden-1" }),
    tool(3),
    tool(4),
    snapshotRow({ kind: "thought" as const, sequence: 5, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "hidden-2" }),
    tool(6),
    tool(7),
    tool(8),
    snapshotRow({ kind: "thought" as const, sequence: 9, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "hidden-3" }),
    tool(10),
    tool(11),
    tool(12),
  ];
  const stream = activityStream({ columns: 120, color: false });
  const text = [...stream(liveActivity(idleAkumaSnapshot(rows))), ...stream.flush()].join("\n");
  for (const sequence of [1, 3, 4, 11, 12]) assert.match(text, new RegExp(`\\$ tool-${sequence}`, "u"));
  for (const sequence of [6, 7, 8, 10]) assert.doesNotMatch(text, new RegExp(`\\$ tool-${sequence}`, "u"));
  assert.equal((text.match(/⋮ 4 omitted/gu) ?? []).length, 1, "only four eligible tools are omitted");
  assert.doesNotMatch(text, /hidden-[123]/u);
});

test("a say omits earlier tail tools and only keeps the last two after the final say", () => {
  const tool = (sequence: number) =>
    snapshotRow(completedTool(sequence, "bash", { kind: "run", command: `tool-${sequence}` }));
  const fileChange = (sequence: number, path: string, state: CompletedToolRow["state"] = { status: "ok" }) =>
    snapshotRow(
      completedTool(
        sequence,
        "edit",
        { kind: "fileChange", changes: [{ op: "update", path, diffstat: { added: 4, removed: 2 } }] },
        state,
      ),
    );
  const say = (sequence: number, text: string) =>
    snapshotRow({ kind: "said" as const, sequence, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text });
  const rows = [
    say(1, "before-tools"),
    tool(2),
    tool(3),
    tool(4),
    fileChange(5, "src/middle.ts"),
    tool(6),
    tool(7),
    tool(8),
    fileChange(9, "src/selected.ts", { status: "error", message: "refused" }),
    say(10, "flush-now"),
    tool(11),
    tool(12),
    tool(13),
    fileChange(14, "src/last.ts", { status: "error", message: "refused" }),
  ];
  const stream = activityStream({ columns: 120, color: false });
  const observed = stream(liveActivity(idleAkumaSnapshot(rows))).join("\n");
  const text = [observed, ...stream.flush()].filter(Boolean).join("\n");

  assert.match(observed, /flush-now/u, "the new say is emitted in its observation, before conclusion");
  assert.doesNotMatch(text, /src\/(middle|selected)\.ts/u, "all tools before the final say are omitted");
  assert.match(text, /! edit   src\/last\.ts — \+4 -2 — error · refused/u);
  assert.match(text, /\$ tool-13/u);
  for (const sequence of [2, 3, 4, 6, 7, 8, 11, 12])
    assert.doesNotMatch(text, new RegExp(`\\$ tool-${sequence}(?!\\d)`, "u"));
  assert.match(text, /⋮ 8 omitted[\s\S]*flush-now[\s\S]*⋮ 2 omitted/u);
  assert.equal(text.split("flush-now").length - 1, 1);
});

test("a say flushes the pending tail without renewing one wait's tool budget", () => {
  const tool = (sequence: number) =>
    snapshotRow(completedTool(sequence, "bash", { kind: "run", command: `tool-${sequence}` }));
  const say = (sequence: number, text: string) =>
    snapshotRow({ kind: "said" as const, sequence, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text });
  const rows = [tool(1), tool(2), tool(3), say(4, "checkpoint"), tool(5), tool(6), tool(7), tool(8)];
  const stream = activityStream({ columns: 120, color: false });
  const before = stream(liveActivity(idleAkumaSnapshot(rows.slice(0, 4))));
  const after = stream(liveActivity(idleAkumaSnapshot(rows)));
  const text = [...before, ...after, ...stream.flush()].join("\n");

  for (const sequence of [1, 2, 3, 7, 8]) assert.match(text, new RegExp(`\\$ tool-${sequence}`, "u"));
  for (const sequence of [5, 6]) assert.doesNotMatch(text, new RegExp(`\\$ tool-${sequence}`, "u"));
  assert.match(text, /checkpoint/u);
  assert.equal((text.match(/⋮ 2 omitted/gu) ?? []).length, 1);
});

test("a plural wait gives each target its own whole-command tool budget", () => {
  const first = "aku/worker/abcd0034";
  const second = "aku/worker/abcd0035";
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => 0 });
  stream.select([
    { id: first, alias: "@first" },
    { id: second, alias: "@second" },
  ]);
  const status = (id: string, prefix: string, completed: number) =>
    parseAkumaStatus({
      id,
      life: "running",
      allowed: [],
      timeline: openAkumaSnapshot([
        ...Array.from({ length: completed }, (_, index) =>
          snapshotRow(completedTool(index + 1, "bash", { kind: "run", command: `${prefix}${index + 1}` })),
        ),
        snapshotRow(activeTool(completed + 1, "bash", { kind: "run", command: "open" })),
      ]),
    });
  const firstStatus = status(first, "a", 9);
  const secondStatus = status(second, "b", 9);
  stream.observe([observed(status(first, "a", 0)), observed(status(second, "b", 0))]);
  const later = stream.observe([observed(firstStatus), observed(secondStatus)]);
  const conclusion = stream.conclude({
    reason: "deadline",
    observations: [
      { status: firstStatus, contract: { kind: "none" }, createdTasks: { kind: "present", rows: [] } },
      { status: secondStatus, contract: { kind: "none" }, createdTasks: { kind: "present", rows: [] } },
    ],
    unobserved: [],
  });
  const text = [...later, conclusion].join("\n");
  for (const prefix of ["a", "b"])
    for (const sequence of [1, 2, 3, 8, 9]) assert.match(text, new RegExp(`\\$ ${prefix}${sequence}`, "u"));
  assert.doesNotMatch(text, /\$ [ab][4-7]/u);
  assert.equal((text.match(/⋮ 4 omitted/gu) ?? []).length, 2);
});

test("a wait flushes a known target when its final result becomes unobserved", () => {
  const id = "aku/worker/abcd0036";
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => 0 });
  const status = parseAkumaStatus({
    id,
    life: "running",
    allowed: [],
    timeline: openAkumaSnapshot([
      ...Array.from({ length: 9 }, (_, index) =>
        snapshotRow(completedTool(index + 1, "bash", { kind: "run", command: `c${index + 1}` })),
      ),
      snapshotRow(activeTool(10, "bash", { kind: "run", command: "open" })),
    ]),
  });
  const baseline = parseAkumaStatus({
    id,
    life: "running",
    allowed: [],
    timeline: openAkumaSnapshot([snapshotRow(activeTool(1, "bash", { kind: "run", command: "open" }))]),
  });
  stream.observe([observed(baseline)]);
  stream.observe([observed(status)]);
  const text = stream.conclude({
    reason: "deadline",
    observations: [],
    unobserved: [{ id, diagnostic: "window lost" }],
  });
  assert.match(text, /⋮ 4 omitted[\s\S]*\$ c8[\s\S]*\$ c9/u);
});

test("a single answered wait concludes at its durable settle moment, not the poll that noticed it", () => {
  const settledAtMs = Date.parse(AKUMA_ACTIVITY_AT);
  let now = settledAtMs - 41_000;
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => now });
  const runningStatus = parseAkumaStatus({
    id: "aku/worker/abcd0004",
    life: "running",
    allowed: [],
    timeline: openAkumaSnapshot([snapshotRow(completedTool(1, "bash", { kind: "run", command: "work" }))]),
  });
  const answeredStatus = parseAkumaStatus({
    id: "aku/worker/abcd0004",
    life: "asleep",
    allowed: [],
    timeline: idleAkumaSnapshot([], answeredOutcome(1, "the answer")),
  });
  stream.observe([observed(runningStatus)]);
  now = settledAtMs + 5_000;
  stream.observe([observed(answeredStatus)]);
  const conclusion = {
    reason: "completed" as const,
    observations: [
      {
        status: answeredStatus,
        contract: { kind: "none" as const },
        createdTasks: { kind: "present" as const, rows: [] },
      },
    ],
    unobserved: [],
  };
  assert.equal(stream.conclude(conclusion), `${clockAt(settledAtMs)} ✓ answered — 41s\n\n`);
  assert.equal(stream.streamed(), true);
});

test("an unfinished wait concludes with the running mark and waited duration, never a replay", () => {
  let now = 1_000;
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => now });
  const runningStatus = parseAkumaStatus({
    id: "aku/worker/abcd0005",
    life: "running",
    allowed: [],
    timeline: openAkumaSnapshot([
      snapshotRow({ kind: "said", sequence: 1, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "still working" }),
    ]),
  });
  stream.observe([observed(runningStatus)]);
  now = 46_000;
  const conclusion = {
    reason: "deadline" as const,
    observations: [
      {
        status: runningStatus,
        contract: { kind: "none" as const },
        createdTasks: { kind: "present" as const, rows: [] },
      },
    ],
    unobserved: [],
  };
  assert.equal(
    stream.conclude(conclusion),
    `18:00 ? say    “still working”\n${clockAt(46_000)} ● running — waited 45s`,
  );
});

test("a streamed multi-target wait scoreboards without a count while a non-streamed one closes the same way", () => {
  const settledAtMs = Date.parse(AKUMA_ACTIVITY_AT);
  let now = settledAtMs - 192_000;
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => now });
  const first = "aku/worker/abcd0006";
  const second = "aku/worker/abcd0007";
  const running = (id: string) =>
    parseAkumaStatus({ id, life: "running", allowed: [], timeline: openAkumaSnapshot([]) });
  const answered = (id: string) =>
    parseAkumaStatus({
      id,
      life: "asleep",
      allowed: [],
      timeline: idleAkumaSnapshot([], answeredOutcome(1, "the answer")),
    });
  stream.observe([
    observed(running(first), { alias: parseAkumaAlias("@scout-a"), contract: { kind: "none" } }),
    observed(running(second)),
  ]);
  now = settledAtMs + 3_000;
  stream.observe([observed(answered(first)), observed(running(second))]);
  const conclusion = {
    reason: "deadline" as const,
    observations: [
      {
        status: answered(first),
        contract: { kind: "none" as const },
        createdTasks: { kind: "present" as const, rows: [] },
      },
      {
        status: running(second),
        contract: { kind: "none" as const },
        createdTasks: { kind: "present" as const, rows: [] },
      },
    ],
    unobserved: [],
  };
  now = settledAtMs + 8_000;
  const scoreboard = stream.conclude(conclusion);
  assert.equal(
    scoreboard,
    `${clockAt(settledAtMs)} abcd0006 ✓ answered — 3m12s\n${clockAt(settledAtMs + 8_000)} abcd0007 ● running — waited 3m20s`,
  );
  assert.doesNotMatch(scoreboard, /of \d+ done/u);

  const multiText = waitText(
    {
      kind: "akuma",
      action: "wait",
      startedAt: settledAtMs - 192_000,
      selection: [{ id: first, alias: parseAkumaAlias("@scout-a") }, { id: second }],
      result: {
        mode: "all",
        reason: "completed",
        observations: [
          { status: answered(first), contract: { kind: "none" }, createdTasks: { kind: "present", rows: [] } },
          { status: running(second), contract: { kind: "none" }, createdTasks: { kind: "present", rows: [] } },
        ],
        unobserved: [],
      },
    },
    { columns: 120, color: false },
  );
  assert.doesNotMatch(multiText, /of \d+ done/u, "the bare completion count is replaced");
  assert.match(multiText, /^✓ answered aku\/worker\/abcd0006$/mu, "the detail blocks stay");
  const multiLines = multiText.split("\n");
  assert.match(multiLines.at(-1)!, /● running — waited \d+/u, "an unfinished row carries the elapsed wait");
  assert.match(
    multiLines.at(-2)!,
    new RegExp(`^${clockAt(settledAtMs)} abcd0006 ✓ answered — 3m12s$`, "u"),
    "the scoreboard shares the streamed grammar and order",
  );
});

test("a plural aggregate head reads its selected set as one line per target with the association inline", () => {
  const first = "aku/worker/abcd0040";
  const second = "aku/worker/abcd0041";
  const running = (id: string) =>
    parseAkumaStatus({ id, life: "running", allowed: [], timeline: openAkumaSnapshot([]) });
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => 0 });
  const association = { kind: "associated", contractId: contractId("kei/alpha") } as const;
  stream.select([
    { id: first, alias: parseAkumaAlias("@a"), contract: association },
    { id: second, contract: { kind: "none" } },
  ]);
  const head = [`abcd0040 @a · kei/alpha`, `abcd0041 ${second}`];
  const opening = stream.observe([observed(running(first), { alias: parseAkumaAlias("@a"), contract: association })]);
  assert.deepEqual(
    opening,
    [...head, frameRule(head)],
    "each target keeps one line, association inline, under one rule",
  );
  assert.doesNotMatch(opening.join("\n"), /└─/u, "the plural head is a list, not stacked title cards");
  assert.ok(opening.includes(`abcd0041 ${second}`), "an unassociated target carries no dangling separator");
});

test("conclusion durations assert real waiting", () => {
  const settledAtMs = Date.parse(AKUMA_ACTIVITY_AT);
  const id = "aku/worker/abcd0044";
  const observation = (status: ReturnType<typeof parseAkumaStatus>) => ({
    status,
    contract: { kind: "none" as const },
    createdTasks: { kind: "present" as const, rows: [] },
  });
  const running = (at: string) =>
    parseAkumaStatus({
      id,
      life: "running",
      allowed: [],
      timeline: openAkumaSnapshot([snapshotRow({ kind: "said", sequence: 1, turnSequence: 1, at, text: "working" })]),
    });
  const answered = parseAkumaStatus({
    id,
    life: "asleep",
    allowed: [],
    timeline: idleAkumaSnapshot([], answeredOutcome(1, "the answer")),
  });

  // Already settled before the wait began: the settle clock is real, the duration is not fabricated.
  let now = settledAtMs + 10_000;
  const already = waitObservationStream({ columns: 120, color: false }, { now: () => now });
  already.observe([observed(answered)]);
  assert.equal(
    already.conclude({ reason: "completed", observations: [observation(answered)], unobserved: [] }),
    `${clockAt(settledAtMs)} ✓ answered\n\n`,
  );

  // Settles during the wait: the clause states the real wait.
  now = settledAtMs - 5_000;
  const during = waitObservationStream({ columns: 120, color: false }, { now: () => now });
  during.observe([observed(running(AKUMA_ACTIVITY_AT))]);
  now = settledAtMs + 1_000;
  during.observe([observed(answered)]);
  assert.equal(
    during.conclude({ reason: "completed", observations: [observation(answered)], unobserved: [] }),
    `${clockAt(settledAtMs)} ? say    “working”\n${clockAt(settledAtMs)} ✓ answered — 5s\n\n`,
  );

  // Unfinished: the row keeps its elapsed wait.
  now = 1_000;
  const unfinished = waitObservationStream({ columns: 120, color: false }, { now: () => now });
  const open = running(AKUMA_ACTIVITY_AT);
  unfinished.observe([observed(open)]);
  now = 46_000;
  assert.equal(
    unfinished.conclude({ reason: "deadline", observations: [observation(open)], unobserved: [] }),
    `18:00 ? say    “working”\n${clockAt(46_000)} ● running — waited 45s`,
  );

  // The observing call shares the rule: a call already answered at its first look names no duration.
  const call = callObservationStream(
    { columns: 120, color: false },
    { id, contract: { kind: "none" }, facts: [] },
    { now: () => settledAtMs + 10_000 },
  );
  const callConclusion = call.conclude(callObservation({ reason: "answered", answer: "the answer" }));
  assert.equal(callConclusion.split("\n").at(-3), `${clockAt(settledAtMs)} ✓ answered`);
  assert.ok(callConclusion.endsWith("\n\n"), "the progress channel owns the answer separator");
});

test("wait conclusions distinguish ordinary completion, a deadline-held Tell, and a failed outcome", () => {
  const id = "aku/worker/abcd0046";
  const observation = (status: ReturnType<typeof parseAkumaStatus>) => ({
    status,
    contract: { kind: "none" as const },
    createdTasks: { kind: "present" as const, rows: [] },
  });
  const asleep = parseAkumaStatus({ id, life: "asleep", allowed: [], timeline: idleAkumaSnapshot([]) });
  const pending = parseAkumaStatus({
    id,
    life: "asleep",
    allowed: [],
    timeline: openAkumaSnapshot([
      snapshotRow({
        kind: "tell" as const,
        sequence: 1,
        at: AKUMA_ACTIVITY_AT,
        tellId: "tell/pending",
        text: "still waiting",
        state: "pending" as const,
        deliveries: [],
      }),
    ]),
  });
  const failed: OutcomeRow = {
    kind: "outcome",
    sequence: 2,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    outcome: { kind: "failed", historyId: "history/failed", diagnostic: "provider failed" },
  };
  const failedStatus = parseAkumaStatus({ id, life: "asleep", allowed: [], timeline: idleAkumaSnapshot([], failed) });
  const conclude = (status: ReturnType<typeof parseAkumaStatus>, reason: "completed" | "deadline") => {
    const stream = waitObservationStream({ columns: 120, color: false }, { now: () => Date.parse(AKUMA_ACTIVITY_AT) });
    return stream.conclude({ reason, observations: [observation(status)], unobserved: [] });
  };
  assert.match(conclude(asleep, "completed"), /✓ completed/u);
  assert.match(conclude(pending, "deadline"), /⧗ pending tell/u);
  assert.match(conclude(failedStatus, "completed"), /! failed/u);
});

test("an any-mode completion receipt keeps an incomplete peer pending in both wait renderers", () => {
  const complete = parseAkumaStatus({
    id: "aku/worker/abcd0047",
    life: "asleep",
    allowed: [],
    timeline: idleAkumaSnapshot([]),
  });
  const pending = parseAkumaStatus({
    id: "aku/worker/abcd0048",
    life: "asleep",
    allowed: [],
    timeline: openAkumaSnapshot([
      snapshotRow({
        kind: "tell",
        sequence: 1,
        at: AKUMA_ACTIVITY_AT,
        tellId: "tell/pending-any",
        text: "still waiting",
        state: "pending",
        deliveries: [],
      }),
    ]),
  });
  const observations = [
    { status: complete, contract: { kind: "none" as const }, createdTasks: { kind: "present" as const, rows: [] } },
    { status: pending, contract: { kind: "none" as const }, createdTasks: { kind: "present" as const, rows: [] } },
  ];
  const stream = waitObservationStream({ columns: 120, color: false }, { now: () => Date.parse(AKUMA_ACTIVITY_AT) });
  const streamed = stream.conclude({ reason: "completed", observations, unobserved: [] });
  const nonStreamed = waitText(
    {
      kind: "akuma",
      action: "wait",
      result: { mode: "any", reason: "completed", observations, unobserved: [] },
    },
    { columns: 120, color: false },
  );
  for (const rendered of [streamed, nonStreamed]) {
    assert.match(rendered, /✓ completed/u);
    assert.match(rendered, /⧗ pending tell/u);
  }
});

test("a readable answer cannot replace a plural wait's complete text result", () => {
  const id = parseAkumaStatus({
    id: "aku/worker/abcd0045",
    life: "running",
    allowed: [],
    timeline: openAkumaSnapshot([]),
  }).id;
  const other = "aku/worker/abcd0046";
  const answered = parseAkumaStatus({
    id: other,
    life: "asleep",
    allowed: [],
    timeline: idleAkumaSnapshot([], answeredOutcome(1, "answer-must-not-hide-peer")),
  });
  assert.equal(
    akumaRawAnswer({
      kind: "akuma",
      action: "wait",
      result: {
        mode: "all",
        reason: "deadline",
        observations: [{ status: answered, contract: { kind: "none" }, createdTasks: { kind: "present", rows: [] } }],
        unobserved: [{ id, diagnostic: "window lost" }],
      },
    }),
    undefined,
    "a readable answer cannot replace a plural wait's complete text result",
  );
});

test("a single non-streamed text wait keeps its snapshot without a completion count", () => {
  const running = parseAkumaStatus({
    id: "aku/worker/abcd0013",
    life: "running",
    allowed: [],
    timeline: openAkumaSnapshot([]),
  });
  const text = waitText(
    {
      kind: "akuma",
      action: "wait",
      result: {
        mode: "all",
        reason: "deadline",
        observations: [{ status: running, contract: { kind: "none" }, createdTasks: { kind: "present", rows: [] } }],
        unobserved: [],
      },
    },
    { columns: 120, color: false },
  );
  assert.doesNotMatch(text, /done/u);
});

test("a streamed wait keeps stdout byte-pure while a forwarded wait keeps its frame", () => {
  const observation = (status: ReturnType<typeof parseAkumaStatus>) => ({
    status,
    contract: { kind: "none" as const },
    createdTasks: { kind: "present" as const, rows: [] },
  });
  const answered = (id: string) =>
    parseAkumaStatus({
      id,
      life: "asleep",
      allowed: [],
      timeline: idleAkumaSnapshot([], answeredOutcome(1, "the answer")),
    });
  const running = (id: string) =>
    parseAkumaStatus({ id, life: "running", allowed: [], timeline: openAkumaSnapshot([]) });
  const wait = (statuses: readonly ReturnType<typeof parseAkumaStatus>[], streamed = false): AkumaInvocationResult => ({
    kind: "akuma",
    action: "wait",
    result: { mode: "all", reason: "completed", observations: statuses.map(observation), unobserved: [] },
    ...(streamed ? { streamed: true } : {}),
  });

  assert.equal(akumaRawAnswer(wait([answered("aku/worker/aaa00001")], true)), "the answer");
  assert.equal(akumaRawAnswer(wait([running("aku/worker/aaa00002")], true)), "");
  assert.equal(akumaRawAnswer(wait([answered("aku/worker/aaa00003"), answered("aku/worker/aaa00004")], true)), "");
  assert.equal(akumaRawAnswer(wait([running("aku/worker/aaa00005")])), undefined);
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

test("a streamed observing call opens one framed head and never replays a settled snapshot", () => {
  const id = "aku/worker/abcd0030";
  const settledAtMs = Date.parse(AKUMA_ACTIVITY_AT);
  let now = settledAtMs - 4_000;
  const head = {
    id,
    alias: "@scout",
    contract: { kind: "associated" as const, contractId: contractId("kei/demo") },
    facts: [],
  };
  const stream = callObservationStream({ columns: 100, color: false }, head, { now: () => now });
  const running = (entries: Parameters<typeof openAkumaSnapshot>[0]) =>
    parseAkumaStatus({ id, life: "running", allowed: [], timeline: openAkumaSnapshot(entries) });
  const tool = (sequence: number, command: string) =>
    snapshotRow(completedTool(sequence, "bash", { kind: "run", command }));
  const headLines = [`${id} (@scout)`, "└─ kei/demo"];
  const opening = stream.observe(
    live(running([snapshotRow(activeTool(1, "bash", { kind: "run", command: "first" }))])),
  );
  assert.deepEqual(opening, [...headLines, frameRule(headLines)], "the head opens once before any row");
  assert.doesNotMatch(opening.join("\n"), /cwd|✓ run/u);
  const growing = running([tool(1, "first"), snapshotRow(activeTool(2, "bash", { kind: "run", command: "second" }))]);
  const text = stream.observe(live(growing)).join("\n");
  assert.deepEqual(stream.observe(live(growing)), [], "a settled row never streams twice");
  assert.match(text, /✓ run +\$ first/u);
  assert.doesNotMatch(text, /second|@scout|└─ kei\/demo/u, "the head never recurs and the newest row is still moving");

  now = settledAtMs + 1_000;
  const conclusion = stream.conclude(callObservation({ reason: "answered", answer: "the answer" }));
  assert.equal(conclusion, `      ? run    \$ second\n${clockAt(settledAtMs)} ✓ answered — 4s\n\n`);
  assert.doesNotMatch(conclusion, /the answer|└─ kei\/demo|@scout/u, "no head or answer replay");
});

test("a streamed observing call concludes truthfully when its stream never opened", () => {
  const id = "aku/worker/abcd0031";
  const head = { id, contract: { kind: "none" as const }, facts: [] };
  let now = 10_000;
  const runningStream = callObservationStream({ columns: 80, color: false }, head, { now: () => now });
  now = 40_000;
  const opened = runningStream.conclude(callObservation({ reason: "deadline" })).split("\n");
  assert.deepEqual(opened.slice(0, 2), [id, frameRule([id])]);
  assert.equal(opened.at(-3), `${clockAt(40_000)} ⧗ pending tell — waited 30s`);
  assert.ok(runningStream.opened());

  const observedStream = callObservationStream({ columns: 80, color: false }, head, { now: () => now });
  observedStream.observe(live(parseAkumaStatus({ id, life: "running", allowed: [], timeline: openAkumaSnapshot([]) })));
  now = 55_000;
  const observed = observedStream.conclude(callObservation({ reason: "deadline" })).split("\n");
  assert.equal(
    observed.at(-3),
    `${clockAt(55_000)} ● running — waited 15s`,
    "a caller deadline states the observed life rather than naming the deadline",
  );

  const failedStream = callObservationStream({ columns: 80, color: false }, head, { now: () => 0 });
  const failed = failedStream
    .conclude({
      kind: "failed",
      tellId: "tell/call-render",
      failure: { kind: "infrastructure", diagnostic: "window lost" },
    })
    .split("\n");
  assert.deepEqual(failed.slice(0, 2), [id, frameRule([id])]);
  assert.equal(failed.at(-3), "! error window lost");

  const outcomeStream = callObservationStream({ columns: 80, color: false }, head, { now: () => 0 });
  const outcomeText = outcomeStream.conclude(callObservation({ reason: "failed", diagnostic: "provider 503" }));
  assert.match(outcomeText, /! failed — /u);
  assert.match(outcomeText, /! error provider 503/u);
});
