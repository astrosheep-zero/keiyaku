/** @architectureCompositionRoot */
import { z } from "zod";
export { classifyVerb, type VerbCompletion, type VerbDisposition } from "./keiyaku-classify.js";
import { akumaCallerSchema } from "../akuma/caller.js";
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
const contract = { contract: optText };
const actor = { actor: optText };
const commonBind = {
  target: text.nullable().exactOptional(),
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
const debtSelection = z.enum(["active", "closed", "all"]).exactOptional();
const lsCallerSchema = z.union([
  z.strictObject({ kind: z.literal("mine") }).readonly(),
  z.strictObject({ kind: z.literal("external"), caller: akumaCallerSchema }).readonly(),
  z.strictObject({ kind: z.literal("akuma"), akumaId: akumaIdSchema }).readonly(),
]);
const listBound = { limit: positive.exactOptional() };
const lsInputSchema = z.union([
  z.strictObject({ selector: text.regex(/^kei\/?$/u), ...listBound }).readonly(),
  z.strictObject({ selector: text.regex(/^debt\/?$/u), selection: debtSelection, ...listBound }).readonly(),
  z.strictObject({ selector: text.regex(/^aku\/?$/u), ...listBound }).readonly(),
  z
    .strictObject({
      selector: text.regex(/^aku\/(?:\*(?:\/\*)?|[^/*]+(?:\/\*|\/)?)$/u),
      caller: lsCallerSchema.exactOptional(),
      ...listBound,
    })
    .readonly(),
]);
const spawnFields = {
  akumaName: nonblank,
  ...contract,
  workdir: optText,
  alias: optText,
  writableDirectories: strings.exactOptional(),
  bare: optBool,
};
const tellFields = { akuma: text, prompt: nonblank, interrupt: optBool };
export const verbs = Object.freeze({
  bind: {
    description: "Bind Contract terms or fork existing terms.",
    input: z.union([
      z
        .strictObject({
          markdown: text,
          debt: debtIdSchema.exactOptional(),
          ...commonBind,
          after: strings.exactOptional(),
          gates: strings.exactOptional(),
        })
        .readonly(),
      z.strictObject({ forkOf: text, ...commonBind }).readonly(),
    ]),
    output: bindOutcomeSchema,
    normal: bindNormalOutcomeSchema,
    effect: "write",
  },
  amend: {
    description: "Amend Contract terms.",
    input: z.union(amendInputSchemas.map((branch) => branch.extend(contract).readonly())),
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
    description: "Deliver a Contract candidate or preview it without mutation.",
    input: z.union([
      z.strictObject({ ...contract, dryRun: z.literal(true), includeDirty: optBool, showDiff: optBool }).readonly(),
      z
        .strictObject({
          ...contract,
          dryRun: z.literal(false).exactOptional(),
          message: optText,
          includeDirty: optBool,
          materializeConflict: optBool,
          overwrite: optBool,
        })
        .readonly(),
    ]),
    output: z.union([deliverOutcomeSchema, deliveryPreviewOutcomeSchema]),
    progress: executionObservationSchema,
    effect: "write",
  },
  verify: {
    description: "Run declared verification.",
    input: z.strictObject({ ...contract, index: positive.exactOptional(), includeDirty: optBool }).readonly(),
    output: verifyOutcomeSchema,
    normal: verifyNormalOutcomeSchema,
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
    description: "Read contextual Contract guidance or addressed Contract/Debt detail.",
    input: z.union([
      z
        .strictObject({ id: z.union([contractIdSchema, debtIdSchema, text.regex(/^@[^*?\[\]]+$/u)]).exactOptional() })
        .readonly(),
      z.strictObject({ ids: z.array(debtIdSchema).nonempty().readonly() }).readonly(),
    ]),
    output: z.union([guidanceSchema, debtShowResultSchema, debtAbsentSchema]),
    normal: z.union([guidanceNormalSchema, debtShowNormalResultSchema]),
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
    input: z.union([
      spawnModeSchemas[0]
        .omit({ body: true })
        .extend({ ...spawnFields, prompt: nonblank })
        .readonly(),
      spawnModeSchemas[1]
        .omit({ body: true })
        .extend({ ...spawnFields, prompt: nonblank.exactOptional() })
        .readonly(),
    ]),
    output: spawnResultSchema,
    normal: spawnNormalResultSchema,
    progress: spawnProgressSchema,
    effect: "write",
  },
  fork: {
    description: "Fork an Akuma at a history point.",
    input: z.strictObject({ akuma: text, at: text, bare: optBool }).readonly(),
    output: forkResultSchema,
    normal: forkNormalResultSchema,
    effect: "write",
  },
  tell: {
    description: "Send an Akuma a prompt.",
    input: z.union(tellObservationSchemas.map((branch) => branch.extend(tellFields).readonly())),
    output: akumaTellResultSchema,
    progress: askProgressSchema,
    effect: "write",
  },
  ask: {
    description: "Ask an Akuma and observe its answer.",
    input: z
      .strictObject({
        akuma: text,
        prompt: nonblank,
        timeoutMs: timeout,
        schema: jsonDocument,
        interrupt: optBool,
      })
      .readonly(),
    output: akumaAskResultSchema,
    normal: akumaAskNormalResultSchema,
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
          timeoutMs: contractWaitDurationSchema.exactOptional(),
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
    normal: z.union([contractWaitNormalResultSchema, akumaWaitNormalResultSchema]),
    effect: "read",
  },
  history: {
    description: "Read Contract or Akuma history.",
    input: z.union([
      z.strictObject({ selector: contractSelector, full: optBool }).readonly(),
      ...historySelectionSchemas.map((branch) => branch.extend({ selector: akumaSelector }).readonly()),
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
  kanshi: {
    description: "Observe the World board.",
    input: z.strictObject({}).readonly(),
    output: kanshiReportSchema,
    effect: "read",
  },
  status: {
    description: "Observe one Contract or Akuma by complete identity.",
    input: z.strictObject({ id: z.union([contractIdSchema, akumaIdSchema]) }).readonly(),
    output: z.union([contractStatusSchema, akumaObservationSchema]),
    normal: z.union([contractNormalStatusSchema, akumaObservationSchema]),
    effect: "read",
  },
  ls: {
    description: "List Contracts, Debts, Akuma instances or Archetypes by selector.",
    input: lsInputSchema,
    output: z.union([contractCatalogueSchema, akumaCatalogueSchema, archetypeCatalogSchema, debtCatalogueSchema]),
    normal: z.union([contractCatalogueSchema, akumaCatalogueSchema, archetypeCatalogSchema, debtListSchema]),
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
    description: "Update a Debt.",
    input: z.union(updateDebtInputSchemas.map((branch) => branch.safeExtend({ id: debtIdSchema }).readonly())),
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
