/** @architectureCompositionRoot */
import { z } from "zod";
export { classifyVerb, type VerbCompletion, type VerbDisposition } from "./keiyaku-classify.js";
import { durationSchema } from "../akuma/call-input.js";
import { parseDuration } from "../duration.js";
import { addDebtInputSchema, updateDebtInputSchemas } from "../debt/input.js";
import { amendInputSchemas } from "./input.js";
import { askProgressSchema } from "../akuma/akuma-selection-execution.js";
import { akumaReportResultSchema } from "../akuma/akuma-instance.js";
import { akumaIdSchema } from "../akuma/identity.js";
import { contractIdSchema } from "../git/identity.js";
import { akumaNameCatalogSchema } from "../akuma/archetype.js";
import {
  akumaCatalogueSchema,
  akumaObservationSchema,
  akumaAskResultSchema,
  akumaAskNormalResultSchema,
  akumaKillResultSchema,
  akumaTellResultSchema,
  akumaWaitResultSchema,
  akumaWaitNormalResultSchema,
} from "../akuma/selection-observation.js";
import {
  regionResultSchema,
  kanshiReportSchema,
  contractStatusSchema,
  contractNormalStatusSchema,
} from "../kanshi/report.js";
import { settingsSchema } from "../settings.js";
import { contractCatalogueSchema } from "../protocol/read/status.js";
import { executionObservationSchema } from "../protocol/execution-observation.js";
import {
  spawnProgressSchema,
  spawnResultSchema,
  spawnNormalResultSchema,
  forkResultSchema,
  forkNormalResultSchema,
} from "./akuma-creation.js";
import {
  bindOutcomeSchema,
  bindNormalOutcomeSchema,
  amendOutcomeSchema,
  arcOutcomeSchema,
  deliverOutcomeSchema,
  deliveryPreviewOutcomeSchema,
  verifyOutcomeSchema,
  verifyNormalOutcomeSchema,
  reviewOutcomeSchema,
  abandonOutcomeSchema,
} from "./contract-outcomes.js";
import { contractHistorySchema } from "./contract-types.js";
import { guidanceSchema, guidanceNormalSchema } from "./kei.js";
import {
  contractWaitDurationSchema,
  contractWaitResultSchema,
  contractWaitNormalResultSchema,
} from "./contract-wait.js";
import { reconcileResultSchema } from "./reconcile.js";
import { akumaHistoryResultSchema, historySelectionSchemas } from "./selection.js";
import { whoamiFactsSchema } from "./keiyaku-identity.js";
import { resetOutcomeSchema } from "./outcome.js";
import {
  debtAbsentSchema,
  debtShowResultSchema,
  debtShowNormalResultSchema,
  debtDoctorReportSchema,
  debtMutationResultSchema,
  debtMutationNormalResultSchema,
  debtCatalogueSchema,
  debtListSchema,
  debtUpdateResultSchema,
} from "../debt/index.js";
import { debtIdSchema } from "../debt/identity.js";

export type VerbEntry = Readonly<{
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  normal?: z.ZodType;
  progress?: z.ZodType;
  effect: "read" | "write" | "destroy";
}>;
export type KeiyakuRunOptions = Readonly<{ signal?: AbortSignal }>;
export type VerbRun<E = never> = KeiyakuRunOptions & Readonly<{ observe?: (event: E) => void | PromiseLike<void> }>;

