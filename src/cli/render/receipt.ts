import type {
  ContinuationReport,
  KeiyakuRetryReason,
  PartialOutcomeEnvelope,
  Placement,
  RequirementProblem,
  VerificationCheck,
} from "../../index.js";
import { contractOperationName, requirementDisplayName } from "./contract-observation.js";
import { renderRefusalFacts } from "./refusal.js";
import {
  DEFAULT_CLI_COLUMNS,
  displayColumns,
  orderRefusalFacts,
  quotedText,
  renderOpaqueBlock,
  safeText,
} from "./terminal.js";
import { abbreviateGitIds, displayGitId } from "./contract-observation.js";

export type ReceiptSegment = Readonly<{ text: string; opaque?: boolean }>;

export function receiptRow(
  lines: string[],
  mark: string,
  label: string,
  segments: readonly ReceiptSegment[],
  columns: number,
): void {
  const prefix = mark.trim().length === 0 ? "  " : `${mark} `;
  let current = `${prefix}${label}`;
  for (const segment of segments) {
    const text = segment.opaque === true ? safeText(segment.text) : segment.text;
    const candidate = `${current}  ${text}`;
    if (displayColumns(candidate) <= columns) {
      current = candidate;
      continue;
    }
    if (current === `${prefix}${label}` && segment.opaque === true) {
      lines.push(current);
      current = `  ${text}`;
      continue;
    }
    lines.push(current);
    current = `  ${text}`;
  }
  lines.push(current);
}

export function receiptPayload(lines: string[], label: string, payload: string): void {
  lines.push(`  ${label.trim()}`, ...renderOpaqueBlock(payload, "  ", DEFAULT_CLI_COLUMNS), "");
}

export function outcomeLines(
  mark: "✓" | "×" | "!" | "?",
  verb: string,
  word: "accepted" | "refused" | "retry",
  contract: string | undefined,
  columns = DEFAULT_CLI_COLUMNS,
): string[] {
  const base = `${mark} ${contractOperationName(verb)} ${word}`;
  if (contract === undefined) return [base];
  const inline = `${base}  ${contract}`;
  return displayColumns(inline) <= columns ? [inline] : [base, `  contract  ${safeText(contract)}`];
}

export function refusalLines(
  verb: string,
  facts: readonly string[],
  columns = DEFAULT_CLI_COLUMNS,
  trailingFacts: readonly string[] = [],
): string[] {
  return [
    ...outcomeLines("×", verb, "refused", undefined, columns),
    ...orderRefusalFacts(facts).map((fact) => `  ${fact}`),
    ...trailingFacts,
  ];
}

export function titleLines(mark: string, title: string, contract: string, columns = DEFAULT_CLI_COLUMNS): string[] {
  const base = `${mark} ${title}`;
  const inline = `${base}  ${contract}`;
  return displayColumns(inline) <= columns ? [inline] : [base, `  contract  ${safeText(contract)}`];
}

function words(kind: string): string {
  return kind.replaceAll("-", " ");
}

type PlacementStop = Exclude<Placement, { kind: "placed" }>;
type TerminalCheck = Extract<VerificationCheck, { kind: "terminal" }>;
type CheckAdmissionStop = Exclude<NonNullable<TerminalCheck["admission"]>, string>;
type RuntimeCheck = Exclude<VerificationCheck, { kind: "terminal" }>;
export type ContinuationStop = NonNullable<ContinuationReport["stopped"]>[number];
export type ReceiptStop = PlacementStop | CheckAdmissionStop | RuntimeCheck | ContinuationStop;

