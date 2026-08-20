# Contract Documents

This chapter owns the Keiyaku Markdown methodology at the library edge. It is
a pure document boundary: it decides edge syntax and private document values,
never lifecycle legality, journal admission, or Git effects. A decoded
document remains library-private. Core retains only the opaque whole-document
bytes, their key, and ordered opaque segment keys defined by [model.md](model.md);
it knows no section name or Markdown grammar.

The sole cross-layer output of a decoded document is the key-stamped scalar
derivation `{ document, title, verification }`. `document` is the `DocumentKey`
stamp; `title` and the Verification definition are derived from exactly that
decoded document. The `verification` member carries the one typed declaration
preparation defined by [verification.md](verification.md); protocol may compose
that prepared or refused value into a verb input but never re-derive its
legality. The derivation carries neither a structured body, section tree, raw
body callback, nor a protocol body reader. It is attempt-local and is never a
persisted fact, cache, or replacement document authority. Its currency is
decided against the attempt observation by the one legal `decide` in
[lifecycle.md](lifecycle.md), not by the document boundary.

Amend, deliver, and audit are the consumers of that decoded-document
derivation. Review consumes no decoded value. Its testimony subject names the
document and patch identities actually reviewed, so later document movement is
handled by generic gate currentness rather than by another document projection.

## Markdown Dialect

The Markdown layer accepts column-zero ATX H1, H2, and H3 headings, one
repository-wide fence law, YAML frontmatter, blockquotes, nested lists, and
opaque inline and fence bytes. Setext headings and inline AST interpretation
are outside this dialect. Parsing is pure and source-aware. Tokens and nodes
carry UTF-16 `SourceSpan` coordinates that tile the original source after an
optional BOM without gaps or overlap. Slicing a span returns its exact source
interval, including CRLF bytes; logical normalization does not change those
coordinates. Normalized title and level indexes are derived once, and section
content is read from its source span.

## Contract Document

A contract document has exactly one H1 title and these required H2 sections:

| Section | Content |
| --- | --- |
| `Context` | Nonblank prose. |
| `Objective` | Nonblank prose. |
| `Design` | Nonblank prose. |
| `Region` | One closed fence with no info string or the exact `txt` info string, and one or more nonblank path patterns. |
| `Criteria` | One or more H3 criteria. Each title is unique after normalized comparison and each body is nonblank. |
| `Verification` | Optional ordered executor declarations owned by the library edge. |

The library owns interpretation of these sections and any extensions. They are
not structural core facts. In particular, `Region` and every other decoded
document field remain library methodology, not journal-model vocabulary.

`Region` declares the author's intended write surface so bind and amend can
report likely interaction with active Contracts. It is planning evidence, not
filesystem authority, a Git restriction, or a claim that the eventual diff
will contain every named path. Concurrent Contracts may declare overlapping
Regions. The overlap helps the flagship decide whether optimistic parallel work
is sensible; it does not adjudicate ownership or reject either Contract.

Kanshi may read the current Region declaration directly from active Contract
documents for planning. This uses the same grammar and exact calculator as
bind and amend; it creates no journal fact, cache, scope alias, ownership
decision, or projection of actual touched paths.

Each nonblank line in `Region` is one repository-relative positive path
pattern. `/` separates segments. Within a segment, `*` matches any number of
characters other than `/`, and `?` matches exactly one such character. `**`
matches any depth and may appear only as a complete segment. A final `/` is
directory shorthand and is normalized to `/**`; no other empty segment is
valid. A pattern may not contain `!`, `[`, `]`, `{`, or `}`, begin with `/`, or
contain `..`. Invalid patterns are typed document refusals.

The dialect computes exact intersection between two patterns from this closed
grammar. It does not use a conservative approximation for the pattern
calculation. The resulting overlap is still a coarse comparison of declared
intent, not an exact forecast of future Git writes. This interpretation is pure
body methodology: only the opaque source document terms may persist below the
library edge; core, protocol, and Git never receive the decoded body.

