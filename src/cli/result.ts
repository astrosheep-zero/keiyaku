import type { AuditReport, ChangeId, ContractId, Fact, SnapshotId } from "../index.js";

export type Effect = Readonly<{
  kind: "worktree" | "ref";
  path?: string;
  name?: string;
  action: "created" | "updated" | "removed" | "unchanged";
  before?: string | null;
  after?: string | null;
}>;

export type AcceptedFact = Readonly<{
  contract: ContractId;
  entry: string;
  kind: Fact["kind"];
}>;

export type Lag = Readonly<{
  kind: "reconcile";
  contract: ContractId;
  error: string;
}>;

export type DiffUnavailable = Readonly<{
  reason: "transport-unavailable";
  snapshotId: SnapshotId;
  changeId: ChangeId;
}>;

export type AcceptedResult = Readonly<{
  kind: "accepted";
  verb: string;
  contract: ContractId;
  head: string | null;
  facts: readonly AcceptedFact[];
  effects: readonly Effect[];
  report?: AuditReport;
  diff?: string | DiffUnavailable;
  lag?: readonly Lag[];
}>;

export type RefusedResult = Readonly<{
  kind: "refused";
  verb: string;
  contract: ContractId;
  refusal: unknown;
}>;

export type RetryResult = Readonly<{
  kind: "retry";
  verb: string;
  contract: ContractId;
  detail: unknown;
}>;

export type ObservationResult = Readonly<{
  kind: "observation";
  command: string;
  [key: string]: unknown;
}>;

export type InvocationResult = AcceptedResult | RefusedResult | RetryResult | ObservationResult;
