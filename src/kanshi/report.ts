import { z } from "zod";
import { currentWorkSchema } from "../akuma/status-projection.js";
import { akumaCatalogueSchema, akumaCatalogueRowSchema } from "../akuma/selection-observation.js";
import { debtSummarySchema } from "../debt/index.js";
import { debtIdSchema } from "../debt/identity.js";
import { akumaAliasSchema } from "../identity/selector.js";
import {
  contractDetailSchema,
  contractSummarySchema,
  contractSummaryAssociationSchema,
} from "../protocol/read/status.js";
import { contractIdSchema } from "../git/identity.js";
import type { ContractId } from "../core/facts/types.js";
export type { CurrentPhysicalIssue } from "../protocol/read/observation.js";

/** Internal independent authority observations, before board composition. */
export function sectionSchema<S extends z.ZodType>(value: S) {
  return z.union([
    z.strictObject({ kind: z.literal("present"), value }).readonly(),
    z.strictObject({ kind: z.literal("absent") }).readonly(),
    z
      .strictObject({
        kind: z.literal("failed"),
        failure: z.strictObject({ message: z.string(), coordinate: z.string().exactOptional() }).readonly(),
      })
      .readonly(),
  ]);
}
export type Section<Value> = z.output<ReturnType<typeof sectionSchema<z.ZodType<Value>>>>;
export type ContractEndpointObservation = "active" | "terminal" | "missing" | "unavailable";
const failure = z.strictObject({ kind: z.literal("failed"), diagnostic: z.string() }).readonly();
const debtFailure = failure.unwrap().extend({ coordinate: z.string().exactOptional() }).readonly();
const absent = z.strictObject({ kind: z.literal("absent") }).readonly();
function present<S extends z.ZodRawShape>(value: z.ZodReadonly<z.ZodObject<S>>) {
  return value
    .unwrap()
    .extend({ kind: z.literal("present") })
    .readonly();
}
function boardSection<S extends z.ZodRawShape>(value: z.ZodReadonly<z.ZodObject<S>>) {
  return z.union([present(value), absent, failure]);
}
function debtSection<S extends z.ZodRawShape>(value: z.ZodReadonly<z.ZodObject<S>>) {
  return z.union([present(value), absent, debtFailure]);
}
export type BoardSection<Value> =
  | (Readonly<{ kind: "present" }> & Value)
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;
export type DebtSection<Value> =
  | BoardSection<Value>
  | Readonly<{ kind: "failed"; diagnostic: string; coordinate?: string }>;
const associationSchema = z.union([
  z.strictObject({ kind: z.literal("associated"), contractId: contractIdSchema }).readonly(),
  z.strictObject({ kind: z.literal("unavailable") }).readonly(),
]);
const holderSchema = z.union([debtIdSchema, z.strictObject({ kind: z.literal("unavailable") }).readonly()]);
const attachmentSchema = z
  .strictObject({
    id: z.string(),
    aliases: z.array(akumaAliasSchema).min(1).readonly().exactOptional(),
    aliasesUnavailable: z.literal(true).exactOptional(),
  })
  .readonly();
const contractDetail = contractDetailSchema
  .unwrap()
  .extend({
    kind: z.literal("contract"),
    holder: holderSchema.exactOptional(),
    roster: z
      .union([
        z.array(attachmentSchema).min(1).readonly(),
        z.strictObject({ kind: z.literal("unavailable") }).readonly(),
      ])
      .exactOptional(),
  })
  .readonly();
export const contractStatusSchema = z.union([
  contractDetail,
  z.strictObject({ kind: z.literal("contract-missing"), id: contractIdSchema }).readonly(),
  z.strictObject({ kind: z.literal("contract-failed"), id: contractIdSchema, diagnostic: z.string() }).readonly(),
]);
// Standalone Kanshi can be constructed without a Repo; the invocation Contract read requires one.
export const kanshiContractReportSchema = z.union([
  ...contractStatusSchema.options,
  z.strictObject({ kind: z.literal("contract-absent"), id: contractIdSchema }).readonly(),
]);
const catalogue = <S extends z.ZodType>(row: S) =>
  z
    .strictObject({
      rows: z.array(row).min(1).readonly().exactOptional(),
      more: z.literal(true).exactOptional(),
    })
    .readonly();
