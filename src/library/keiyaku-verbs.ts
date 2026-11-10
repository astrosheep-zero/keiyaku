/** @architectureCompositionRoot */
import { z } from "zod";
export { classifyVerb, type VerbCompletion, type VerbDisposition } from "./keiyaku-classify.js";
import { akumaCallerSchema } from "../akuma/caller.js";
import { askProgressSchema, type AskProgress } from "../akuma/akuma-selection-execution.js";
import { akumaReportResultSchema } from "../akuma/akuma-instance.js";
import { akumaListSchema } from "../akuma/akuma.js";
import { archetypeCatalogSchema } from "../akuma/archetype.js";
import {
  akumaAskResultSchema,
  akumaKillResultSchema,
  akumaTellResultSchema,
  akumaWaitResultSchema,
  type AkumaAskResult,
} from "../akuma/selection-observation.js";
import { regionResultSchema } from "../kanshi/report.js";
import { settingsSchema, type Settings } from "../settings.js";
import { contractCatalogueSchema } from "../protocol/read/status.js";
import { executionObservationSchema } from "../protocol/execution-observation.js";
import {
  spawnProgressSchema,
  spawnResultSchema,
  forkResultSchema,
  type SpawnProgress,
  type SpawnResult,
} from "./akuma-creation.js";
import {
  bindOutcomeSchema,
  amendOutcomeSchema,
  arcOutcomeSchema,
  deliverOutcomeSchema,
  deliveryPreviewOutcomeSchema,
  verifyOutcomeSchema,
  reviewOutcomeSchema,
  abandonOutcomeSchema,
  type BindOutcome,
} from "./contract-outcomes.js";
import { contractHistorySchema } from "./contract-types.js";
import { guidanceSchema } from "./kei.js";
import { contractWaitResultSchema } from "./contract-wait.js";
import { reconcileResultSchema } from "./reconcile.js";
import { akumaHistoryResultSchema } from "./selection.js";
import { statusResultSchema } from "./keiyaku-status.js";
import { whoamiFactsSchema } from "./keiyaku-identity.js";
import { resetOutcomeSchema } from "./outcome.js";
import {
  debtAbsentSchema,
  debtBatchResultSchema,
  debtTreeResultSchema,
  debtCatalogueSchema,
  debtShowResultSchema,
  debtDoctorReportSchema,
  debtReadyListSchema,
  blockedDebtListSchema,
  debtMutationResultSchema,
  debtQueryResultSchema,
  debtContextResultSchema,
  debtUpdateResultSchema,
  type DebtQueryExpression,
} from "../debt/index.js";
import { debtPrioritySchema, debtStateSchema } from "../debt/document.js";
import { debtIdSchema } from "../debt/identity.js";

export type VerbEntry = Readonly<{
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  progress?: z.ZodType;
  effect: "read" | "write" | "destroy";
}>;
export type VerbRun<E = never> = Readonly<{ signal?: AbortSignal; observe?: (event: E) => void | PromiseLike<void> }>;
export type AskRun<T = unknown> = VerbRun<AskProgress> & Readonly<{ decode?: (value: unknown) => T }>;
export type SpawnRun = VerbRun<SpawnProgress> & Readonly<{ decode?: (value: unknown) => unknown }>;

const text = z.string();
const nonblank = text.regex(/\S/u, "Must not be blank");
const optText = text.exactOptional();
const optBool = z.boolean().exactOptional();
const strings = z.array(text).readonly();
const positive = z.number().int().positive();
const timeout = z.number().finite().nonnegative().exactOptional();
const contract = { contract: optText };
const actor = { actor: optText };
const commonBind = {
  target: text.nullable().exactOptional(),
  workspace: z.literal("worktree").exactOptional(),
  ...actor,
};
type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValue).readonly(),
    z.record(z.string(), jsonValue).readonly(),
  ]),
);
const jsonDocument = z.record(z.string(), jsonValue).readonly();
const contractSelector = text.startsWith("kei/");
const akumaSelector = text.regex(/^(?!kei\/)/u);
const debtReadScope = {
  scope: z.enum(["namespace", "world"]).exactOptional(),
  namespace: strings.exactOptional(),
  limit: positive.exactOptional(),
};
const debtSelection = z.enum(["active", "closed", "all"]).exactOptional();
const debtRelations = {
  needs: strings.exactOptional(),
  parent: text.nullable().exactOptional(),
  supersedes: strings.exactOptional(),
  relates: strings.exactOptional(),
};
const debtPredicate = z.union([
  z.strictObject({ field: z.literal("state"), operator: z.enum(["=", "!="]), value: debtStateSchema }).readonly(),
  z
    .strictObject({
      field: z.literal("priority"),
      operator: z.enum(["=", "!=", "<", "<=", ">", ">="]),
      value: debtPrioritySchema,
    })
    .readonly(),
  z.strictObject({ field: z.enum(["title", "id"]), operator: z.enum(["=", "!=", "~"]), value: text }).readonly(),
  z
    .strictObject({ field: z.literal("parent"), operator: z.enum(["=", "!="]), value: debtIdSchema.nullable() })
    .readonly(),
  z
    .strictObject({ field: z.enum(["under", "needs", "blocks"]), operator: z.enum(["=", "!="]), value: debtIdSchema })
    .readonly(),
  z.strictObject({ field: z.enum(["ready", "blocked"]), operator: z.enum(["=", "!="]), value: z.boolean() }).readonly(),
  z
    .strictObject({
      field: z.enum(["created", "updated"]),
      operator: z.enum(["=", "!=", "<", "<=", ">", ">="]),
      value: text,
    })
    .readonly(),
]);
type DebtQueryWire =
  | Readonly<{ kind: "and" | "or"; terms: readonly DebtQueryWire[] }>
  | Readonly<{ kind: "not"; term: DebtQueryWire }>
  | Readonly<{ kind: "predicate"; predicate: z.input<typeof debtPredicate> }>;