The title has no content before the first H2. The document has no nonblank
bytes outside its H1 and H2 sections, no duplicate top-level H2, and no
frontmatter. An unrecognized H2 is an extension with its original title and
content bytes; its content is nonblank. Decoding keeps the complete opaque
document bytes, mints a whole-document key and ordered segment keys, and
supplies those opaque terms for persistence. It never supplies the decoded
body. Core stores the bytes without parsing them. `gates` and `after` are
machine terms, not Markdown-derived core fields.

`Verification` uses one or more direct closed fences with an exact `bash`,
`zsh`, or `pwsh` info string, optionally followed by one ASCII space and
`timeout=<integer-duration>` where the duration has one of the `ms`, `s`, `m`,
or `h` units, and a nonblank script body.
The optional timeout belongs to that declaration alone; its absence means no
Keiyaku deadline. A declaration has no other attributes.
The resulting declaration values are private library/verification values. Core
receives only the opaque segment key and never sees executor, script, or section
name.

## Reserved Sections

The normalized H2 titles `Gates`, `Pipeline`, `After`, `Arc`, and `Fulfillment`
are refused with the ordinary invalid-document `TypeError`. They are not
extensions. `Gates`, `Pipeline`, and `After` do not encode structured operation
inputs. `Arc` and `Fulfillment` are reserved for the derived guidance owned by
[workspace.md](workspace.md).

## Amend Operations

`Keiyaku.amend` accepts an operation document made solely of H2 sections. It
has no H1, frontmatter, or nonblank bytes outside those sections. Every H2
heading has exactly this grammar:

```text
## Replace: Context|Objective|Design|Region|Criteria|Verification|<extension>
## Append: Context|Objective|Design|Criteria|<extension>
## Add: Criteria|<new-extension-title>
## Update: Criterion <existing-title>|<existing-extension-title>
## Remove: Criterion <existing-title>|<existing-extension-title>
```

`Replace` supplies the target's complete canonical content. `Append` adds
canonical prose or canonical collection entries. `Add` creates an extension or
adds one or more H3 criteria. `Update: Criterion <title>` replaces the named
criterion's canonical body; `Remove: Criterion <title>` has no body and
removes that keyed criterion. Extension update and remove use the exact
extension title in the H2 target. A target occurs at most once for an operation
kind when duplicate application would be ambiguous.

Every operation body uses the grammar of its target section. `Replace:
Verification` uses the declaration grammar above. The complete amended document is
produced by applying the ordered operations at the edge; the library then mints
replacement opaque document keys for core. A derivation selected from an older
document is never silently retargeted to those replacement keys; the receiving
attempt's one legal decision determines whether its stamp is current.

Amend rendering preserves the exact source bytes of the H1 and every H2 section
that no operation addresses. Only an addressed or newly added section is
rendered from its admitted operation value; removal omits that section. This
keeps untouched segment identities stable without making formatting or segment
meaning part of core.

When `Keiyaku.amend` supplies no operation document, the current opaque
document bytes and ordered segment keys are copied unchanged. That path does
not apply H2 operations or pass the current document through the amendment
renderer.

## Arc Document

`Keiyaku.arc` accepts exactly one document in this shape:

```markdown
# <title>

## Objective
<nonblank objective>

## Brief
<nonblank dispatch brief>
```

It has no frontmatter, no additional top-level section, and no unowned
nonblank bytes. The decoded value is `{ title, objective, brief }`. The
contract's current chapter and its sequence are lifecycle state, defined in
[lifecycle.md](lifecycle.md).

## Rendering Boundary

The decoder, amendment applier, and arc decoder are internal library consumers
of this methodology. A document is decoded once and its structured edge value
does not leave the library. Only its key-stamped `{ document, title,
verification }` derivation may cross to a verb attempt, where the lifecycle
decision judges its currency. Edge formatting, when needed, does not create
core facts, persisted derivations, or a second document authority. The
package-root boundary is owned by [public-api.md](public-api.md).