const text = z.string();
const nonblank = text.regex(/\S/u, "Must not be blank");
const optText = text.exactOptional();
const optBool = z.boolean().exactOptional();
const strings = z.array(text).readonly();
const positive = z.number().int().positive();
const timeout = durationSchema.exactOptional();
const waitDuration = text.refine((value) => parseDuration(value).kind === "parsed", {
  message: "wait requires an integer duration with unit ms, s, m, or h within the safe millisecond range",
});
const contract = {
  contract: optText.describe(
    "Target Contract selector (kei/...); omit to resolve from cwd when inside an appointed Contract worktree.",
  ),
};
const commonBind = {
  target: text
    .nullable()
    .exactOptional()
    .describe(
      "Integration target: branch name, active kei/... to stack on, or null for a targetless Contract. Omit to target the current branch.",
    ),
};
const jsonDocument = z.record(z.string(), z.unknown()).readonly();
const contractSelector = text.startsWith("kei/");
const akumaSelector = text.regex(/^(?!kei\/)/u);
const debtSelection = z
  .enum(["active", "closed", "all"])
  .exactOptional()
  .describe(
    'Debt lifecycle filter (valid only with "debt"/"debt/"): "active" (open, default), "closed" (done or drop), or "all".',
  );
const listBound = { limit: positive.exactOptional().describe("Maximum rows to return (positive integer).") };
const catalogueSelector =
  'Catalogue path selector: "kei"/"kei/", "debt"/"debt/", "aku"/"aku/" (akumaName values), or "aku/*" / "aku/*/*" / "aku/<name>" / "aku/<name>/*" (instances).';
