import type { NextCall } from "../../errors.js";
import type { VerbInput } from "../../library/keiyaku-verbs.js";
import { safeText } from "../../text-preview.js";
export { exactIndentedLines, opaqueCoordinate, previewLines, quotedText, safeText } from "../../text-preview.js";

export const DEFAULT_CLI_COLUMNS = 100;

export function emptyCatalogue(surface: string): string {
  return `${surface}  none`;
}

export type RecoveryCoordinates = Readonly<{ cwd: string; repo?: string }>;

export type TextRenderContext = Readonly<{
  columns: number;
  color: boolean;
  actor?: string;
  now?: number;
  surface?: "cli" | "mcp";
  recoveryCoordinates?: RecoveryCoordinates;
}>;

export type RecoveryCall =
  | Extract<NextCall, { verb: "ls" }>
  | Readonly<{ verb: "deliver"; input: VerbInput<"deliver"> }>
  | Readonly<{ verb: "verify"; input: VerbInput<"verify"> }>;

function shellWord(value: string): string {
  return /^[a-zA-Z0-9_./:@-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function formatNextCall(
  call: RecoveryCall,
  { surface, recoveryCoordinates }: Pick<TextRenderContext, "surface" | "recoveryCoordinates"> = {},
): string | undefined {
  if (call.verb === "ls") {
    return surface === "mcp" ? `${call.verb} ${JSON.stringify(call.input)}` : `keiyaku ls ${call.input.selector}`;
  }
  const { input } = call;
  if (surface === "mcp" || recoveryCoordinates === undefined || input.contract === undefined) return undefined;
  const { cwd, repo } = recoveryCoordinates;
  const words = ["keiyaku", "-C", shellWord(cwd)];
  if (repo !== undefined) words.push("--repo", shellWord(repo));
  words.push(call.verb, shellWord(input.contract));
  if (call.verb === "deliver") {
    const { dryRun, showDiff, materializeConflict, overwrite, message } = call.input;
    if (dryRun === true) words.push("--dry-run");
    if (showDiff === true) words.push("--show-diff");
    if (materializeConflict === true) words.push("--materialize-conflict");
    if (overwrite === true) words.push("--overwrite");
    if (message !== undefined) {
      if (message === "-" || message.startsWith("--") || message.trim() === "") return undefined;
      words.push("--message", shellWord(message));
    }
  } else if (call.input.index !== undefined) words.push("--index", String(call.input.index));
  if (input.includeDirty === true) words.push("--include-dirty");
  const text = words.join(" ");
  return safeText(text) === text ? text : undefined;
}

type GitShortStat = Readonly<{
  filesChanged: number;
  insertions: number;
  deletions: number;
}>;

export function gitShortStat(stat: GitShortStat): string {
  const files = stat.filesChanged === 1 ? "1 file changed" : `${stat.filesChanged} files changed`;
  const parts = [files];
  if (stat.insertions === 1) parts.push("1 insertion(+)");
  else if (stat.insertions !== 0) parts.push(`${stat.insertions} insertions(+)`);
  if (stat.deletions === 1) parts.push("1 deletion(-)");
  else if (stat.deletions !== 0) parts.push(`${stat.deletions} deletions(-)`);
  return parts.join(", ");
}

export type SemanticTone = "dim" | "attention" | "alert";

/**
 * Compact age wording shared by catalog and kanshi renderers. A source later than the
 * observation is reported as `future`, so each surface chooses whether clock skew is
 * ordinary ("now") or worth flagging ("future").
 */
export function ageText(source: string, observedAt: string, future: "now" | "future" = "now"): string {
  const seconds = Math.floor((Date.parse(observedAt) - Date.parse(source)) / 1_000);
  if (seconds < 0) return future;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function tone(value: string, kind: SemanticTone, color: boolean): string {
  if (!color) return value;
  const code = kind === "dim" ? 2 : kind === "attention" ? 33 : 31;
  return `\u001b[${code}m${value}\u001b[0m`;
}

/** One machine kind as words; every receipt vocabulary spells kinds through this one rule. */
export function kindWords(kind: string): string {
  return kind.replaceAll("-", " ");
}

export function identityLine(mark: string, identity: string, extra = ""): string {
  return extra.length === 0 ? `${mark} ${safeText(identity)}` : `${mark} ${safeText(identity)} ${safeText(extra)}`;
}