function unmetRequirementLines(unmet: readonly RequirementProblem[], columns: number): readonly string[] {
  const lines: string[] = [];
  const ids = abbreviateGitIds(
    unmet.flatMap((problem) =>
      problem.state === "stale" ? [problem.previousContentId ?? "", problem.currentContentId ?? ""] : [],
    ),
  );
  for (const problem of unmet) {
    const mark = problem.state === "missing" ? "○" : problem.state === "stale" ? "!" : "×";
    const detail =
      problem.state === "stale"
        ? [
            { text: "stale" },
            ...(problem.previousContentId === undefined || problem.currentContentId === undefined
              ? []
              : [
                  {
                    text: `${displayGitId(problem.previousContentId, ids)} -> ${displayGitId(problem.currentContentId, ids)}`,
                    opaque: true,
                  },
                ]),
          ]
        : [{ text: problem.state === "unsatisfied" ? "recorded unsatisfied" : problem.state }];
    receiptRow(lines, mark, requirementDisplayName(problem.gate, problem), detail, columns);
    if (problem.state === "unsatisfied" && problem.summary !== undefined)
      receiptPayload(lines, "summary", problem.summary);
  }
  return lines;
}

export { unmetRequirementLines };

function retryRows(reason: KeiyakuRetryReason, columns: number, dependent?: string): readonly string[] {
  const lines: string[] = [];
  receiptRow(
    lines,
    "?",
    "retry",
    [
      { text: words(reason.reason) },
      ...(dependent === undefined ? [] : [{ text: "·" }, { text: dependent, opaque: true }]),
    ],
    columns,
  );
  if (reason.reason === "publication-failed") receiptPayload(lines, "reason", reason.diagnostic);
  return lines;
}

function dependentRow(lines: string[], dependent: string | undefined, label: string, columns: number): void {
  if (dependent === undefined) receiptRow(lines, "!", label, [], columns);
  else receiptRow(lines, "!", "dependent", [{ text: dependent, opaque: true }, { text: `· ${label}` }], columns);
}

function prerequisiteLines(
  unmet: NonNullable<Extract<PlacementStop, { kind: "prerequisites-unsatisfied" }>["unmet"]>,
  columns: number,
): readonly string[] {
  const lines: string[] = [];
  for (const prerequisite of unmet)
    receiptRow(
      lines,
      " ",
      "prerequisite",
      [{ text: prerequisite.contractId, opaque: true }, { text: "·" }, { text: prerequisite.state }],
      columns,
    );
  return lines;
}

function runtimeStopLines(
  stop: RuntimeCheck | Readonly<{ kind: "cancelled" }>,
  columns: number,
  dependent?: string,
): readonly string[] {
  const lines: string[] = [];
  const segments: ReceiptSegment[] = dependent === undefined ? [] : [{ text: "·" }, { text: dependent, opaque: true }];
  if (stop.kind === "environment-hook-failure") segments.push({ text: `name ${quotedText(stop.name)}` });
  receiptRow(lines, "!", dependent ?? words(stop.kind), segments, columns);
  const diagnostic = "diagnostic" in stop ? stop.diagnostic : undefined;
  if (diagnostic !== undefined && diagnostic.length > 0) receiptPayload(lines, "reason", diagnostic);
  return lines;
}

type SemanticPlacementStop = Exclude<PlacementStop, { kind: "retry" | "checkout-not-followable" }>;

function requirementStopRows(
  stop: Extract<SemanticPlacementStop, { kind: "gates-unsatisfied" | "prerequisites-unsatisfied" }>,
  columns: number,
  dependent: string | undefined,
): readonly string[] {
  const lines: string[] = [];
  if (stop.kind === "prerequisites-unsatisfied") {
    dependentRow(lines, dependent, "prerequisites unsatisfied", columns);
    lines.push(...prerequisiteLines(stop.unmet, columns));
    return lines;
  }
  if (dependent !== undefined) {
    const awaiting = stop.unmet
      .filter((problem) => problem.state !== "unsatisfied")
      .map((problem) => requirementDisplayName(problem.gate, problem));
    if (awaiting.length === 0) receiptRow(lines, " ", "dependent", [{ text: dependent, opaque: true }], columns);
    else receiptRow(lines, "⧗", dependent, [{ text: "·" }, { text: `awaiting ${awaiting.join(", ")}` }], columns);
  }
  lines.push(...unmetRequirementLines(stop.unmet, columns));
  return lines;
}

