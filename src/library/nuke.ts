import { rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { stopAkuma } from "../akuma/nuke.js";
import { nukeGit } from "../git/nuke.js";
import { nukeTask } from "../task/operations.js";
import type { WorldRoot } from "../world.js";
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
    }>
  | Readonly<{
      kind: "failed";
      world: WorldRoot;
      diagnostic: string;
    }>;

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

function nukeInput(input: NukeInput): NukeInput {
  const value = requireInput(input, "nuke input");
  const world = requireMarkdown(value.world, "world") as WorldRoot;
  const confirm = value.confirm === undefined ? undefined : requireMarkdown(value.confirm, "confirm");
  return { world, ...(confirm === undefined ? {} : { confirm }) };
}

export async function nukeKeiyaku(input: NukeInput): Promise<NukeResult> {
  const value = nukeInput(input);
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
    await Promise.all([attempt(deleteAkuma()), attempt(nukeGit(value.world)), attempt(nukeTask(value.world))]);
    if (failed) throw firstDiagnostic;
    await removeEmptyWorldMarker(value.world);
    return { kind: "success", world: value.world };
  } catch (error) {
    return { kind: "failed", world: value.world, diagnostic: diagnostic(error) };
  }
}
