import { z } from "zod";
import { akumaListRowSchema, unbornAkumaListRowSchema, akumaListSchema } from "../akuma/akuma.js";
import { activitySnapshotSchema } from "../akuma/projection.js";
import { boundedListSchema } from "../bounded-list.js";
import { debtRefSchema, debtResultRowSchema } from "../debt/board.js";
import { debtIdSchema } from "../debt/identity.js";
import { akumaAliasSchema } from "../identity/selector.js";
import { contractRowSchema, contractBoardSchema } from "../protocol/read/status.js";
import { currentPhysicalIssueSchema } from "../protocol/read/observation.js";
import { worldRootSchema } from "../world.js";
import { contractIdSchema } from "../git/identity.js";
import { regionOverlapResultSchema } from "../region.js";
import type { AkumaList, AkumaListRow, UnbornAkumaListRow } from "../akuma/akuma.js";
import type { ActivitySnapshot } from "../akuma/projection.js";
import type { AkumaAlias } from "../identity/selector.js";
import type { ContractId } from "../index.js";
import type { RegionOverlap } from "../region.js";
import type { CurrentPhysicalIssue } from "../protocol/read/observation.js";
import type { ContractDisposition } from "../protocol/read/status.js";
import type { WorldRoot } from "../world.js";

export type { RegionOverlap };

export type Section<Value> = z.output<ReturnType<typeof sectionSchema<z.ZodType<Value>>>>;

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

export type ContractEndpointObservation = ContractDisposition | "missing" | "unavailable";

export type ContractHolderObservation = z.output<typeof holderSchema>;
export type ContractRosterAttachment = z.output<typeof rosterSchema>;

export type ContractKanshiRow = z.output<typeof contractRow>;
export type ContractKanshiBoard = z.output<typeof contractBoard>;
export type DebtKanshiRow = z.output<typeof debtRow>;
export type DebtKanshiWorld = z.output<typeof debtWorld>;

export type AkumaKanshiRow = (AkumaListRow | UnbornAkumaListRow) &
  Readonly<{
    aliases: readonly AkumaAlias[];
    contract?: Readonly<{ id: string; observed: ContractEndpointObservation }>;
    contractAssociationUnavailable?: true;
    snapshot?: ActivitySnapshot;
  }>;

export type AkumaKanshiWorld = Omit<AkumaList, "rows"> &
  Readonly<{
    rows: readonly AkumaKanshiRow[];
    aliasesUnavailable?: true;
  }>;

export type KanshiRegionSelection =
  | Readonly<{ kind: "declarations" }>
  | Readonly<{ kind: "contract"; contract: ContractId }>
  | Readonly<{ kind: "path"; patterns: readonly [string, ...string[]] }>;

export type RegionDeclaration = z.output<typeof regionDeclarationSchema>;
export type RegionRead =
  | Readonly<{ kind: "declarations"; declarations: readonly RegionDeclaration[] }>
  | Readonly<{
      kind: "contract";
      declaration: RegionDeclaration;
      overlaps: readonly RegionOverlap[];
    }>
  | Readonly<{
      kind: "path";
      patterns: readonly string[];
      overlaps: readonly RegionOverlap[];
    }>;

export const regionDeclarationSchema = z
  .strictObject({ contract: contractIdSchema, patterns: z.array(z.string()).readonly() })
  .readonly();
export const regionReadSchema = z.union([
  z
    .strictObject({ kind: z.literal("declarations"), declarations: z.array(regionDeclarationSchema).readonly() })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("contract"),
      declaration: regionDeclarationSchema,
      overlaps: z.array(regionOverlapResultSchema).readonly(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("path"),
      patterns: z.array(z.string()).readonly(),
      overlaps: z.array(regionOverlapResultSchema).readonly(),
    })
    .readonly(),
]);

const endpointSchema = z.enum(["active", "terminal", "missing", "unavailable"]);
const associationSchema = z.strictObject({ id: z.string(), observed: endpointSchema }).readonly();
const holderSchema = z.union([
  z.strictObject({ kind: z.literal("held"), debtId: debtIdSchema }).readonly(),
  z.strictObject({ kind: z.literal("none") }).readonly(),
  z.strictObject({ kind: z.literal("unavailable") }).readonly(),
]);
const rosterSchema = z
  .strictObject({
    id: z.string(),
    aliases: z.array(akumaAliasSchema).readonly(),
    aliasesUnavailable: z.literal(true).exactOptional(),
  })
  .readonly();
const contractRow = contractRowSchema
  .unwrap()
  .extend({
    holder: holderSchema,
    roster: z.array(rosterSchema).readonly(),
    rosterUnavailable: z.literal(true).exactOptional(),
    namespaceDebts: sectionSchema(z.array(debtResultRowSchema).readonly()).exactOptional(),
    issue: currentPhysicalIssueSchema.exactOptional(),
  })
  .readonly();
const contractBoard = contractBoardSchema
  .unwrap()
  .extend({ rows: z.array(contractRow).readonly(), hasMore: z.boolean().exactOptional() })
  .readonly();
const debtRow = debtResultRowSchema
  .unwrap()
  .extend({
    contract: associationSchema.exactOptional(),
    contractAssociationUnavailable: z.literal(true).exactOptional(),
    blockers: z.array(debtRefSchema).readonly().exactOptional(),
  })
  .readonly();
const debtWorld = boundedListSchema(debtRow, { root: worldRootSchema });
const akumaExtras = {
  contract: associationSchema.exactOptional(),
  contractAssociationUnavailable: z.literal(true).exactOptional(),
  snapshot: activitySnapshotSchema.exactOptional(),
};
const akumaRow = z.union([
  akumaListRowSchema.unwrap().extend(akumaExtras).readonly(),
  unbornAkumaListRowSchema.unwrap().extend(akumaExtras).readonly(),
]);
const akumaWorld = akumaListSchema
  .unwrap()
  .extend({ rows: z.array(akumaRow).readonly(), aliasesUnavailable: z.literal(true).exactOptional() })
  .readonly();
export const kanshiReportSchema = z
  .strictObject({
    root: worldRootSchema.nullable(),
    observedAt: z.string(),
    branch: z.string().nullable(),
    contracts: sectionSchema(contractBoard),
    debts: sectionSchema(debtWorld),
    akuma: sectionSchema(akumaWorld),
    region: sectionSchema(regionReadSchema).exactOptional(),
  })
  .readonly();
export const kanshiCategoryReportSchema = z.union([
  z
    .strictObject({
      category: z.literal("akuma"),
      root: worldRootSchema.nullable(),
      observedAt: z.string(),
      akuma: sectionSchema(akumaWorld),
    })
    .readonly(),
  z
    .strictObject({
      category: z.literal("contract"),
      root: worldRootSchema.nullable(),
      observedAt: z.string(),
      contracts: sectionSchema(contractBoard),
    })
    .readonly(),
]);

export type KanshiReport = Readonly<{
  root: WorldRoot | null;
  observedAt: string;
  branch: string | null;
  contracts: Section<ContractKanshiBoard>;
  debts: Section<DebtKanshiWorld>;
  akuma: Section<AkumaKanshiWorld>;
  region?: Section<RegionRead>;
}>;

/** Internal category observation retains only the requested owner section. */
export type KanshiCategoryReport =
  | Readonly<{
      category: "akuma";
      root: WorldRoot | null;
      observedAt: string;
      akuma: Section<AkumaKanshiWorld>;
    }>
  | Readonly<{
      category: "contract";
      root: WorldRoot | null;
      observedAt: string;
      contracts: Section<ContractKanshiBoard>;
    }>;
export type { CurrentPhysicalIssue };