const lsInputSchema = z.union([
  z.strictObject({ selector: text.regex(/^(?:kei|aku)\/?$/u).describe(catalogueSelector), ...listBound }).readonly(),
  z
    .strictObject({
      selector: text.regex(/^debt\/?$/u).describe(catalogueSelector),
      selection: debtSelection,
      ...listBound,
    })
    .readonly(),
  z
    .strictObject({
      selector: text.regex(/^aku\/(?:\*(?:\/\*)?|[^/*]+(?:\/\*|\/)?)$/u).describe(catalogueSelector),
      mine: optBool.describe(
        "When true on an Akuma-instance selector, restrict to direct and transitive descendants of this server environment's caller identity.",
      ),
      ...listBound,
    })
    .readonly(),
]);
const spawnFields = {
  akumaName: nonblank.describe(
    'akumaName to spawn. Use ls {"selector":"aku/"} to list valid names, including when the selected name is not found. Always births a new instance; use tell or ask to continue an existing Akuma.',
  ),
  contract: optText.describe(
    "Contract ID (kei/...) to record as Dispatch association for status/kanshi; does not set workdir or inject Contract text.",
  ),
  workdir: optText.describe("Execution directory for the Akuma (relative paths resolve from cwd; defaults to cwd)."),
  alias: optText.describe(
    "World-local alias (with or without leading @) assigned to this Akuma, reassigning any previous holder.",
  ),
  bare: optBool.describe(
    "Omit Keiyaku runtime instructions for this Akuma's lifetime (required for generic ACP providers).",
  ),
};
const tellFields = {
  akuma: text.describe("Target Akuma selector (aku/<name>/<hex> or @alias)."),
  prompt: nonblank.describe("Nonblank text instruction to admit."),
  interrupt: optBool.describe(
    "Request the currently running turn to yield before waking a successor turn for this prompt.",
  ),
};
export const verbs = Object.freeze({
  bind: {
    description:
      "Bind a Contract: one tracked delivery with fixed terms. Complete Markdown terms in (or forkOf to copy another's); a kei/... id and its own worktree out. target is where the work lands once accepted; gates is what must pass first. Runs no checks.",
    input: z.union([
      z
        .strictObject({
          markdown: text.describe(
            "Complete Contract Markdown document (# Title, ## Context, ## Objective, ## Design, ## Region, ## Criteria, optional ## Verification). Mutually exclusive with forkOf.",
          ),
          debt: debtIdSchema
            .exactOptional()
            .describe("Open Debt ID (debt/<slug>-<hex>) to associate as this Contract's held Debt."),
          ...commonBind,
          after: strings
            .exactOptional()
            .describe("Logical prerequisite Contract IDs (kei/...) that must be accepted before placement completes."),
          gates: strings
            .exactOptional()
            .describe(
              'Acceptance gate names overriding default gates (for example ["reviewed", "verified"], or [] for ungated placement).',
            ),
        })
        .readonly(),
      z
        .strictObject({
          forkOf: text.describe(
            "Existing Contract selector (kei/...) whose terms are copied into a new Contract. Mutually exclusive with markdown, debt, after, and gates.",
          ),
          ...commonBind,
        })
        .readonly(),
    ]),
    output: bindOutcomeSchema,
    normal: bindNormalOutcomeSchema,
    effect: "write",
  },
  amend: {
    description:
      "Rewrite an active Contract's terms, prerequisites (after), or gates. markdown is H2 edits such as ## Replace: Objective, not a new Contract. Returns only what changed.",
    input: z.union(
      amendInputSchemas.map((branch) =>
        (
          branch.extend({
            markdown: branch.shape.markdown.describe(
              "Replacement Contract Markdown document or section-level amendment.",
            ),
            after: branch.shape.after.describe(
              "Replacement prerequisite Contract IDs (kei/...); pass [] to clear prerequisites.",
            ),
            gates: branch.shape.gates.describe("Replacement acceptance gate names; pass [] to clear all gates."),
          }) as typeof branch
        )
          .extend(contract)
          .readonly(),
      ),
    ),
    output: amendOutcomeSchema,
    effect: "write",
  },
  arc: {
    description:
      "Open the next chapter of an active Contract: a # Title and optional notes telling its Akumas what is being done now. The terms stay as bound.",
    input: z
      .strictObject({
        ...contract,
        markdown: text.describe("Arc Markdown body naming and scoping the current chapter."),
      })
      .readonly(),
    output: arcOutcomeSchema,
    effect: "write",
  },
  deliver: {
    description:
      "Hand in the work from a Contract's worktree. It lands on the target once prerequisites are accepted and every gate passes (reviewed: a satisfied review; verified: passing verify results); until then it waits, delivered. Uncommitted changes need includeDirty. dryRun: true only looks. Runs no checks and records no review.",
    input: z.union([
      z
        .strictObject({
          ...contract,
          dryRun: z
            .literal(true)
            .describe(
              "When true, read-only preview of candidate integration, standing gate evidence, and target followability without recording delivery or mutating refs.",
            ),
          includeDirty: optBool.describe(
            "Capture uncommitted worktree and untracked changes via a private index without altering the worktree's real Git index.",
          ),
          showDiff: optBool.describe(
            "Include the candidate patch diff in dryRun preview output (valid only with dryRun: true).",
          ),
        })
        .readonly(),
      z
        .strictObject({
          ...contract,
          dryRun: z
            .literal(false)
            .exactOptional()
            .describe(
              "When true, read-only preview of candidate integration, standing gate evidence, and target followability without recording delivery or mutating refs.",
            ),
          message: optText.describe(
            "Optional commit/integration message for the delivered candidate (submission only).",
          ),
          includeDirty: optBool.describe(
            "Capture uncommitted worktree and untracked changes via a private index without altering the worktree's real Git index.",
          ),
          materializeConflict: optBool.describe(
            "When target integration conflicts, materialize conflict markers into the appointed worktree for resolution instead of refusing cleanly (submission only).",
          ),
          overwrite: optBool.describe(
            "Allow replacing an earlier delivered candidate when required by conflict or rewrite state (submission only).",
          ),
        })
        .readonly(),
    ]),
    output: z.union([deliverOutcomeSchema, deliveryPreviewOutcomeSchema]),
    progress: executionObservationSchema,
    effect: "write",
  },
  verify: {
    description:
      "Run the Contract's ## Verification checks now. A failed check is a verdict, not a tool error. Results are bound to the exact integration tree they ran on: any change to the work or the target makes them stale. They count only under the verified gate, and may land an already-delivered Contract.",
    input: z
      .strictObject({
        ...contract,
        index: positive
          .exactOptional()
          .describe("1-based position of a single ## Verification fence to execute; omit to run all declared fences."),
        includeDirty: optBool.describe(
          "Verify a prospective snapshot that includes uncommitted worktree changes without staging them.",
        ),
      })
      .readonly(),
    output: verifyOutcomeSchema,
    normal: verifyNormalOutcomeSchema,
    progress: executionObservationSchema,
    effect: "write",
  },
  review: {
    description:
      "Record your verdict on a Contract's diff: satisfied or unsatisfied, with reasons. Valid before or after deliver. Bound to the diff content: a pure rebase keeps it, a changed diff makes it stale. Satisfied may land an already-delivered Contract.",
    input: z
      .strictObject({
        ...contract,
        verdict: z
          .enum(["satisfied", "unsatisfied"])
          .describe('Review judgment for the candidate: "satisfied" or "unsatisfied".'),
        summary: nonblank.describe("Nonblank review rationale and findings recorded as testimony."),
      })
      .readonly(),
    output: reviewOutcomeSchema,
    progress: executionObservationSchema,
    effect: "write",
  },
  abandon: {
    description: "Break an active Contract. Its work never lands; its worktree is reclaimed. No undo.",
    input: z
      .strictObject({
        ...contract,
        note: optText.describe("Optional reason recorded on the abandonment entry."),
      })
      .readonly(),
    output: abandonOutcomeSchema,
    effect: "destroy",
  },
  show: {
    description:
      "Read a Contract in full: terms, current chapter, and working instructions. Or read one Debt in full with its links. Omit id to read the Contract whose worktree you stand in.",
    input: z
      .strictObject({
        id: text
          .superRefine((id, context) => {
            if (
              debtIdSchema.safeParse(id).success ||
              contractIdSchema.safeParse(id.startsWith("@") ? `kei/${id.slice(1)}` : id).success
            )
              return;
            context.addIssue({
              code: "custom",
              message: id.startsWith("@kei/")
                ? `redundant short contract selector: ${id}`
                : "show requires one Contract selector or one Debt ID",
            });
          })
          .exactOptional()
          .describe(
            "One kei/... or @name for Contract guidance, or one debt/... ID. Omit for contextual Contract guidance from cwd.",
          ),
      })
      .readonly(),
    output: z.union([guidanceSchema, debtShowResultSchema, debtAbsentSchema]),
    normal: z.union([guidanceNormalSchema, debtShowNormalResultSchema]),
    effect: "read",
  },
  reconcile: {
    description:
      "Finish what an interrupted or lagging call left half done: Git, worktree, and hook steps, for one Contract or all. Safe to repeat; never undoes a recorded result.",
    input: z
      .strictObject({
        contract: optText.describe(
          "Contract selector (kei/...) to reconcile; omit to reconcile all Contracts in the repo.",
        ),
        retryHooks: optBool.describe("Re-run failed worktree lifecycle hooks during reconciliation."),
      })
      .readonly(),
    output: reconcileResultSchema,
    effect: "write",
  },
  spawn: {
    description:
      "Birth a new Akuma from akumaName (ls aku/), with an optional first order. contract only marks whose work it is; give it a workdir and the terms yourself. A failed result with an akumaId still left an Akuma alive.",
    input: z
      .strictObject({
        ...spawnFields,
        wait: waitDuration
          .exactOptional()
          .describe(
            "Wait for the opening turn's text answer up to this duration (e.g. 10m); requires prompt. The deadline never kills the Akuma. Omit to return after birth and admission.",
          ),
        prompt: nonblank.exactOptional().describe("Opening instruction text; omit to birth idle. Required with wait."),
      })
      .refine((input) => input.wait === undefined || input.prompt !== undefined, "spawn wait requires prompt")
      .readonly(),
    output: spawnResultSchema,
    normal: spawnNormalResultSchema,
    progress: spawnProgressSchema,
    effect: "write",
  },
  fork: {
    description:
      "Birth a copy of an Akuma as it stood at an answered turn (turn/<n> from history), to try another path. The copy wakes idle; give it orders with tell. Needs provider support.",
    input: z
      .strictObject({
        akuma: text.describe("Source Akuma selector (aku/<name>/<hex> or @alias)."),
        at: text.describe("Exact retained answered turn coordinate (turn/<n>) to branch from."),
        bare: optBool.describe(
          "Omit Keiyaku runtime instructions on the forked child (a bare parent stays bare regardless).",
        ),
      })
      .readonly(),
    output: forkResultSchema,
    normal: forkNormalResultSchema,
    effect: "write",
  },
  tell: {
    description:
      "Give an Akuma new orders: steers its current work or wakes it. Returns once accepted; wait (e.g. 10m) also returns that turn's answer. A timeout ends the waiting, not the work.",
    input: z
      .strictObject({
        ...tellFields,
        wait: waitDuration
          .exactOptional()
          .describe(
            "Wait for this exact turn's text answer up to this duration (e.g. 10m). Omit to return after admission; the deadline never retracts the Tell or kills the Akuma.",
          ),
      })
      .readonly(),
    output: akumaTellResultSchema,
    progress: askProgressSchema,
    effect: "write",
  },
  ask: {
    description:
      "Demand a structured answer from an Akuma: a prompt and a JSON Schema in, parsed JSON out. The answer is not checked against the schema; non-JSON is a failure. Not every provider honors schemas.",
    input: z
      .strictObject({
        akuma: text.describe("Target Akuma selector (aku/<name>/<hex> or @alias)."),
        prompt: nonblank.describe("Nonblank question or instruction to admit."),
        timeoutMs: timeout.describe(
          "Optional observation deadline in integer milliseconds (stops observation on deadline without retracting the prompt or killing the Akuma).",
        ),
        schema: jsonDocument.describe("JSON Schema object sent to the provider to constrain the turn's JSON output."),
        interrupt: optBool.describe("Request the currently running turn to yield before running this Ask."),
      })
      .readonly(),
    output: akumaAskResultSchema,
    normal: akumaAskNormalResultSchema,
    progress: askProgressSchema,
    effect: "write",
  },
  kill: {
    description:
      "Kill an Akuma's current execution. Nothing is erased: history and queued orders remain, and tell or ask wakes it.",
    input: z
      .strictObject({
        akuma: nonblank.describe(
          'One Akuma selector: aku/<name>/<hex>, @alias, kei/... (all Akumas dispatched to that Contract), or glob "aku/<name-pattern>/<hex-pattern>". Contract/glob selection may expand to several members.',
        ),
      })
      .readonly(),
    output: akumaKillResultSchema,
    effect: "destroy",
  },
  wait: {
    description:
      "Wait until selected Contracts change or close, or selected Akumas finish their current work. Contracts or Akumas, never both in one call. Already closed or finished returns at once. A timeout ends the waiting, not the work.",
    input: z.union([
      z
        .strictObject({
          selectors: z
            .array(contractSelector)
            .min(1)
            .readonly()
            .describe(
              'Nonempty homogeneous selector list: either all Contract IDs (kei/...) or all Akuma selectors (aku/<name>/<hex>, @alias, or "aku/<name-pattern>/<hex-pattern>").',
            ),
          completion: z
            .enum(["any", "all"])
            .exactOptional()
            .describe('Wake when "any" selected target settles/changes (default) or wait for "all".'),
          timeoutMs: contractWaitDurationSchema
            .exactOptional()
            .describe(
              'Observation deadline in integer milliseconds; returns reason "deadline" without canceling work.',
            ),
        })
        .readonly(),
      z
        .strictObject({
          selectors: z
            .array(akumaSelector)
            .min(1)
            .readonly()
            .describe(
              'Nonempty homogeneous selector list: either all Contract IDs (kei/...) or all Akuma selectors (aku/<name>/<hex>, @alias, or "aku/<name-pattern>/<hex-pattern>").',
            ),
          completion: z
            .enum(["any", "all"])
            .exactOptional()
            .describe('Wake when "any" selected target settles/changes (default) or wait for "all".'),
          timeoutMs: timeout.describe(
            'Observation deadline in integer milliseconds; returns reason "deadline" without canceling work.',
          ),
        })
        .readonly(),
    ]),
    output: z.union([contractWaitResultSchema, akumaWaitResultSchema]),
    normal: z.union([contractWaitNormalResultSchema, akumaWaitNormalResultSchema]),
    effect: "read",
  },
  history: {
    description:
      "Look back: a Contract's journal, or an Akuma's recent activity. For an Akuma, last returns its latest answer and id opens one item such as turn/<n> or report/<n>.",
    input: z.union([
      z
        .strictObject({
          selector: contractSelector.describe(
            "Single subject: kei/... for Contract history, or aku/<name>/<hex> / @alias for Akuma history.",
          ),
          full: optBool.describe("Include full event details on Contract history (valid only for kei/... selectors)."),
        })
        .readonly(),
      ...historySelectionSchemas.map((branch) =>
        (
          branch.extend({
            last: branch.shape.last.describe(
              "When true, return only the Akuma's latest retained answer bytes (mutually exclusive with id, before, since, and limit).",
            ),
            ...("id" in branch.shape
              ? {
                  id: branch.shape.id.describe(
                    "Exact Akuma item coordinate: turn/<n> (turn outcome), report/<n> (full progress report), or positive decimal activity sequence. Mutually exclusive with before, since, limit, and last.",
                  ),
                }
              : {}),
            ...("before" in branch.shape
              ? {
                  before: branch.shape.before.describe(
                    "Page older Akuma timeline events strictly before this positive decimal sequence.",
                  ),
                }
              : {}),
            ...("since" in branch.shape
              ? {
                  since: branch.shape.since.describe(
                    "Page newer Akuma timeline events strictly after this nonnegative decimal sequence (mutually exclusive with before).",
                  ),
                }
              : {}),
            ...("limit" in branch.shape
              ? { limit: branch.shape.limit.describe("Maximum Akuma timeline rows to return (1..5000, default 12).") }
              : {}),
          }) as typeof branch
        )
          .extend({
            selector: akumaSelector.describe(
              "Single subject: kei/... for Contract history, or aku/<name>/<hex> / @alias for Akuma history.",
            ),
          })
          .readonly(),
      ),
    ]),
    output: z.union([contractHistorySchema, akumaHistoryResultSchema]),
    effect: "read",
  },
  report: {
    description:
      "From inside a running Akuma, leave a progress note for whoever holds it and keep working. Only works when this server runs inside that Akuma.",
    input: z
      .strictObject({
        text: nonblank.describe("Nonblank progress report Markdown/text recorded on the current turn timeline."),
      })
      .readonly(),
    output: akumaReportResultSchema,
    effect: "write",
  },
  whoami: {
    description:
      "Who this server acts as: caller or Akuma identity, its Contract link and turn initiator, and which Contract worktree cwd stands in. Read from the environment; not authentication.",
    input: z.strictObject({}).readonly(),
    output: whoamiFactsSchema,
    effect: "read",
  },
  settings: {
    description: "Observe resolved Settings.",
    input: z.strictObject({}).readonly(),
    output: settingsSchema,
    effect: "read",
  },
  nuke: {
    description: "Reset the selected World with explicit confirmation.",
    input: z.strictObject({ confirm: optText }).readonly(),
    output: resetOutcomeSchema,
    effect: "destroy",
  },
  kanshi: {
    description:
      "Watch everything at once: active Contracts, Debts, and Akumas. Use status, show, or history to look closer.",
    input: z.strictObject({}).readonly(),
    output: kanshiReportSchema,
    effect: "read",
  },
  status: {
    description:
      "Where one Contract stands (stage, gates, prerequisites, worktree) or what one Akuma is doing (state, current work, changed files). Exact kei/... or aku/<name>/<id> only; no aliases.",
    input: z
      .strictObject({
        id: z
          .union([contractIdSchema, akumaIdSchema])
          .describe(
            "Exact Contract ID (kei/...) or Akuma ID (aku/<name>/<hex>); @aliases and category paths are refused.",
          ),
      })
      .readonly(),
    output: z.union([contractStatusSchema, akumaObservationSchema]),
    normal: z.union([contractNormalStatusSchema, akumaObservationSchema]),
    effect: "read",
  },
  ls: {
    description:
      "List ids of one kind: active Contracts (kei/), open Debts (debt/), akumaName values you can birth (aku/), or existing Akumas (aku/*).",
    input: lsInputSchema,
    output: z.union([contractCatalogueSchema, akumaCatalogueSchema, akumaNameCatalogSchema, debtCatalogueSchema]),
    normal: z.union([contractCatalogueSchema, akumaCatalogueSchema, akumaNameCatalogSchema, debtListSchema]),
    effect: "read",
  },
  region: {
    description:
      "Before parallel work: which files active Contracts claim to change and where those claims overlap. Advisory only; no locks, no conflict prediction.",
    input: z.union([
      z.strictObject({}).readonly(),
      z
        .strictObject({
          contract: text.describe(
            "Contract selector (kei/...) whose declared Region and overlaps to inspect; mutually exclusive with paths.",
          ),
        })
        .readonly(),
      z
        .strictObject({
          paths: z
            .array(text)
            .min(1)
            .readonly()
            .describe(
              "Nonempty repository-relative path or glob patterns to check against active Contract Regions; mutually exclusive with contract.",
            ),
        })
        .readonly(),
    ]),
    output: regionResultSchema,
    effect: "read",
  },
  "debt.add": {
    description:
      "Record a Debt: a confirmed problem or unfinished work still owed, with optional priority and links to other Debts. Returns its debt/... id.",
    input: addDebtInputSchema.readonly(),
    output: debtMutationResultSchema,
    normal: debtMutationNormalResultSchema,
    effect: "write",
  },
  "debt.addDocument": {
    description: "Create a Debt from Markdown.",
    input: z.strictObject({ markdown: text }).readonly(),
    output: debtMutationResultSchema,
    effect: "write",
  },
  "debt.update": {
    description:
      "Settle a Debt as done or dropped, or edit its text, priority, or links. Settling is final. body replaces the text, appendBody adds to it; never both.",
    input: z.union(
      updateDebtInputSchemas.map((branch) =>
        branch.safeExtend({ id: debtIdSchema.describe("Target Debt ID (debt/<slug>-<hex>).") }).readonly(),
      ),
    ),
    output: debtUpdateResultSchema,
    effect: "write",
  },
  "debt.doctor": {
    description: "Diagnose Debt authority and relations.",
    input: z.strictObject({}).readonly(),
    output: z.union([debtDoctorReportSchema, debtAbsentSchema]),
    effect: "read",
  },
} as const satisfies Record<string, VerbEntry>);

export type VerbOutputs = { [K in keyof typeof verbs]: z.output<(typeof verbs)[K]["output"]> };
export type VerbName = keyof typeof verbs;
export type VerbInput<K extends VerbName> = z.input<(typeof verbs)[K]["input"]>;
export type VerbOutput<K extends VerbName> = VerbOutputs[K];
export type VerbProgress<K extends VerbName> = (typeof verbs)[K] extends { readonly progress: z.ZodType<infer E> }
  ? E
  : never;
export type VerbRunFor<K extends VerbName> = VerbRun<VerbProgress<K>>;
