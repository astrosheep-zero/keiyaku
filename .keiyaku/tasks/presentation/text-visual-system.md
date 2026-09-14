# Keiyaku Text Visual System

Authority: SOUL.md "Text 是第一 UI". This document is the design spec for the
presentation overhaul. Three scout reports (history of @scout-contract,
@scout-akuma, @scout-board) are the evidence base.

## 1. Marks: six, final

| Mark | Meaning |
| --- | --- |
| `●` | moving: running, in_progress, live candidate |
| `○` | calmly waiting: asleep, waiting, ready, on_hold |
| `✓` | done, satisfied, accepted |
| `×` | refused, failed, dropped, abandoned, killed |
| `!` | needs attention: unsatisfied, stale, blocked, stranded, lag, error |
| `?` | cannot know: unknown, unavailable, unborn |

Retired: `✕` (U+2715, use ×), `✗` (U+2717), `⧖`, `⧗`, `‖`, `•`, and the
bracket alphabet `[ ]` `[✓]` `[✗]` `[~]`. A mark is a scannable category; the
word right after it carries the detail. Gates render as `○ reviewed`,
`✓ reviewed`, `! reviewed · stale` — not brackets.

Timeline row marks keep `│` (continuation) and add nothing new: a row's
outcome mark is one of the six; a pending tell is `○ tell`.

## 2. Row grammar

- One entity, one head row: `mark  identity · state · age · title`.
- Facts under it, indent 2: `label  value` with two spaces after the label.
  Labels never repeat the section or head words. Values join inline with
  ` · ` (single spaces both sides). No `key=value` anywhere in text.
- Long opaque value that does not fit: value moves to the next line at
  indent 4 and keeps its label on its own line. A `·` never dangles at a
  line end.
- Movement uses `->`: `target moved  85a14e9 -> 422c9f5`, said once per row.
- SHAs are 7 characters in text, full in JSON. Same label, same length
  everywhere.
- Paths: absolute and copyable in selected status and audit; omitted from
  board and catalogue rows.
- Quotes: `safeText` escaping for opaque values, no decorative quoting;
  `" "` only around Akuma speech; shell quoting only in a command that is
  meant to be pasted.
- Absent facts are absent rows. Zero is not a fact: no `tasks 0`,
  `changes 0`, `untracked 0`, empty `record`, or empty diff labels.

## 3. Blocks

- Section headers exist only where several sections share one screen:
  `CONTRACTS // recent` style, one line, no blank line after it, one blank
  line between sections. No banner. `契 KEIYAKU // WORLD` is deleted.
- Slash-named sub-sections (`candidate/integration`) are deleted; their rows
  flatten into the entity block.
- Rulers (`────`, `-----`) are deleted everywhere. The identity line is the
  separation.
- Payload blocks (stdout, stderr, diff, summary, diagnostic, answer):
  label row at the block's indent, payload directly below at indent +2, no
  blank line between label and payload, one blank line after the block.
  Every payload is bounded; truncation states itself as the payload's last
  line: `[truncated]`.

## 4. Surface deltas

### Contract receipts (bind/amend/deliver/review/audit/refusal)

- Head row: `✓ delivered  kei/x` / `× deliver refused  kei/x`. No third
  vocabulary for the same refusal kind (`unmerged-paths` kebab vs
  `gates unsatisfied` words): refusal kinds stay kebab-case, stops use words.
- `record` wrapper deleted. Journal rows at indent 2:
  `journal  bind · bound`. Verification reuse at the same indent:
  `reuse  verified · satisfied · 01XYZ`.
- Lags and stops are `!` rows at indent 2, siblings of journal rows.
- Empty amend diff prints `terms unchanged`, not a label over blank lines.
- `history <contract>`: attestation payloads bounded to 4 KiB with a
  truncation line; subject identity renders as `subject  verification ·
  snapshot 09fb0ed`, never a JSON literal; full SHAs become 7.

### Status board and selected status

- Banner deleted. Section headers stay.
- Board contract rows drop the absolute worktree path; the path appears in
  selected status and audit only.
- Target head said once per row: `target  main @ 422c9f5 · behind 7 · moved
  85a14e9 -> 422c9f5`.
- Selected status flattens to head row + fact rows; no sub-section headers,
  no label repeating a section name.
- Multi-target status prints each identity once; no `status  <id>` echo
  above the block.
- `ls kei/` drops the `contract state … observedAt …` carrier line from text;
  it stays in JSON.
- Every board row respects the terminal width; overflow truncates with `…`.

### Akuma surfaces

- Timeline rows keep `HH:MM mark verb  text` and `│` continuation. Snapshots
  drop the ruler, drop zero counters, and end with one life row using the
  life word: `● running`, `✓ asleep`, `× killed`, `! stranded`, `? hung`.
- Contract association has one notation: board `-> kei/… (unavailable)`;
  snapshot second row `-> kei/…`. `└─`, `📜`, `[kei/…]` deleted. `📁`
  deleted; cwd is `cwd  /path` in receipts.
- `history <aku>` header gains the paging fact when bounded:
  `⋮ 292 earlier turns · showing last 12`. Think/say rows are clipped the
  same way status clips them; complete bytes remain available through
  `--last` and `--id`.
- Detached call receipt: identity (+alias), then fact rows `cwd`, `-> kei/…`
  when associated, `!` rows for restraint/alias/dispatch problems. The
  prescriptive `$ keiyaku wait …` footer is deleted; the wait verb is in
  help.
- `tell`/`kill`/`fork` receipts are the same grammar: identity head, outcome
  row. Failure rows wrap within the terminal width.
- `settings` redacts secret-looking values (keys, tokens) as `[redacted]`
  and renders nested objects as dotted rows, not recursive dumps.

### Execution progress (stderr)

- TTY: one status line, refreshed in place:
  `verify  ● setup · npm ci · 42s` — phase, current unit, ticking elapsed.
  The ticking elapsed is the liveness evidence; no heartbeat prose, no
  claim that a quiet child is hung or alive. Sub-process output appends in
  bounded blocks under the line; the status line returns to the bottom.
  Final line persists: `verify  ✓ 7/7 · 2m31s`.
- Non-TTY: sparse phase-boundary events, one line each, coordinates printed
  at phase start only:
  `✓ setup · npm ci · 42s`, `● declaration 2/3`, plus bounded output blocks.
- `progress dropped N events` stays.
- No `key=value`, no per-line `cwd=… hook=… declaration=…`.

## 5. Implementation grouping

- C1 receipt grammar: src/cli/render/{terminal,receipt,refusal,contract,
  audit,contract-history,contract-observation,catalog,region,status-set,
  nuke,value,text,settings,kanshi,board,task}.ts + tests/cli-render.test.ts.
  Owns the shared row primitives in terminal.ts.
- C2 akuma surfaces: src/cli/render/{akuma,akuma-activity,akuma-tool,
  akuma-tool-command,kanshi-akuma}.ts + akuma-focused test files. Runs after
  C1 lands, builds on the row primitives.
- C3 live progress: src/cli/render/execution-progress.ts, new
  src/cli/render/status-line.ts, src/cli/commands/contract-invoke.ts,
  src/cli/runtime.ts + new tests/cli-progress.test.ts. Independent of C1/C2
  files; runs in parallel.
