import type { AuditReport } from "../protocol/audit.js";
import type { IntegrationConflictMaterialized } from "../protocol/deliver.js";
import { decodeAuditReport, decodeMaterializedConflict, decodeReviewValue } from "../protocol/result-codec.js";
import { decodeContinuationReport, type ContinuationReport } from "./continuation.js";
import { deliveryValueSchema, type DeliveryValue } from "./delivery.js";
import { mutationResultSchema, type MutationResult } from "./mutation.js";
import {
  KeiyakuRefused,
  KeiyakuRetry,
  decodeKeiyakuRefusal,
  keiyakuRefusalSchema,
  keiyakuRetryReasonSchema,
} from "./refusal.js";
import { ownerSchema } from "./result-codec.js";
import { z } from "zod";

export type Review = import("../protocol/review.js").ReviewValue & Readonly<{ continuation?: ContinuationReport }>;

export function decodeReview(value: unknown): Review {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed review");
  const { continuation, ...protocol } = value as Record<string, unknown>;
  const review = decodeReviewValue(protocol);
  return continuation === undefined ? review : { ...review, continuation: decodeContinuationReport(continuation) };
}

export const auditReportSchema = ownerSchema(
  decodeAuditReport,
  "expected audit report",
) satisfies z.ZodType<AuditReport>;
const reviewSchema = ownerSchema(decodeReview, "expected review") satisfies z.ZodType<Review>;
const materializedConflictSchema = ownerSchema(
  decodeMaterializedConflict,
  "expected materialized conflict",
) satisfies z.ZodType<IntegrationConflictMaterialized>;

export const deliveryResultSchema = z.union([
  mutationResultSchema(deliveryValueSchema),
  materializedConflictSchema,
]) satisfies z.ZodType<MutationResult<DeliveryValue> | IntegrationConflictMaterialized>;
export const reviewResultSchema = mutationResultSchema(reviewSchema) satisfies z.ZodType<MutationResult<Review>>;
export const auditResultSchema = mutationResultSchema(auditReportSchema) satisfies z.ZodType<
  MutationResult<AuditReport>
>;

const contractLiveFailureSchema = z.union([
  z.object({ kind: z.literal("refused"), refusal: keiyakuRefusalSchema }).strict(),
  z.object({ kind: z.literal("retry"), reason: keiyakuRetryReasonSchema }).strict(),
]);

export function encodeContractLiveFailure(error: unknown): unknown | null {
  if (error instanceof KeiyakuRefused) {
    return { kind: "refused", refusal: error.refusal };
  }
  if (error instanceof KeiyakuRetry) {
    return { kind: "retry", reason: error.reason };
  }
  return null;
}

export function decodeContractLiveFailure(value: unknown): Error | null {
  const parsed = contractLiveFailureSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.kind === "refused"
    ? new KeiyakuRefused(decodeKeiyakuRefusal(parsed.data.refusal))
    : new KeiyakuRetry(parsed.data.reason);
}
