/** @architectureCompositionRoot */
import { z } from "zod";
export { classifyVerb, type VerbCompletion, type VerbDisposition } from "./keiyaku-classify.js";
import { durationSchema, tellObservationSchemas } from "../akuma/call-input.js";
import { addDebtInputSchema, updateDebtInputSchemas } from "../debt/input.js";
import { amendInputSchemas } from "./input.js";
import { askProgressSchema } from "../akuma/akuma-selection-execution.js";
import { akumaReportResultSchema } from "../akuma/akuma-instance.js";
import { akumaIdSchema } from "../akuma/identity.js";
import { contractIdSchema } from "../git/identity.js";
import { archetypeCatalogSchema } from "../akuma/archetype.js";
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
  spawnModeSchemas,
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
export type VerbRun<E = never> = Readonly<{ signal?: AbortSignal; observe?: (event: E) => void | PromiseLike<void> }>;

const text = z.string();
const nonblank = text.regex(/\S/u, "Must not be blank");
const optText = text.exactOptional();
const optBool = z.boolean().exactOptional();
const strings = z.array(text).readonly();
const positive = z.number().int().positive();
const timeout = durationSchema.exactOptional();
const contract = {
  contract: optText.describe(
    "Target Contract selector (kei/...); omit to resolve from cwd when inside an appointed Contract worktree.",
  ),
};
const actor = { actor: optText.describe("Optional caller attribution recorded on the journal entry.") };
const commonBind = {
  target: text
    .nullable()
    .exactOptional()
    .describe(
      "Integration target: branch name, active kei/... to stack on, or null for a targetless Contract. Omit to target the current branch.",
    ),
  ...actor,
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
  'Catalogue path selector: "kei"/"kei/", "debt"/"debt/", "aku"/"aku/" (archetypes), or "aku/*" / "aku/*/*" / "aku/<name>" / "aku/<name>/*" (instances).';
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
    'Archetype name to spawn (from ls {"selector":"aku/"}). Always births a new instance; use tell or ask to continue an existing Akuma.',
  ),
  contract: optText.describe(
    "Contract ID (kei/...) to record as Dispatch association for status/kanshi; does not set workdir or inject Contract text.",
  ),
  workdir: optText.describe("Execution directory for the Akuma (relative paths resolve from cwd; defaults to cwd)."),
  alias: optText.describe(
    "World-local alias (with or without leading @) assigned to this Akuma, reassigning any previous holder.",
  ),
  writableDirectories: strings
    .exactOptional()
    .describe(
      "Additional writable root paths granted to Codex workspace-write sandboxes (relative paths resolve from cwd).",
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
      "Bind a new Contract from complete Markdown terms or fork an existing Contract's terms, and appoint an isolated worktree when targeting a branch or active Contract. Does not run Verification.",
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
      "Amend an active Contract's Markdown terms, prerequisite Contracts, or acceptance gates. Supply at least one of markdown, after, or gates.",
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
            actor: branch.shape.actor.describe("Optional caller attribution recorded on the journal entry."),
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
      "Record the current execution chapter (Arc) on an active Contract without rewriting its permanent terms.",
    input: z
      .strictObject({
        ...contract,
        markdown: text.describe("Arc Markdown body naming and scoping the current chapter."),
        ...actor,
      })
      .readonly(),
    output: arcOutcomeSchema,
    effect: "write",
  },
  deliver: {
    description:
      "Submit a Contract candidate from its appointed worktree and place it onto its target once prerequisites and gates are satisfied, or preview readiness with dryRun: true. Consumes existing gate testimony and never runs Verification.",
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
      "Execute ## Verification code fences from the Contract in independent scratch directories. An unsatisfied check is a normal negative verdict (isError: false), distinct from an operational failure. Records testimony and attempts placement only when the Contract has the verified gate.",
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
      "Record whole-Contract review testimony (satisfied or unsatisfied) bound to the candidate's diff content (survives pure rebase). Never runs Verification; a satisfied verdict completes placement if a candidate is delivered and all other requirements are met.",
    input: z
      .strictObject({
        ...contract,
        verdict: z
          .enum(["satisfied", "unsatisfied"])
          .describe('Review judgment for the candidate: "satisfied" or "unsatisfied".'),
        summary: nonblank.describe("Nonblank review rationale and findings recorded as testimony."),
        actor: optText.describe("Optional reviewer attribution recorded on the testimony."),
      })
      .readonly(),
    output: reviewOutcomeSchema,
    progress: executionObservationSchema,
    effect: "write",
  },
  abandon: {
    description: "Close an active Contract without integrating its work and retire its appointed worktree.",
    input: z
      .strictObject({
        ...contract,
        note: optText.describe("Optional reason recorded on the abandonment entry."),
        ...actor,
      })
      .readonly(),
    output: abandonOutcomeSchema,
    effect: "destroy",
  },
  show: {
    description:
      "Read full Contract guidance (terms, current Arc, and workspace context) or full Debt documents with relationship trees. Omitting id and ids reads contextual Contract guidance from cwd.",
    input: z.union([
      z
        .strictObject({
          id: text
            .exactOptional()
            .describe(
              "Single selector to read: kei/... or @alias for Contract guidance, or debt/<slug>-<hex> for one Debt. Omit when not passing ids to read contextual Contract guidance from cwd.",
            ),
        })
        .readonly(),
      z
        .strictObject({
          ids: z
            .array(debtIdSchema)
            .nonempty()
            .readonly()
            .describe("Nonempty list of Debt IDs (debt/<slug>-<hex>) to read together; mutually exclusive with id."),
        })
        .readonly(),
    ]),
    output: z.union([guidanceSchema, debtShowResultSchema, debtAbsentSchema]),
    normal: z.union([guidanceNormalSchema, debtShowNormalResultSchema]),
    effect: "read",
  },
  reconcile: {
    description:
      "Replay pending Git ref movements, Contract worktree appointments/retirements, and worktree hooks for one Contract or all Contracts in the repo.",
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
      'Birth a new Akuma instance from a named archetype (discover names with ls {"selector":"aku/"}), optionally submitting its opening prompt. Associating contract records Dispatch only—it neither sets workdir nor injects Contract terms into prompt.',
    input: z.union([
      spawnModeSchemas[0]
        .omit({ body: true })
        .extend({
          ...spawnFields,
          mode: spawnModeSchemas[0].shape.mode.describe(
            '"detach" (default) returns right after birth and prompt admission; "wait" awaits the opening turn\'s text answer (requires prompt).',
          ),
          timeoutMs: spawnModeSchemas[0].shape.timeoutMs.describe(
            'Observation deadline in integer milliseconds when mode is "wait" (never kills the Akuma on deadline). Disallowed in detach mode.',
          ),
          prompt: nonblank.describe(
            "Opening instruction text. Optional in detach mode (omit to birth idle); required in wait mode.",
          ),
        })
        .readonly(),
      spawnModeSchemas[1]
        .omit({ body: true })
        .extend({
          ...spawnFields,
          mode: spawnModeSchemas[1].shape.mode.describe(
            '"detach" (default) returns right after birth and prompt admission; "wait" awaits the opening turn\'s text answer (requires prompt).',
          ),
          prompt: nonblank
            .exactOptional()
            .describe("Opening instruction text. Optional in detach mode (omit to birth idle); required in wait mode."),
        })
        .readonly(),
    ]),
    output: spawnResultSchema,
    normal: spawnNormalResultSchema,
    progress: spawnProgressSchema,
    effect: "write",
  },
  fork: {
    description:
      "Branch a new Akuma instance from an existing Akuma's retained answered turn (turn/<n>, visible in history output). Requires provider fork support.",
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
      "Submit a text instruction to an existing Akuma, steering an open turn or waking a sleeping Akuma. Returns after admission unless wait: true observes that turn's text answer.",
    input: z.union([
      tellObservationSchemas[0]
        .extend({
          ...tellFields,
          wait: tellObservationSchemas[0].shape.wait.describe(
            "When true, wait for and return this exact turn's text answer; when false or omitted, return immediately after admission.",
          ),
          timeoutMs: tellObservationSchemas[0].shape.timeoutMs.describe(
            "Observation deadline in integer milliseconds (valid only with wait: true; deadline stops observation without retracting the Tell or killing the Akuma).",
          ),
        })
        .readonly(),
      tellObservationSchemas[1]
        .extend({
          ...tellFields,
          wait: tellObservationSchemas[1].shape.wait.describe(
            "When true, wait for and return this exact turn's text answer; when false or omitted, return immediately after admission.",
          ),
        })
        .readonly(),
    ]),
    output: akumaTellResultSchema,
    progress: askProgressSchema,
    effect: "write",
  },
  ask: {
    description:
      "Submit a prompt to an existing Akuma with a required JSON Schema output contract and await its parsed JSON answer. Keiyaku parses JSON but does not re-validate schema conformance on the client side.",
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
      "Stop current execution on one or more selected Akumas while preserving their history; a stopped Akuma can be woken later with tell or ask.",
    input: z
      .strictObject({
        akuma: z
          .array(text)
          .min(1)
          .readonly()
          .describe(
            'Nonempty list of Akuma selectors: aku/<name>/<hex>, @alias, kei/... (all Akumas dispatched to that Contract), or glob "aku/<name-pattern>/<hex-pattern>".',
          ),
      })
      .readonly(),
    output: akumaKillResultSchema,
    effect: "destroy",
  },
  wait: {
    description:
      "Wait for selected Contracts (all kei/...) to record a journal change or reach a terminal state, or for selected Akumas (aku/..., @alias, or aku globs) to settle. Cannot mix Contract and Akuma selectors in one call; reaching timeoutMs ends observation without killing Akumas.",
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
      "Read a Contract's causal journal history (kei/...) or an Akuma's execution timeline, latest answer, or exact turn/<n>, report/<n>, or decimal activity item.",
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
      "Record a mid-turn progress report from inside an executing Akuma (requires KEIYAKU_ACTOR_ID and KEIYAKU_ACTOR_WORLD in server environment). Does not end the current turn or replace the final answer.",
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
      "Inspect the server environment's own caller/Akuma identity, current turn initiator, Dispatch association, and contextual Contract at cwd without establishing a World.",
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
      "Read the composite World watchtower board across active Contracts, Debts, and Akumas. Selector-free; use status to inspect one Contract or Akuma.",
    input: z.strictObject({}).readonly(),
    output: kanshiReportSchema,
    effect: "read",
  },
  status: {
    description:
      "Inspect one Contract or Akuma by exact canonical identity (kei/... or aku/<name>/<hex>), returning current lifecycle, workspace/gate state, or current work frontier.",
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
      'List one catalogue by path selector: active Contracts ("kei/"), Debts ("debt/"), available Akuma archetypes ("aku/"), or retained Akuma instances ("aku/*", "aku/*/*", "aku/<name>", "aku/<name>/*").',
    input: lsInputSchema,
    output: z.union([contractCatalogueSchema, akumaCatalogueSchema, archetypeCatalogSchema, debtCatalogueSchema]),
    normal: z.union([contractCatalogueSchema, akumaCatalogueSchema, archetypeCatalogSchema, debtListSchema]),
    effect: "read",
  },
  region: {
    description:
      "Inspect declared ## Region write-path patterns across active Contracts, for one Contract, or overlapping specific repository-relative paths.",
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
      "Record a new Debt in the World's flat ledger with optional priority, initial state, and dependency/hierarchy edges.",
    input: addDebtInputSchema.readonly(),
    output: debtMutationResultSchema,
    normal: debtMutationNormalResultSchema,
    effect: "write",
  },
  "debt.addDocument": {
    description: "Create a Debt from Markdown.",
    input: z.strictObject({ markdown: text, ...actor }).readonly(),
    output: debtMutationResultSchema,
    effect: "write",
  },
  "debt.update": {
    description:
      "Atomically update a Debt's state (open, done, drop), text fields, priority, or relationship edges. Requires at least one effective change; body and appendBody are mutually exclusive.",
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
