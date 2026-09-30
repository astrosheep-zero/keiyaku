/** @architectureCompositionRoot */
import { rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { stopAkuma, AkumaResetStopError } from "../akuma/nuke.js";
import { nukeGit, GitResetStopError } from "../git/nuke.js";
import type { GitRepository } from "../git/process.js";
import { nukeTask } from "../task/operations.js";
import { World, type WorldRoot } from "../world.js";
import { isOperationalFailure } from "../protocol/progress.js";
import { requireInput, requireMarkdown } from "./input.js";
import { InvocationAccumulator, project, validated, type ResetOutcome, type ResetOwner } from "./outcome.js";

export type NukeInput = Readonly<{ world: WorldRoot; confirm?: string }>;
export type NukeResult = ResetOutcome;
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

export async function nukeKeiyaku(input: NukeInput, gitOptions?: NukeGitOptions): Promise<NukeResult> {
  const value = validated(() => {
    const values = requireInput(input, "nuke input", ["world", "confirm"]);
    return {
      world: requireMarkdown(values.world, "world"),
      confirm: values.confirm === undefined ? undefined : requireMarkdown(values.confirm, "confirm"),
    };
  });
  const world = await World.prove(value.world);
  const accumulator = new InvocationAccumulator();
  accumulator.beginReset(world);
  let failure: { error: unknown } | undefined;
  const stop = (owner: ResetOwner, error: unknown): void => {
    if (!operational(error)) {
      failure ??= { error };
      return;
    }
    accumulator.recordReset({ kind: "reset-owner-stopped", world, owner, diagnostic: error.message });
  };
  const runOwner = async (owner: ResetOwner, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      stop(owner, error);
    }
  };
  let refusal: import("./outcome.js").ResetRefusal | undefined;
  if (value.confirm === undefined) refusal = { kind: "nuke-confirmation-required", world };
  else if (value.confirm !== world)
    refusal = { kind: "nuke-confirmation-mismatch", world, confirmation: value.confirm };
  else {
    let deleteAkuma: (() => Promise<void>) | undefined;
    await runOwner("akuma", async () => {
      deleteAkuma = await stopAkuma(world);
    });
    // No deletion owner starts without proof that live writers have stopped.
    if (deleteAkuma !== undefined) {
      await Promise.all([
        runOwner("akuma", deleteAkuma),
        runOwner("git", async () => {
          const result = await nukeGit(world, "git", gitOptions, (counts) => accumulator.recordResetRemoved(counts));
          if (result.closeLag !== undefined)
            accumulator.recordReset({
              kind: "reset-residue",
              world,
              owner: "git",
              diagnostic: result.closeLag.diagnostic,
            });
        }),
        runOwner("task", async () => {
          await nukeTask(world, { onRemoved: (tasks) => accumulator.recordResetRemoved({ tasks }) });
        }),
      ]);
      await runOwner("world", () => removeEmptyWorldMarker(world));
    }
  }
  const projected = project(
    "nuke",
    accumulator.snapshot(),
    failure !== undefined
      ? { kind: "failed", world, error: failure.error }
      : refusal !== undefined
        ? { kind: "refused", world, refusal }
        : { kind: "accepted", world },
  );
  if (projected.kind === "failed") throw projected.error;
  return projected.outcome;
}
