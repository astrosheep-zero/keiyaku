/** @architectureCompositionRoot */
import { z } from "zod";
import { lifecycleSelectionSchema } from "../bounded-list.js";
export { classifyVerb, type VerbCompletion, type VerbDisposition } from "./keiyaku-classify.js";
// Native owner declarations shared with transport descriptions at this composition boundary.
export {
  akumaCatalogueSchema,
  akumaCatalogueRowSchema,
  akumaObservationSchema,
  observedAkumaWaitItemSchema,
} from "../akuma/selection-observation.js";
export { dispatchAssociationSchema } from "../akuma/dispatch-association.js";
export { currentWorkSchema } from "../akuma/status-projection.js";
export { contractCatalogueSchema, contractSummarySchema } from "../protocol/read/status.js";
export { contractNormalStatusSchema } from "../kanshi/report.js";
export { akumaNameCatalogSchema, akumaNameCatalogRowSchema } from "../akuma/archetype.js";
export { debtListSchema, debtSummarySchema } from "../debt/index.js";
export { contractIdSchema } from "../git/identity.js";
export { akumaIdSchema } from "../akuma/identity.js";
import { parseDuration } from "../duration.js";
import { addDebtInputSchema, updateDebtInputSchema } from "../debt/input.js";
import { amendInputSchema } from "./input.js";
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
import { invocationWaitResultSchema, invocationWaitNormalResultSchema } from "./keiyaku-wait.js";
import { akumaAliasSchema, parseAkumaGlob, parseReadableAkumaAlias } from "../identity/selector.js";
import { reconcileResultSchema } from "./reconcile.js";
import { akumaHistoryResultSchema } from "./selection.js";
import { historyInputSchemas } from "../akuma/akuma-owner.js";
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
const duration = text.refine((value) => parseDuration(value).kind === "parsed", {
  message: "timeout requires an integer duration with unit ms, s, m, or h within the safe millisecond range",
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
      "Where accepted work lands: an existing branch, an active kei/... to stack on, or null for no target. Omit to use the current branch, or copy the source target with forkOf.",
    ),
};
const jsonDocument = z.record(z.string(), z.unknown()).readonly();
const contractSelector = text.startsWith("kei/");
const akumaSelector = text.regex(/^(?!kei\/)/u);
const catalogueSelection = lifecycleSelectionSchema
  .exactOptional()
  .describe(
    'Lifecycle selection for Contract, Debt, and Akuma-instance catalogues: "active" (still in play, default), "settled" (at rest), or "all". Not valid for akumaName values (aku/).',
  );
const catalogueSelector =
  'Catalogue path selector: "kei"/"kei/", "debt"/"debt/", "aku"/"aku/" (akumaName values), or "aku/*" / "aku/*/*" / "aku/<name>" / "aku/<name>/*" (instances).';