type AvailabilityStop = Extract<
  SemanticPlacementStop,
  {
    kind:
      | "delivery-missing"
      | "target-missing"
      | "contract-missing"
      | "terminal"
      | "target-contract-missing"
      | "target-contract-terminal"
      | "target-workspace-unavailable";
  }
>;

function availabilityStopRows(
  stop: AvailabilityStop,
  columns: number,
  dependent: string | undefined,
): readonly string[] {
  const lines: string[] = [];
  if (stop.kind !== "target-workspace-unavailable") {
    dependentRow(lines, dependent, words(stop.kind), columns);
    return lines;
  }
  receiptRow(
    lines,
    "!",
    "target workspace unavailable",
    [{ text: stop.targetContractId, opaque: true }, { text: words(stop.reason) }],
    columns,
  );
  return lines;
}

type OutcomeStop = Extract<
  SemanticPlacementStop,
  {
    kind: "not-based-on-target" | "unrelated-histories" | "integration-conflict" | "integration-unsupported" | "failed";
  }
>;

function outcomeStopRows(stop: OutcomeStop, columns: number, addressed: string, dependent?: string): readonly string[] {
  if (stop.kind !== "failed") return renderRefusalFacts(stop, "  ", columns, addressed);
  const lines: string[] = [];
  receiptRow(lines, "×", "not accepted", dependent === undefined ? [] : [{ text: dependent, opaque: true }], columns);
  receiptPayload(lines, "reason", stop.diagnostic);
  return lines;
}

function targetMovementStopRows(
  stop: Extract<SemanticPlacementStop, { kind: "target-content-identical" | "target-moved" }>,
  columns: number,
  related: string | undefined,
): readonly string[] {
  const lines: string[] = [];
  if (stop.kind === "target-content-identical") {
    const ids = abbreviateGitIds([stop.expected, stop.observed]);
    receiptRow(
      lines,
      "!",
      related ?? "target content identical",
      [
        { text: stop.target, opaque: true },
        { text: `${displayGitId(stop.expected, ids)} -> ${displayGitId(stop.observed, ids)}`, opaque: true },
        { text: "content identical" },
      ],
      columns,
    );
    return lines;
  }
  const ids = abbreviateGitIds([stop.integration, stop.observed ?? ""]);
  receiptRow(
    lines,
    "!",
    related ?? "target moved",
    [
      { text: stop.target, opaque: true },
      {
        text: `${displayGitId(stop.integration, ids)} -> ${stop.observed === null ? "absent" : displayGitId(stop.observed, ids)}`,
        opaque: true,
      },
    ],
    columns,
  );
  return lines;
}

function placementStopRows(
  stop: SemanticPlacementStop,
  columns: number,
  addressed: string,
  dependent: string | undefined,
): readonly string[] {
  switch (stop.kind) {
    case "gates-unsatisfied":
    case "prerequisites-unsatisfied":
      return requirementStopRows(stop, columns, dependent);
    case "delivery-missing":
    case "target-missing":
    case "contract-missing":
    case "terminal":
    case "target-contract-missing":
    case "target-contract-terminal":
    case "target-workspace-unavailable":
      return availabilityStopRows(stop, columns, dependent);
    case "not-based-on-target":
    case "unrelated-histories":
    case "integration-conflict":
    case "integration-unsupported":
    case "failed":
      return outcomeStopRows(stop, columns, addressed, dependent);
    case "target-content-identical":
    case "target-moved":
      return targetMovementStopRows(stop, columns, dependent);
  }
}

/**
 * One flat stop vocabulary for placement, test admission, and dependent continuation. The native
 * stop supplies every distinction; rendering never reconstructs a wrapper or a second conclusion.
 */
