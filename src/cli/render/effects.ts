import type {
  ContractId,
  ExecutionCleanup,
  ExecutionStop,
  InvocationEffect,
  ReconciliationLag,
  SettlementLag,
  SnapshotId,
} from "../../index.js";

/** Presentation reads of the one native effect carrier; it never recomputes owner finality. */
export function effectLags(
  effects: readonly InvocationEffect[],
): readonly Readonly<{ contract: ContractId; lag: ReconciliationLag }>[] {
  return effects.flatMap((effect) =>
    effect.kind === "reconciliation-lag" ? [{ contract: effect.contract, lag: effect.lag }] : [],
  );
}

export function effectSettlementLags(
  effects: readonly InvocationEffect[],
): readonly Readonly<{ contract: ContractId; lag: SettlementLag }>[] {
  return effects.flatMap((effect) =>
    effect.kind === "settlement-lag" ? [{ contract: effect.contract, lag: effect.lag }] : [],
  );
}

export function effectCleanup(effects: readonly InvocationEffect[]): readonly ExecutionCleanup[] {
  return effects.flatMap((effect) => (effect.kind === "cleanup" ? [effect.issue] : []));
}

export function effectExecutionStops(effects: readonly InvocationEffect[]): readonly ExecutionStop[] {
  return effects.flatMap((effect) =>
    effect.kind === "execution-stopped"
      ? [
          {
            kind: "execution-stopped" as const,
            contractId: effect.contract,
            stage: effect.stage,
            reason: effect.reason,
            diagnostic: effect.diagnostic,
          },
        ]
      : [],
  );
}

export function effectRetainedCheckouts(
  effects: readonly InvocationEffect[],
): readonly Readonly<{ path: string; target: string; diagnostic: string }>[] {
  return effects.flatMap((effect) =>
    effect.kind === "checkout-retained"
      ? [{ path: effect.path, target: effect.target, diagnostic: effect.diagnostic }]
      : [],
  );
}

export function effectRetiredWorktrees(
  effects: readonly InvocationEffect[],
): readonly Readonly<{ contract: ContractId; name: string }>[] {
  return effects.flatMap((effect) =>
    effect.kind === "worktree-retired" ? [{ contract: effect.contract, name: effect.name }] : [],
  );
}

export function effectRetainedWorktrees(
  effects: readonly InvocationEffect[],
): readonly Readonly<{ contract: ContractId; path: string }>[] {
  return effects.flatMap((effect) =>
    effect.kind === "worktree-retained" ? [{ contract: effect.contract, path: effect.path }] : [],
  );
}

export function effectRecoverySnapshot(effects: readonly InvocationEffect[]): SnapshotId | undefined {
  for (const effect of effects) {
    if (effect.kind === "reconciliation-effect" && effect.effect.kind === "recovery-snapshot")
      return effect.effect.snapshot;
  }
  return undefined;
}