const debtQueryExpression: z.ZodType<DebtQueryExpression, DebtQueryWire> = z.lazy(() =>
  z.union([
    z.strictObject({ kind: z.enum(["and", "or"]), terms: z.array(debtQueryExpression).readonly() }).readonly(),
    z.strictObject({ kind: z.literal("not"), term: debtQueryExpression }).readonly(),
    z.strictObject({ kind: z.literal("predicate"), predicate: debtPredicate }).readonly(),
  ]),
);

export const verbs = Object.freeze({
  bind: {
    description: "Bind Contract terms or fork existing terms.",
    input: z.union([
      z
        .strictObject({
          markdown: text,
          debt: optText,
          ...commonBind,
          after: strings.exactOptional(),
          gates: strings.exactOptional(),
        })
        .readonly(),
      z.strictObject({ forkOf: text, ...commonBind }).readonly(),
    ]),
    output: bindOutcomeSchema,
    effect: "write",
  },
  amend: {
    description: "Amend Contract terms.",
    input: z
      .strictObject({
        ...contract,
        markdown: optText,
        after: strings.exactOptional(),
        gates: strings.exactOptional(),
        ...actor,
      })
      .readonly(),
    output: amendOutcomeSchema,
    effect: "write",
  },
  arc: {
    description: "Add a Contract arc.",
    input: z.strictObject({ ...contract, markdown: text, ...actor }).readonly(),
    output: arcOutcomeSchema,
    effect: "write",
  },
  deliver: {
    description: "Deliver a Contract candidate.",
    input: z
      .strictObject({
        ...contract,
        message: optText,
        includeDirty: optBool,
        materializeConflict: optBool,
        overwrite: optBool,
      })
      .readonly(),
    output: deliverOutcomeSchema,
    progress: executionObservationSchema,
    effect: "write",
  },
  "deliver.preview": {
    description: "Observe a prospective delivery.",
    input: z.strictObject({ ...contract, includeDirty: optBool, showDiff: optBool }).readonly(),
    output: deliveryPreviewOutcomeSchema,
    progress: executionObservationSchema,
    effect: "read",
  },
  verify: {
    description: "Run declared verification.",
    input: z.strictObject({ ...contract, index: positive.exactOptional(), includeDirty: optBool }).readonly(),
    output: verifyOutcomeSchema,
    progress: executionObservationSchema,
    effect: "write",
  },
  review: {
    description: "Record Contract review.",
    input: z
      .strictObject({ ...contract, verdict: z.enum(["satisfied", "unsatisfied"]), summary: nonblank, ...actor })
      .readonly(),
    output: reviewOutcomeSchema,
    progress: executionObservationSchema,
    effect: "write",
  },
  abandon: {
    description: "Abandon a Contract.",
    input: z.strictObject({ ...contract, note: optText, ...actor }).readonly(),
    output: abandonOutcomeSchema,
    effect: "destroy",
  },
  show: {
    description: "Read Contract guidance.",
    input: z.strictObject(contract).readonly(),
    output: guidanceSchema,
    effect: "read",
  },
  reconcile: {
    description: "Reconcile Contract effects.",
    input: z.strictObject({ ...contract, retryHooks: optBool }).readonly(),
    output: reconcileResultSchema,
    effect: "write",
  },
  spawn: {
    description: "Spawn an Akuma.",
    input: z
      .strictObject({
        akumaName: text,
        prompt: optText,
        ...contract,
        workdir: optText,
        alias: optText,
        mode: z.enum(["wait", "detach"]).exactOptional(),
        timeoutMs: timeout,
        writableDirectories: strings.exactOptional(),
        bare: optBool,
        schema: jsonDocument.exactOptional(),
      })
      .readonly(),
    output: spawnResultSchema,
    progress: spawnProgressSchema,
    effect: "write",
  },
  fork: {
    description: "Fork an Akuma at a history point.",
    input: z.strictObject({ akuma: text, at: text, bare: optBool }).readonly(),
    output: forkResultSchema,
    effect: "write",
  },
  tell: {
    description: "Send an Akuma a prompt.",
    input: z.strictObject({ akuma: text, prompt: text, interrupt: optBool }).readonly(),
    output: akumaTellResultSchema,
    effect: "write",
  },
  ask: {
    description: "Ask an Akuma and observe its answer.",
    input: z
      .strictObject({
        akuma: text,
        prompt: text,
        timeoutMs: timeout,
        schema: jsonDocument.exactOptional(),
        interrupt: optBool,
      })
      .readonly(),
    output: akumaAskResultSchema,
    progress: askProgressSchema,
    effect: "write",
  },
  kill: {
    description: "Kill selected Akumas.",
    input: z.strictObject({ akuma: z.array(text).min(1).readonly() }).readonly(),
    output: akumaKillResultSchema,
    effect: "destroy",
  },
  wait: {
    description: "Wait for selected Contracts or Akumas.",
    input: z.union([
      z
        .strictObject({
          selectors: z.array(contractSelector).min(1).readonly(),
          completion: z.enum(["any", "all"]).exactOptional(),
          timeoutMs: timeout,
        })
        .readonly(),
      z
        .strictObject({
          selectors: z.array(akumaSelector).min(1).readonly(),
          completion: z.enum(["any", "all"]).exactOptional(),
          timeoutMs: timeout,
        })
        .readonly(),
    ]),
    output: z.union([contractWaitResultSchema, akumaWaitResultSchema]),
    effect: "read",
  },
  history: {
    description: "Read Contract or Akuma history.",
    input: z.union([
      z.strictObject({ selector: contractSelector, full: optBool }).readonly(),
      z
        .strictObject({
          selector: akumaSelector,
          id: optText,
          before: positive.exactOptional(),
          since: positive.exactOptional(),
          limit: positive.exactOptional(),
          last: optBool,
        })
        .readonly(),
    ]),
    output: z.union([contractHistorySchema, akumaHistoryResultSchema]),
    effect: "read",
  },
  report: {
    description: "Record a report for the current execution.",
    input: z.strictObject({ text: nonblank }).readonly(),
    output: akumaReportResultSchema,
    effect: "write",
  },
  whoami: {
    description: "Observe the invocation's identity and context.",
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
  status: {
    description: "Observe the World or selected subjects.",
    input: z.union([
      z.strictObject({}).readonly(),
      z.strictObject({ selector: text }).readonly(),
      z.strictObject({ selectors: z.array(text).min(2).readonly() }).readonly(),
      z.strictObject({ category: z.enum(["akuma", "contract"]), limit: positive.exactOptional() }).readonly(),
    ]),
    output: statusResultSchema,
    effect: "read",
  },
  region: {
    description: "Observe Region declarations or overlaps.",
    input: z.union([
      z.strictObject({}).readonly(),
      z.strictObject({ contract: text }).readonly(),
      z.strictObject({ paths: z.array(text).min(1).readonly() }).readonly(),
    ]),
    output: regionResultSchema,
    effect: "read",
  },
  "debt.add": {
    description: "Create a Debt.",
    input: z
      .strictObject({
        title: text,
        namespace: strings.exactOptional(),
        body: optText,
        note: optText,
        state: debtStateSchema.exactOptional(),
        priority: debtPrioritySchema.exactOptional(),
        ...debtRelations,
        ...actor,
      })
      .readonly(),
    output: debtMutationResultSchema,
    effect: "write",
  },
  "debt.addDocument": {
    description: "Create a Debt from Markdown.",
    input: z.strictObject({ markdown: text, namespace: strings.exactOptional(), ...actor }).readonly(),
    output: debtMutationResultSchema,
    effect: "write",
  },
  "debt.update": {
    description: "Update a Debt.",
    input: z
      .strictObject({
        id: text,
        title: optText,
        body: optText,
        appendBody: optText,
        note: optText,
        priority: debtPrioritySchema.exactOptional(),
        ...debtRelations,
        addNeeds: strings.exactOptional(),
        dropNeeds: strings.exactOptional(),
        addSupersedes: strings.exactOptional(),
        dropSupersedes: strings.exactOptional(),
        addRelates: strings.exactOptional(),
        dropRelates: strings.exactOptional(),
      })
      .readonly(),
    output: debtUpdateResultSchema,
    effect: "write",
  },
  "debt.show": {
    description: "Read one or more Debts.",
    input: z.union([
      z.strictObject({ id: text }).readonly(),
      z.strictObject({ ids: z.array(text).min(1).readonly() }).readonly(),
    ]),
    output: z.union([debtShowResultSchema, debtAbsentSchema]),
    effect: "read",
  },
  "debt.done": {
    description: "Complete Debts in caller order.",
    input: z.strictObject({ ids: z.array(text).min(1).readonly(), note: optText }).readonly(),
    output: debtBatchResultSchema,
    effect: "write",
  },
  "debt.drop": {
    description: "Drop Debts in caller order.",
    input: z.strictObject({ ids: z.array(text).min(1).readonly(), note: optText }).readonly(),
    output: debtBatchResultSchema,
    effect: "write",
  },
  "debt.ready": {
    description: "List ready Debts.",
    input: z.strictObject({ ...debtReadScope, parent: optText }).readonly(),
    output: debtReadyListSchema,
    effect: "read",
  },
  "debt.blocked": {
    description: "List blocked Debts.",
    input: z.strictObject({ ...debtReadScope, parent: optText }).readonly(),
    output: blockedDebtListSchema,
    effect: "read",
  },
  "debt.query": {
    description: "Query Debts using the owner expression.",
    input: z
      .strictObject({
        ...debtReadScope,
        selection: debtSelection,
        where: debtQueryExpression.exactOptional(),
        sort: z.enum(["priority", "created", "updated", "id"]).exactOptional(),
      })
      .readonly(),
    output: debtQueryResultSchema,
    effect: "read",
  },
  "debt.tree": {
    description: "Observe a Debt decomposition tree.",
    input: z.strictObject({ id: text }).readonly(),
    output: z.union([debtTreeResultSchema, debtAbsentSchema]),
    effect: "read",
  },
  "debt.doctor": {
    description: "Diagnose Debt authority and relations.",
    input: z.strictObject({}).readonly(),
    output: z.union([debtDoctorReportSchema, debtAbsentSchema]),
    effect: "read",
  },
  "debt.context": {
    description: "Observe or set the Debt namespace context.",
    input: z.strictObject({ namespace: strings.exactOptional() }).readonly(),
    output: debtContextResultSchema,
    effect: "write",
  },
  ls: {
    description: "List Contracts, Akumas, archetypes, or Debts.",
    input: z.union([
      z.strictObject({ of: z.literal("kei"), limit: positive.exactOptional() }).readonly(),
      z
        .strictObject({
          of: z.literal("aku"),
          limit: positive.exactOptional(),
          akumaName: optText,
          caller: z
            .union([
              z.strictObject({ kind: z.literal("mine") }).readonly(),
              z.strictObject({ kind: z.literal("external"), caller: akumaCallerSchema }).readonly(),
              z.strictObject({ kind: z.literal("akuma"), akumaId: text }).readonly(),
            ])
            .exactOptional(),
        })
        .readonly(),
      z.strictObject({ of: z.literal("akuma-name"), limit: positive.exactOptional() }).readonly(),
      z.strictObject({ of: z.literal("debt"), ...debtReadScope, selection: debtSelection }).readonly(),
    ]),
    output: z.union([contractCatalogueSchema, akumaListSchema, archetypeCatalogSchema, debtCatalogueSchema]),
    effect: "read",
  },
} as const satisfies Record<string, VerbEntry>);

export type VerbOutputs = Omit<
  { [K in keyof typeof verbs]: z.output<(typeof verbs)[K]["output"]> },
  "bind" | "settings" | "ask" | "spawn"
> & {
  bind: BindOutcome;
  settings: Settings;
  ask: AkumaAskResult<unknown>;
  spawn: SpawnResult;
};
export type VerbName = keyof typeof verbs;
export type VerbInput<K extends VerbName> = z.input<(typeof verbs)[K]["input"]>;
export type VerbOutput<K extends VerbName> = VerbOutputs[K];
export type VerbProgress<K extends VerbName> = (typeof verbs)[K] extends { readonly progress: z.ZodType<infer E> }
  ? E
  : never;
export type VerbRunFor<K extends VerbName> = K extends "ask"
  ? AskRun<unknown>
  : K extends "spawn"
    ? SpawnRun
    : VerbRun<VerbProgress<K>>;
