/** @architectureCompositionRoot */
import { rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { stopAkuma } from "../akuma/nuke.js";
import { nukeGit } from "../git/nuke.js";
import {
  appendPrivateStateSeatClose,
  type PrivateStateSeatCloseLag,
} from "../git/private-state-seat.js";
import type { GitRepository } from "../git/process.js";
import { nukeTask } from "../task/operations.js";
import { World, type WorldRoot } from "../world.js";
import { KeiyakuRefused } from "./refusal.js";
import { requireInput, requireMarkdown } from "./input.js";

export type NukeInput = Readonly<{
  world: WorldRoot;
  confirm?: string;
}>;

export type NukeResult =
  | Readonly<{
      kind: "success";
      world: WorldRoot;
      seatClose?: readonly PrivateStateSeatCloseLag[];
    }>
  | Readonly<{
      kind: "failed";
      world: WorldRoot;
      diagnostic: string;
      seatClose?: readonly PrivateStateSeatCloseLag[];
    }>;

type NukeGitOptions = Readonly<Pick<GitRepository, "onPrivateStateSeatContention" | "onPrivateStateSeatClose">>;

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removeEmptyWorldMarker(world: WorldRoot): Promise<void> {
  try {
    await rmdir(resolve(world, ".keiyaku"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
}

async function nukeInput(input: NukeInput): Promise<NukeInput> {
  const value = requireInput(input, "nuke input");
  const world = await World.prove(requireMarkdown(value.world, "world"));
  const confirm = value.confirm === undefined ? undefined : requireMarkdown(value.confirm, "confirm");
  return { world, ...(confirm === undefined ? {} : { confirm }) };
}

function withSeatClose<T extends { kind: "success" | "failed" }>(
  result: T,
  seatClose: readonly PrivateStateSeatCloseLag[] | undefined,
): T & Pick<NukeResult, "seatClose"> {
  return seatClose === undefined || seatClose.length === 0 ? result : { ...result, seatClose };
}

export async function nukeKeiyaku(input: NukeInput, gitOptions?: NukeGitOptions): Promise<NukeResult> {
  const value = await nukeInput(input);
  if (value.confirm === undefined) {
    throw new KeiyakuRefused({ kind: "nuke-confirmation-required", world: value.world });
  }
  if (value.confirm !== value.world) {
    throw new KeiyakuRefused({
      kind: "nuke-confirmation-mismatch",
      world: value.world,
      confirmation: value.confirm,
    });
  }
  let seatClose: readonly PrivateStateSeatCloseLag[] | undefined;
  try {
    const deleteAkuma = await stopAkuma(value.world);
    let failed = false;
    let firstDiagnostic: unknown;
    const attempt = async (owner: Promise<void>): Promise<void> => {
      try {
        await owner;
      } catch (error) {
        if (!failed) {
          failed = true;
          firstDiagnostic = error;
        }
      }
    };
    await Promise.all([
      attempt(deleteAkuma()),
      attempt(
        nukeGit(value.world, "git", gitOptions).then((outcome) => {
          if (outcome.closeLag !== undefined) {
            seatClose = appendPrivateStateSeatClose(seatClose, outcome.closeLag);
          }
        }),
      ),
      attempt(nukeTask(value.world)),
    ]);
    if (failed) throw firstDiagnostic;
    await removeEmptyWorldMarker(value.world);
    return withSeatClose({ kind: "success", world: value.world }, seatClose);
  } catch (error) {
    return withSeatClose({ kind: "failed", world: value.world, diagnostic: diagnostic(error) }, seatClose);
  }
}