export function stopLines(
  stop: ReceiptStop,
  columns: number,
  addressed: string,
  dependent?: string,
): readonly string[] {
  const owner = "contractId" in stop ? stop.contractId : undefined;
  const related = dependent ?? owner;
  switch (stop.kind) {
    case "execution-stopped": {
      const lines: string[] = [];
      receiptRow(
        lines,
        "!",
        "execution",
        [{ text: stop.reason }, ...(related === undefined ? [] : [{ text: related, opaque: true }])],
        columns,
      );
      receiptPayload(lines, "reason", stop.diagnostic);
      return lines;
    }
    case "already-terminal":
    case "physical-lag":
      return []; // the continuation renderer owns the caller-facing row
    case "retry":
      return retryRows(stop, columns, dependent);
    case "refused":
      return renderRefusalFacts(stop.reason, "  ", columns, addressed);
    case "cancelled":
    case "unknown-exit":
    case "candidate-unavailable":
    case "spawn-error":
    case "environment-failure":
    case "environment-hook-failure":
      return runtimeStopLines(stop, columns, dependent);
    case "checkout-not-followable": {
      const lines: string[] = [];
      if (dependent !== undefined) receiptRow(lines, "!", "dependent", [{ text: dependent, opaque: true }], columns);
      lines.push(...renderRefusalFacts(stop, "", columns, addressed));
      return lines;
    }
    default:
      return placementStopRows(stop, columns, addressed, dependent);
  }
}

export function deliveryIdentityRows(
  lines: string[],
  identity: Readonly<{ candidate: string; integration: string; contentId: string | undefined }>,
  columns: number,
): void {
  for (const [label, value] of [
    ["candidate", identity.candidate],
    ["integration result", identity.integration],
    ["content identity", identity.contentId],
  ] as const)
    if (value !== undefined) receiptRow(lines, " ", label, [{ text: value, opaque: true }], columns);
}

export function targetMovementRows(
  lines: string[],
  placement: Readonly<{ target?: string; predecessor?: string; integration: string }>,
  columns: number,
): void {
  const ids = abbreviateGitIds([placement.predecessor ?? "", placement.integration]);
  const movement =
    placement.predecessor === undefined
      ? displayGitId(placement.integration, ids)
      : `${displayGitId(placement.predecessor, ids)}..${displayGitId(placement.integration, ids)}`;
  receiptRow(
    lines,
    " ",
    "target",
    [{ text: movement }, ...(placement.target === undefined ? [] : [{ text: placement.target, opaque: true }])],
    columns,
  );
}

export function gatesAwaitLines(placement: PlacementStop | undefined): readonly string[] {
  if (placement?.kind !== "gates-unsatisfied") return [];
  const events = placement.unmet
    .filter((problem) => problem.state !== "unsatisfied")
    .map((problem) => requirementDisplayName(problem.gate, problem));
  return events.length === 0 ? [] : [`⧗ awaiting ${events.join(", ")}`];
}

/** The performed work and its admission conclusion, with no aggregate gate testimony. */
export function verificationCheckLines(
  checks: readonly VerificationCheck[],
  snapshot: string,
  columns: number,
  addressed: string,
): readonly string[] {
  const ids = abbreviateGitIds([snapshot]);
  const lines: string[] = [];
  for (const check of checks) {
    receiptRow(
      lines,
      " ",
      `check ${check.index}`,
      [
        { text: check.kind === "terminal" ? "executed" : "execution stopped" },
        { text: check.requirement, opaque: true },
        { text: `· snapshot ${displayGitId(snapshot, ids)}` },
      ],
      columns,
    );
    if (check.kind !== "terminal") {
      lines.push(...stopLines(check, columns, addressed));
    } else {
      receiptRow(lines, check.verdict === "satisfied" ? "✓" : "×", "verdict", [{ text: check.verdict }], columns);
      if (check.verdict === "unsatisfied") receiptPayload(lines, "summary", check.summary);
      const admission = check.admission;
      if (typeof admission === "string")
        receiptRow(lines, " ", "attestation", [{ text: admission === "reused" ? "reused" : "not recorded" }], columns);
      else if (admission !== undefined) {
        receiptRow(lines, "!", "admission", [{ text: "stopped" }], columns);
        lines.push(...stopLines(admission, columns, addressed));
      }
    }
    if (check.retainedPath !== undefined)
      receiptRow(lines, " ", "scratch retained", [{ text: check.retainedPath, opaque: true }], columns);
  }
  return lines;
}