const lsInputSchema = z
  .strictObject({
    selector: text
      .regex(/^(?:kei|debt|aku)\/?$|^aku\/(?:\*(?:\/\*)?|[^/*]+(?:\/\*|\/)?)$/u)
      .describe(catalogueSelector),
    limit: positive.exactOptional().describe("Maximum rows to return (positive integer)."),
    lifecycle: catalogueSelection,
    mine: optBool.describe("Only Akumas you started, directly or through your Akumas; valid only for instances."),
  })
  .superRefine(({ selector, lifecycle, mine }, context) => {
    if (lifecycle !== undefined && (selector === "aku" || selector === "aku/"))
      context.addIssue({
        code: "custom",
        message: "lifecycle is valid only with a Contract, Debt, or Akuma-instance catalogue",
      });
    if (mine !== undefined && (!selector.startsWith("aku/") || selector === "aku/"))
      context.addIssue({ code: "custom", message: "mine is valid only with an Akuma-instance catalogue" });
  })
  .readonly();
const spawnFields = {
  akumaName: nonblank.describe(
    'akumaName to spawn. Use ls {"selector":"aku/"} to list valid names, including when the selected name is not found. Always births a new instance; use tell or ask to continue an existing Akuma.',
  ),
  contract: optText.describe(
    "Contract ID (kei/...) whose work this Akuma does, shown in status and kanshi; does not set workdir or supply its terms.",
  ),
  workdir: optText.describe("Execution directory for the Akuma (relative paths resolve from cwd; defaults to cwd)."),
  alias: optText.describe(
    "World-local alias (with or without leading @) assigned to this Akuma, reassigning any previous holder.",
  ),
  bare: optBool.describe("Omit Keiyaku-specific instructions for this Akuma's lifetime."),
};
const tellFields = {
  akuma: text.describe("Target Akuma selector (aku/<name>/<hex> or @alias)."),
  prompt: nonblank.describe("Nonblank text instruction to admit."),
  interrupt: optBool.describe("Interrupt current work before running this prompt."),
};
export const verbs = Object.freeze({
  bind: {
    description:
      "Bind a Contract: give exactly one of terms (complete Contract Markdown) or forkOf (copy another Contract). Returns a kei/... id and its own worktree. target is where accepted work lands; gates is what must pass first. Runs no checks.",
    input: z.union([
      z
        .strictObject({
          terms: text.describe(
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
            "Existing Contract selector (kei/...) whose terms are copied into a new Contract. Mutually exclusive with terms, debt, after, and gates.",
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
      "Edit an active Contract's terms, target, prerequisites (after), or gates; naming none reports the Contract unchanged. Supply edits as section operations such as ## Replace: Objective, not a replacement Contract. Returns only what changed.",
    input: amendInputSchema
      .extend({
        edits: amendInputSchema.shape.edits.describe(
          "Section edits to the current terms, using H2 headings such as ## Replace: Objective; not a replacement Contract.",
        ),
        after: amendInputSchema.shape.after.describe(
          "Replacement prerequisite Contract IDs (kei/...); pass [] to clear prerequisites.",
        ),
        gates: amendInputSchema.shape.gates.describe("Replacement acceptance gate names; pass [] to clear all gates."),
        target: amendInputSchema.shape.target.describe(
          "Explicit existing branch or active Contract destination; omission retains the current target.",
        ),
      })
      .extend(contract)
      .readonly(),
    output: amendOutcomeSchema,
    effect: "write",
  },
  arc: {
    description:
      "Open the next chapter of an active Contract: give a # Title and optional narrative telling its Akumas what is being done now. Returns the new chapter number; the Contract terms stay unchanged.",
    input: z
      .strictObject({
        ...contract,
        body: text.describe("Chapter Markdown: a # Title and optional narrative describing the current work."),
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
              "Preview the candidate, current gate evidence, and target readiness without submitting delivery.",
            ),
          includeDirty: optBool.describe(
            "Include uncommitted and untracked worktree changes in the candidate without staging them.",
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
              "Preview the candidate, current gate evidence, and target readiness without submitting delivery.",
            ),
          message: optText.describe(
            "Optional commit/integration message for the delivered candidate (submission only).",
          ),
          includeDirty: optBool.describe(
            "Include uncommitted and untracked worktree changes in the candidate without staging them.",
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
      "Read a Contract in full: terms, current chapter, and working instructions. Or read one Debt in full with its prerequisites. Requires one explicit selector.",
    input: z
      .strictObject({
        selector: text
          .superRefine((selector, context) => {
            if (
              debtIdSchema.safeParse(selector).success ||
              contractIdSchema.safeParse(selector.startsWith("@") ? `kei/${selector.slice(1)}` : selector).success
            )
              return;
            context.addIssue({
              code: "custom",
              message: selector.startsWith("@kei/")
                ? `redundant short contract selector: ${selector}`
                : "show requires one Contract selector or one Debt ID",
            });
          })
          .describe("One explicit kei/... or @name for Contract guidance, or one debt/... ID."),
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
      "Birth a new Akuma from akumaName (ls aku/), with an optional first order. Returns birth and admission, not an answer; observe separately with wait. contract only marks whose work it is; give it a workdir and the terms yourself. A failed result with an akumaId still left an Akuma alive.",
    input: z
      .strictObject({
        ...spawnFields,
        prompt: nonblank.exactOptional().describe("Opening instruction text; omit to birth idle."),
      })
      .readonly(),
    output: spawnResultSchema,
    normal: spawnNormalResultSchema,
    effect: "write",
  },
  fork: {
    description:
      "Birth a copy of an Akuma as it stood at an answered turn (turn/<n> from history), to try another path. The copy wakes idle; give it orders with tell. Available only for Akumas that support forking.",
    input: z
      .strictObject({
        akuma: text.describe("Source Akuma selector (aku/<name>/<hex> or @alias)."),
        at: text.describe("Exact retained answered turn coordinate (turn/<n>) to branch from."),
        bare: optBool.describe("Omit Keiyaku instructions on the forked child (a bare parent stays bare regardless)."),
      })
      .readonly(),
    output: forkResultSchema,
    normal: forkNormalResultSchema,
    effect: "write",
  },
  tell: {
    description:
      "Give an Akuma new orders: steers its current work or wakes it. Returns admission, not an answer. Observe work separately with wait, or use ask for a structured answer.",
    input: z
      .strictObject({
        ...tellFields,
      })
      .readonly(),
    output: akumaTellResultSchema,
    effect: "write",
  },
  ask: {
    description:
      "Demand a structured answer from an Akuma: a prompt and a JSON Schema in, parsed JSON out. The answer is not checked against the schema; non-JSON is a failure. Some Akumas cannot constrain answers to a schema.",
    input: z
      .strictObject({
        akuma: text.describe("Target Akuma selector (aku/<name>/<hex> or @alias)."),
        prompt: nonblank.describe("Nonblank question or instruction to admit."),
        timeout: duration
          .exactOptional()
          .describe(
            "How long to watch for the answer (e.g. 30s or 5m); omit for no deadline. The deadline only stops watching, never the work.",
          ),
        schema: jsonDocument.describe("JSON Schema object describing the JSON answer you want."),
        interrupt: optBool.describe("Interrupt current work before answering this Ask."),
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
      "Wait for Contracts to change or close and Akumas to finish their current work, together or separately. Any/all applies to the whole selection. Already satisfied members count immediately. A timeout ends observation, never the work.",
    input: z
      .strictObject({
        selectors: z
          .array(
            z.union([
              contractIdSchema,
              text.refine((value) => {
                try {
                  if (value.startsWith("@")) parseReadableAkumaAlias(value);
                  else if (value.includes("*")) parseAkumaGlob(value);
                  else return akumaIdSchema.safeParse(value).success;
                  return true;
                } catch {
                  return false;
                }
              }, "Expected an Akuma ID, alias or glob"),
            ]),
          )
          .min(1)
          .readonly()
          .describe(
            'Contract IDs (kei/...) and Akuma selectors (aku/<name>/<hex>, @alias, or "aku/<name-pattern>/<hex-pattern>"), in caller order. A Contract selects its journal, not dispatched Akumas.',
          ),
        completion: z
          .enum(["any", "all"])
          .exactOptional()
          .describe('Wake when "any" member satisfies (default), or wait for "all" members.'),
        timeout: duration
          .exactOptional()
          .describe(
            "How long to watch (e.g. 30s or 5m); omit for no deadline. The deadline only stops watching, never the work. 0ms returns the current state at once.",
          ),
      })
      .readonly(),
    output: invocationWaitResultSchema,
    normal: invocationWaitNormalResultSchema,
    effect: "read",
  },
  history: {
    description:
      "Read a Contract's changes, or an Akuma's activity. For an Akuma, item opens one result or activity; omit it to page the timeline.",
    input: z.union([
      z
        .strictObject({
          selector: contractSelector.describe(
            "Single subject: kei/... for Contract history, or aku/<name>/<hex> / @alias for Akuma history.",
          ),
          details: optBool.describe("Also show each change's terms; valid only for Contract history."),
        })
        .readonly(),
      ...[
        z.strictObject({
          item: text
            .refine(
              (value) => value === "last" || historyInputSchemas[0].shape.id.safeParse(value).success,
              "item must be last, turn/<positive safe integer>, report/<positive safe integer>, or a positive safe decimal sequence",
            )
            .describe(
              'One Akuma item: "last" for the latest answer, turn/<n> for a turn outcome, report/<n> for a progress report, or a positive decimal activity sequence. Cannot be combined with before, since, or limit.',
            ),
        }),
        z.strictObject({
          before: historyInputSchemas[1].shape.before.describe(
            "Page events strictly before this positive decimal sequence; cannot be combined with since or item.",
          ),
          limit: historyInputSchemas[1].shape.limit.describe("Maximum timeline rows (1..5000, default 12)."),
        }),
        z.strictObject({
          since: historyInputSchemas[2].shape.since.describe(
            "Page events strictly after this positive decimal sequence; cannot be combined with before or item.",
          ),
          limit: historyInputSchemas[2].shape.limit.describe("Maximum timeline rows (1..5000, default 12)."),
        }),
      ].map((branch) =>
        branch
          .extend({
            selector: akumaSelector.describe("One Akuma ID (aku/<name>/<hex>) or @alias."),
          })
          .readonly(),
      ),
    ]),
    output: z.union([contractHistorySchema, akumaHistoryResultSchema]),
    effect: "read",
  },
  report: {
    description:
      "From inside a running Akuma only, leave a progress note for whoever holds you and keep working. Returns confirmation that the note was recorded, not that it was received.",
    input: z
      .strictObject({
        text: nonblank.describe("Nonblank progress note, in Markdown or plain text, to add to your current turn."),
      })
      .readonly(),
    output: akumaReportResultSchema,
    effect: "write",
  },
  whoami: {
    description:
      "See who you are acting as and which Contract/worktree you are in, including your Akuma identity and turn initiator when available. This is context, not authentication.",
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
      "Where one Contract stands (stage, gates, prerequisites, worktree) or what one Akuma is doing (state, current work, changed files). Select one complete identity or @name; returns its canonical id.",
    input: z
      .strictObject({
        selector: z
          .union([contractIdSchema, akumaIdSchema, akumaAliasSchema])
          .refine((value) => !/[*?\[\]]/u.test(value), "status does not accept globs")
          .describe(
            "One complete Contract ID (kei/...), Akuma ID (aku/<name>/<hex>), or @name (Contract shorthand or World-local Akuma alias). Ambiguous names, globs and categories are refused.",
          ),
      })
      .readonly(),
    output: z.union([contractStatusSchema, akumaObservationSchema]),
    normal: z.union([contractNormalStatusSchema, akumaObservationSchema]),
    effect: "read",
  },
  ls: {
    description:
      "List ids of one kind: Contracts (kei/), Debts (debt/), Akuma instances (aku/*), or akumaName values you can birth (aku/). Lifecycle selection is active (default), settled, or all; akumaName values have no lifecycle selection.",
    input: lsInputSchema,
    output: z.union([contractCatalogueSchema, akumaCatalogueSchema, akumaNameCatalogSchema, debtCatalogueSchema]),
    normal: z.union([contractCatalogueSchema, akumaCatalogueSchema, akumaNameCatalogSchema, debtListSchema]),
    effect: "read",
  },
  region: {
    description:
      "Before parallel work: which files active Contracts claim to change and where those claims overlap. Advisory only; no locks, no conflict prediction.",
    input: z
      .strictObject({
        contract: optText.describe(
          "Contract selector (kei/...) whose declared Region and overlaps to inspect; mutually exclusive with paths.",
        ),
        paths: z
          .array(text)
          .min(1)
          .readonly()
          .refine((paths): paths is readonly [string, ...string[]] => paths.length > 0)
          .exactOptional()
          .describe(
            "Nonempty repository-relative path or glob patterns to check against active Contract Regions; mutually exclusive with contract.",
          ),
      })
      .refine(
        (input) => !(input.contract !== undefined && input.paths !== undefined),
        "contract and paths are mutually exclusive",
      )
      .readonly(),
    output: regionResultSchema,
    effect: "read",
  },
  "debt.add": {
    description:
      "Record open work still owed, with optional body, priority and prerequisite needs. Returns its debt/... id.",
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
      "Change at least one Debt field: text, priority, prerequisites, or disposition (open, done, drop). Any state may be reopened or changed; omitted fields are preserved and empty body, note or needs clears them. Returns the updated Debt or reports no change.",
    input: updateDebtInputSchema
      .safeExtend({ id: debtIdSchema.describe("Target Debt ID (debt/<slug>-<hex>).") })
      .readonly(),
    output: debtUpdateResultSchema,
    effect: "write",
  },
  "debt.doctor": {
    description: "Diagnose Debt authority and prerequisites.",
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
