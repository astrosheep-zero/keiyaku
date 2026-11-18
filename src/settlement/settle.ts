import { contractIdSchema } from "../git/identity.js";
import { z } from "zod";
import { debtIdSchema, type DebtId } from "../debt/identity.js";
import type { ContractId, ContractState } from "../core/facts/types.js";
import {
  withPrivateStatePublicationSeat,
  isPrivateStateSeatContention,
  privateStateSeatCloseLagSchema,
  type PrivateStateSeatCloseLag,
} from "../git/private-state-seat.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { GitPlumbingError, type GitRepository } from "../git/process.js";
import { SqliteTransactionLockError, type HeldSqliteTransactionLock } from "../coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { settleDebt, type SettledDebtResult } from "../debt/operations.js";
import { observeDebtHolder, publishDebtHolderRelease, type DebtHolder } from "./holder.js";
import { acquireDebtSettlementFence } from "./fence.js";
import { World } from "../world.js";

export const settlementActionSchema = z
  .object({ kind: z.literal("debt"), debtId: debtIdSchema, action: z.literal("done") })
  .strict()
  .readonly();
export type SettlementAction = z.infer<typeof settlementActionSchema>;
export const settlementLagSchema = z
  .object({
    kind: z.literal("settlement-failed"),
    surface: z.enum(["debt-holder", "debt"]),
    contractId: contractIdSchema,
    debtId: debtIdSchema.exactOptional(),
    path: z
      .string()
      .refine((value) => value.trim() !== "")
      .exactOptional(),
    diagnostic: z.string().refine((value) => value.trim() !== ""),
  })
  .strict()
  .readonly();
export type SettlementLag = z.infer<typeof settlementLagSchema>;
export const settlementReportSchema = z
  .strictObject({
    actions: z.array(settlementActionSchema).readonly(),
    lags: z.array(settlementLagSchema).readonly(),
    seatClose: z.array(privateStateSeatCloseLagSchema).readonly().exactOptional(),
  })
  .readonly();
export type SettlementReport = z.output<typeof settlementReportSchema>;

type SettlementProgress = Readonly<{
  recordSettlement(contractId: ContractId, report: SettlementReport): void;
}>;

function operational(error: unknown): error is Error {
  return (
    error instanceof Error &&
    !(
      error instanceof AuthorityCorruptionError ||
      error instanceof TypeError ||
      error instanceof RangeError ||
      error instanceof ReferenceError ||
      error instanceof SyntaxError
    ) &&
    (error instanceof GitPlumbingError ||
      error instanceof SqliteTransactionLockError ||
      ("code" in error && typeof error.code === "string" && /^E[A-Z0-9]+$/u.test(error.code)))
  );
}

function debtFailure(result: Exclude<SettledDebtResult, { kind: "changed" | "unchanged" }>): string {
  return result.kind === "retry"
    ? `Debt settlement requires retry: ${result.reason}`
    : `Debt settlement refused: ${result.reason}${"state" in result ? ` (${result.state})` : ""}`;
}

function isHeldFor(holder: DebtHolder | undefined, debtId: DebtId): holder is DebtHolder {
  return holder?.disposition === "held" && holder.debtId === debtId;
}

type SettlementEvidence = {
  actions: SettlementAction[];
  lags: SettlementLag[];
  seatClose?: readonly PrivateStateSeatCloseLag[];
};

export async function settle(
  input: Readonly<{
    repository: GitRepository;
    channel: GitDecodeChannel;
    state: ContractState | null;
    progress?: SettlementProgress;
  }>,
): Promise<SettlementReport> {
  const report: SettlementEvidence = { actions: [], lags: [] };
  const { state, channel, progress } = input;
  if (state?.terminal?.kind !== "claimed") return report;

  const contractId = state.id;
  const repository = { ...input.repository, effectiveCwd: input.repository.primaryWorktree };
  const observe = () => observeDebtHolder(repository, channel, contractId);
  let coordinate: Pick<SettlementLag, "surface" | "debtId"> = { surface: "debt-holder" };
  const recordLag = (diagnostic: string, at = coordinate): void => {
    const lag: SettlementLag = { kind: "settlement-failed", contractId, ...at, diagnostic };
    report.lags.push(lag);
    progress?.recordSettlement(contractId, { actions: [], lags: [lag] });
  };

  let fence: HeldSqliteTransactionLock | undefined;
  let closeCoordinate = coordinate;
  let exceptional = false;
  try {
    const { holder: hint } = await observe();
    if (hint?.disposition !== "held") return report;
    const debtId = hint.debtId;
    coordinate = { surface: "debt", debtId };
    fence = await acquireDebtSettlementFence(repository, debtId);
    closeCoordinate = { surface: "debt-holder", debtId };
    coordinate = { surface: "debt-holder" };
    const { holder: current } = await observe();
    if (!isHeldFor(current, debtId)) return report;
    coordinate = { surface: "debt", debtId };
    const result = await settleDebt(await World.at(repository.primaryWorktree), debtId);
    if (result.kind === "changed") {
      const action: SettlementAction = { kind: "debt", debtId, action: "done" };
      report.actions.push(action);
      progress?.recordSettlement(contractId, { actions: [action], lags: [] });
      if (result.cleanup !== undefined) recordLag(result.cleanup);
    } else if (result.kind !== "unchanged") {
      recordLag(debtFailure(result));
      return report;
    }

    coordinate = closeCoordinate;
    const onCloseLag = (lag: PrivateStateSeatCloseLag): void => {
      report.seatClose = [lag];
      progress?.recordSettlement(contractId, { actions: [], lags: [], seatClose: report.seatClose });
    };
    const outcome = await withPrivateStatePublicationSeat(
      repository,
      async (seat) => {
        const { snapshot, holder } = await observe();
        if (!isHeldFor(holder, debtId)) return;
        const failure = await publishDebtHolderRelease(repository, snapshot, holder, seat);
        if (failure !== undefined) recordLag(`Debt holder release requires retry: ${failure}`);
      },
      { onCloseLag },
    );
    if (outcome.closeLag !== undefined) onCloseLag(outcome.closeLag);
  } catch (error) {
    if (isPrivateStateSeatContention(error)) recordLag(`Debt holder release requires retry: ${error.message}`);
    else if (operational(error)) recordLag(error.message);
    else {
      exceptional = true;
      throw error;
    }
  } finally {
    try {
      fence?.close();
    } catch (error) {
      if (operational(error)) recordLag(error.message, closeCoordinate);
      else if (!exceptional) throw error;
    }
  }
  return report;
}