type RecoverySnapshot = string | Readonly<{ snapshot: string; contractId?: string }>;

export function recoverySnapshotLines(
  recoveries: readonly RecoverySnapshot[] | undefined,
  columns: number,
  primary: string | undefined,
): readonly string[] {
  const lines: string[] = [];
  for (const recovery of recoveries ?? []) {
    const snapshot = typeof recovery === "string" ? recovery : recovery.snapshot;
    const owner = typeof recovery === "string" ? undefined : recovery.contractId;
    if (owner !== undefined && owner !== primary)
      receiptRow(lines, " ", "recovery owner", [{ text: owner, opaque: true }], columns);
    receiptRow(
      lines,
      " ",
      "recovery snapshot",
      [{ text: displayGitId(snapshot, abbreviateGitIds([snapshot])), opaque: true }],
      columns,
    );
  }
  return lines;
}

function admittedLines(
  admission: NonNullable<Extract<PartialOutcomeEnvelope, { kind: "contract" }>["admitted"]>[number],
  columns: number,
  primary?: string,
): readonly string[] {
  const lines: string[] = [];
  const owner = admission.contractId;
  const owned = owner === undefined || owner === primary ? [] : [{ text: owner, opaque: true }];
  switch (admission.kind) {
    case "deliver": {
      receiptRow(lines, " ", "admitted", [{ text: "deliver" }, ...owned], columns);
      const ids = abbreviateGitIds([admission.candidate, admission.integration, admission.contentId]);
      deliveryIdentityRows(
        lines,
        {
          candidate: displayGitId(admission.candidate, ids),
          integration: displayGitId(admission.integration, ids),
          contentId: displayGitId(admission.contentId, ids),
        },
        columns,
      );
      return lines;
    }
    case "reintegrated": {
      const ids = abbreviateGitIds([admission.predecessor, admission.integration]);
      receiptRow(
        lines,
        " ",
        "re-integrated",
        [
          { text: `${displayGitId(admission.predecessor, ids)}..${displayGitId(admission.integration, ids)}` },
          ...owned,
        ],
        columns,
      );
      return lines;
    }
    case "attestation": {
      const mark = admission.verdict === "satisfied" ? "✓" : "×";
      receiptRow(
        lines,
        mark,
        "attestation",
        [
          ...(admission.requirement === undefined ? [] : [{ text: admission.requirement, opaque: true }]),
          ...(admission.verdict === undefined ? [] : [{ text: admission.verdict }]),
          ...owned,
        ],
        columns,
      );
      return lines;
    }
    case "arc":
      receiptRow(lines, " ", `chapter ${admission.chapter}`, owned, columns);
      return lines;
    default:
      receiptRow(lines, " ", "admitted", [{ text: admission.kind }, ...owned], columns);
      return lines;
  }
}

type ExceptionalEffect = NonNullable<Extract<PartialOutcomeEnvelope, { kind: "contract" }>["effects"]>[number];

