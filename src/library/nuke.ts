/** @architectureCompositionRoot */
import { rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { AkumaResetStopError, stopAkuma } from "../akuma/nuke.js";
import { GitResetStopError, nukeGit } from "../git/nuke.js";
import type { GitRepository } from "../git/process.js";
import { isOperationalFailure } from "../protocol/progress.js";
import { nukeDebt } from "../debt/operations.js";
import { World, worldRootSchema, type WorldRoot } from "../world.js";
import { requireInput, requireMarkdown } from "./input.js";
import { validated, withOutcomeReceipt } from "./outcome.js";

const resetOwnerSchema = z.enum(["akuma", "git", "debt", "world"]);
type ResetOwner = z.output<typeof resetOwnerSchema>;
export const resetIssueSchema = z.union([
  z
    .strictObject({ kind: z.literal("reset-owner-stopped"), owner: resetOwnerSchema, diagnostic: z.string().min(1) })
    .readonly(),
  z.strictObject({ kind: z.literal("reset-residue"), diagnostic: z.string().min(1) }).readonly(),
]);
export type ResetIssue = z.output<typeof resetIssueSchema>;
export function resetIssueIsRequired(issue: ResetIssue): boolean {
  return issue.kind === "reset-owner-stopped";
}
export type ResetCounts = Readonly<{ refs: number; worktrees: number; debts: number }>;
export const nukeResultSchema = z.union([
  z
    .strictObject({
      kind: z.literal("accepted"),
      refsRemoved: z.number().int().nonnegative().exactOptional(),
      worktreesRemoved: z.number().int().nonnegative().exactOptional(),
      debtsRemoved: z.number().int().nonnegative().exactOptional(),
      issues: z.array(resetIssueSchema).min(1).readonly().exactOptional(),
    })
    .readonly(),
  z.strictObject({ kind: z.literal("refused"), world: worldRootSchema }).readonly(),
]);
export type NukeInput = Readonly<{ world: WorldRoot; confirm?: string }>;
export type NukeResult = z.output<typeof nukeResultSchema>;
type NukeGitOptions = Readonly<Pick<GitRepository, "onPrivateStateSeatContention" | "onPrivateStateSeatClose">>;

function operational(error: unknown): error is Error {
  return error instanceof AkumaResetStopError || error instanceof GitResetStopError || isOperationalFailure(error);
}

async function removeEmptyWorldMarker(world: WorldRoot): Promise<void> {
  try {
    await rmdir(resolve(world, ".keiyaku"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
}

export function nukeKeiyaku(input: NukeInput): Promise<NukeResult> {
  return nukeWithGit(input);
}

/** Internal reset seam for observing Git custody in tests. */
export async function nukeWithGit(input: NukeInput, gitOptions?: NukeGitOptions): Promise<NukeResult> {
  const value = validated(() => {
    const values = requireInput(input, "nuke input", ["world", "confirm"]);
    return {
      world: requireMarkdown(values.world, "world"),
      confirm: values.confirm === undefined ? undefined : requireMarkdown(values.confirm, "confirm"),
    };
  });
  const world = await World.prove(value.world);
  if (value.confirm !== world) return { kind: "refused", world };

  const counts = { refs: 0, worktrees: 0, debts: 0 };
  const attempted = new Set<"git" | "debt">();
  const issues: ResetIssue[] = [];
  let failure: { error: unknown } | undefined;
  const runOwner = async (owner: ResetOwner, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      if (operational(error)) issues.push({ kind: "reset-owner-stopped", owner, diagnostic: error.message });
      else failure ??= { error };
    }
  };
  let deleteAkuma: (() => Promise<void>) | undefined;
  await runOwner("akuma", async () => {
    deleteAkuma = await stopAkuma(world);
  });
  // No deletion owner starts without proof that live writers have stopped.
  if (deleteAkuma !== undefined) {
    await Promise.all([
      runOwner("akuma", deleteAkuma),
      runOwner("git", async () => {
        attempted.add("git");
        const result = await nukeGit(world, "git", gitOptions, (removed) => {
          counts.refs += removed.refs ?? 0;
          counts.worktrees += removed.worktrees ?? 0;
        });
        if (result.closeLag !== undefined)
          issues.push({ kind: "reset-residue", diagnostic: result.closeLag.diagnostic });
      }),
      runOwner("debt", async () => {
        attempted.add("debt");
        await nukeDebt(world, {
          onRemoved: (debts) => {
            counts.debts += debts;
          },
        });
      }),
    ]);
    await runOwner("world", () => removeEmptyWorldMarker(world));
  }
  const partial = failure !== undefined || issues.some(resetIssueIsRequired);
  const removed: { refs?: number; worktrees?: number; debts?: number } = {};
  for (const key of ["refs", "worktrees", "debts"] as const) {
    const owner = key === "debts" ? "debt" : "git";
    if (counts[key] > 0 || (partial && attempted.has(owner))) removed[key] = counts[key];
  }
  if (failure !== undefined)
    throw withOutcomeReceipt(failure.error, {
      kind: "world",
      world,
      ...(Object.keys(removed).length === 0 ? {} : { removed }),
      ...(issues.length === 0 ? {} : { issues }),
    });
  return {
    kind: "accepted",
    ...(removed.refs === undefined ? {} : { refsRemoved: removed.refs }),
    ...(removed.worktrees === undefined ? {} : { worktreesRemoved: removed.worktrees }),
    ...(removed.debts === undefined ? {} : { debtsRemoved: removed.debts }),
    ...(issues.length === 0 ? {} : { issues }),
  };
}