const boardRow = contractSummarySchema
  .unwrap()
  .extend({ associations: z.array(contractSummaryAssociationSchema).min(1).readonly().exactOptional() })
  .readonly();
export const contractKanshiBoardSchema = catalogue(boardRow);
const debtRow = debtSummarySchema
  .unwrap()
  .extend({ disposition: z.enum(["ready", "blocked"]), contract: associationSchema.exactOptional() })
  .readonly();
const debtWorld = catalogue(debtRow);
const akumaWorldRow = akumaCatalogueRowSchema
  .unwrap()
  .extend({
    work: z
      .union([currentWorkSchema, z.strictObject({ kind: z.literal("unavailable"), diagnostic: z.string() }).readonly()])
      .exactOptional(),
  })
  .readonly();
const akumaWorld = akumaCatalogueSchema
  .unwrap()
  .omit({ kind: true, observedAt: true, rows: true })
  .extend({
    rows: z.array(akumaWorldRow).nonempty().readonly().exactOptional(),
  })
  .readonly();
export const kanshiReportSchema = z
  .strictObject({
    kind: z.literal("world"),
    observedAt: z.string(),
    contracts: boardSection(contractKanshiBoardSchema),
    debts: debtSection(debtWorld),
    akumas: boardSection(akumaWorld),
  })
  .readonly();
export type ContractHolderObservation = z.output<typeof holderSchema>;
export type ContractRosterAttachment = z.output<typeof attachmentSchema>;
export type ContractKanshiDetail = z.output<typeof contractDetail>;
export type ContractKanshiBoard = z.output<typeof contractKanshiBoardSchema>;
export type DebtKanshiRow = z.output<typeof debtRow>;
export type DebtKanshiWorld = z.output<typeof debtWorld>;
export type AkumaKanshiRow = z.output<typeof akumaWorldRow>;
export type AkumaKanshiWorld = z.output<typeof akumaWorld>;
export type KanshiReport = z.output<typeof kanshiReportSchema>;
export type KanshiContractReport = z.output<typeof kanshiContractReportSchema>;
export type ContractStatus = z.output<typeof contractStatusSchema>;

export type KanshiRegionSelection =
  | Readonly<{ kind: "declarations" }>
  | Readonly<{ kind: "contract"; contract: ContractId }>
  | Readonly<{ kind: "path"; patterns: readonly [string, ...string[]] }>;
export const regionDeclarationSchema = z
  .strictObject({ id: contractIdSchema, patterns: z.array(z.string()).readonly() })
  .readonly();
const overlapSchema = z
  .strictObject({
    contractId: contractIdSchema,
    patterns: z
      .array(
        z
          .strictObject({
            mine: z.string(),
            theirs: z.string(),
            relation: z.enum(["mine-within-theirs", "theirs-within-mine", "intersect"]).exactOptional(),
          })
          .readonly(),
      )
      .readonly(),
  })
  .readonly();
export type RegionOverlap = z.output<typeof overlapSchema>;
export const regionResultSchema = z.union([
  z
    .strictObject({
      kind: z.literal("present"),
      declarations: z.array(regionDeclarationSchema).min(1).readonly().exactOptional(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("present"),
      id: contractIdSchema,
      patterns: z.array(z.string()).readonly(),
      overlaps: z.array(overlapSchema).min(1).readonly().exactOptional(),
    })
    .readonly(),
  z
    .strictObject({ kind: z.literal("present"), overlaps: z.array(overlapSchema).min(1).readonly().exactOptional() })
    .readonly(),
  failure,
  z.strictObject({ kind: z.literal("contract-missing"), id: contractIdSchema }).readonly(),
  z.strictObject({ kind: z.literal("contract-terminal"), id: contractIdSchema }).readonly(),
]);
export const regionReadSchema = z.union([...regionResultSchema.options, absent]);
export type RegionDeclaration = z.output<typeof regionDeclarationSchema>;
export type RegionResult = z.output<typeof regionResultSchema>;
export type RegionRead = z.output<typeof regionReadSchema>;
export const kanshiResultSchema = z.union([kanshiReportSchema, kanshiContractReportSchema, regionReadSchema]);
export type KanshiResult = KanshiReport | KanshiContractReport | RegionRead;