function effectLines(effect: ExceptionalEffect, columns: number, primary?: string): readonly string[] {
  const lines: string[] = [];
  const owner = effect.contractId;
  if (owner !== undefined && owner !== primary)
    receiptRow(lines, " ", "effect owner", [{ text: owner, opaque: true }], columns);
  switch (effect.kind) {
    case "ref": {
      const ids = abbreviateGitIds([effect.before ?? "", effect.after ?? ""]);
      const before = effect.before === null ? "absent" : displayGitId(effect.before, ids);
      const after = effect.after === null ? "absent" : displayGitId(effect.after, ids);
      receiptRow(lines, " ", "ref", [{ text: `${before} → ${after}` }, { text: effect.name, opaque: true }], columns);
      return lines;
    }
    case "worktree-followed": {
      const ids = abbreviateGitIds([effect.before, effect.after]);
      receiptRow(
        lines,
        " ",
        "worktree followed",
        [
          { text: `${displayGitId(effect.before, ids)} → ${displayGitId(effect.after, ids)}` },
          { text: effect.path, opaque: true },
        ],
        columns,
      );
      return lines;
    }
    case "recovery-snapshot":
      receiptRow(
        lines,
        " ",
        "recovery snapshot",
        [{ text: displayGitId(effect.snapshot, abbreviateGitIds([effect.snapshot])), opaque: true }],
        columns,
      );
      return lines;
    case "target-checkout":
      receiptRow(
        lines,
        " ",
        "target checkout",
        [
          { text: effect.target, opaque: true },
          { text: effect.path, opaque: true },
        ],
        columns,
      );
      return lines;
    case "debt-settled":
      receiptRow(lines, " ", "settled", [{ text: effect.debtId, opaque: true }], columns);
      return lines;
    case "placed":
      targetMovementRows(lines, effect, columns);
      return lines;
    case "worktree-created":
    case "worktree-removed":
      receiptRow(lines, " ", words(effect.kind), [{ text: effect.path, opaque: true }], columns);
      return lines;
  }
}

function placementEvidenceLines(placement: Placement, columns: number, addressed: string): readonly string[] {
  if (placement.kind !== "placed") return stopLines(placement, columns, addressed);
  if (placement.target === undefined) return [];
  const lines: string[] = [];
  targetMovementRows(lines, placement, columns);
  return lines;
}

/** Confirmed admissions and irreversible movement survive a trailing failure without a journal reread. */
export function executionEvidenceLines(
  receipt: Extract<PartialOutcomeEnvelope, { kind: "contract" }>,
  columns: number,
): readonly string[] {
  const lines: string[] = [];
  for (const admission of receipt.admitted ?? []) lines.push(...admittedLines(admission, columns, receipt.contractId));
  if (receipt.placement !== undefined)
    lines.push(...placementEvidenceLines(receipt.placement, columns, receipt.contractId ?? ""));
  for (const effect of receipt.effects ?? []) lines.push(...effectLines(effect, columns, receipt.contractId));
  return lines;
}

export function executionFailureLines(
  operation: string,
  receipt: PartialOutcomeEnvelope,
  failure: Readonly<{ category: string; diagnostic: string; causeClass?: string; causeDiagnostic?: string }>,
  columns: number,
): readonly string[] {
  const lines: string[] = [];
  const identity = receipt.kind === "contract" ? receipt.contractId : receipt.world;
  receiptRow(
    lines,
    "!",
    `${contractOperationName(operation)} failed`,
    [{ text: failure.category }, ...(identity === undefined ? [] : [{ text: identity, opaque: true }])],
    columns,
  );
  receiptPayload(lines, "reason", failure.diagnostic);
  if (failure.causeClass !== undefined || failure.causeDiagnostic !== undefined)
    receiptPayload(
      lines,
      "cause",
      [failure.causeClass, failure.causeDiagnostic].filter((part) => part !== undefined).join(": "),
    );
  if (receipt.kind === "contract") lines.push(...executionEvidenceLines(receipt, columns));
  else {
    for (const [owner, count] of Object.entries(receipt.removed ?? {}))
      receiptRow(lines, " ", `${owner} removed`, [{ text: String(count) }], columns);
    for (const issue of receipt.issues ?? []) {
      receiptRow(
        lines,
        "!",
        words(issue.kind),
        issue.kind === "reset-owner-stopped" ? [{ text: issue.owner }] : [],
        columns,
      );
      receiptPayload(lines, "reason", issue.diagnostic);
    }
  }
  return lines;
}
