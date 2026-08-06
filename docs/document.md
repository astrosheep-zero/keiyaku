# Contract Documents

This chapter owns the grammar that turns Markdown into a contract body or an
amend/arc input. It is a pure document boundary: it decides syntax and typed
document values, never lifecycle legality, journal admission, or transport
effects.

## Markdown Dialect

The Markdown layer accepts column-zero ATX H1, H2, and H3 headings, one
repository-wide fence law, YAML frontmatter, blockquotes, nested lists, and
opaque inline and fence bytes. Setext headings and inline AST interpretation
are outside this dialect. `parseToAST(source)` is pure and source-aware.
Tokens and nodes carry UTF-16 `SourceSpan` coordinates. Token spans tile the
original source after an optional BOM without gaps or overlap, and
`rawSlice(span)` returns that exact source interval, including CRLF bytes.
Logical BOM and line normalization do not change those coordinates.

`indexDocument(document)` derives normalized title and level indexes. Consumers
read those indexes and typed children instead of scanning children, rendering a
section, or parsing it again. A section's content is read from its source span.

## Contract Body

A contract document has exactly one H1 title and these required H2 sections:

| Section | Content |
| --- | --- |
| `Context` | Nonblank prose. |
| `Objective` | Nonblank prose. |
| `Design` | Nonblank prose. |
| `Region` | One closed fence with no info string and one or more nonblank path patterns. |
| `Criteria` | One or more H3 criteria. Each title is unique after normalized comparison and each body is nonblank. |

`Verification` is optional. When present, it contains one or more direct,
closed fenced executor declarations. Each fence info string is exactly `bash`,
`zsh`, or `pwsh`, and each script body is nonblank. It contains no prose, list
declaration, or unlabelled fence.

The title has no content before the first H2. The document has no nonblank
bytes outside its H1 and H2 sections, no duplicate top-level H2, and no
frontmatter. An unrecognized H2 is an extension with its original title and
content bytes; its content is nonblank. The typed `ContractBody` retains the
validated title, prose, region patterns, criteria, verification declarations,
and extensions. Its structured `gates` and `after` properties arrive through
the public operation input and have no Markdown representation.

## Reserved Sections

The normalized H2 titles `Gates`, `Pipeline`, and `After` are refused with
`REMOVED_SECTION`. They are not extensions and they do not encode structured
operation inputs.

## Amend Operations

`Keiyaku.amend` accepts an operation document made solely of H2 sections. It
has no H1, frontmatter, or nonblank bytes outside those sections. Every H2
heading has exactly this grammar:

```text
## Replace: Context|Objective|Design|Region|Criteria|<extension>
## Append: Context|Objective|Design|Criteria|<extension>
## Add: Criteria|<new-extension-title>
## Update: Criterion <existing-title>|<existing-extension-title>
## Remove: Criterion <existing-title>|<existing-extension-title>
## Replace: Verification
```

`Replace` supplies the target's complete canonical content. `Append` adds
canonical prose or canonical collection entries. `Add` creates an extension or
adds one or more H3 criteria. `Update: Criterion <title>` replaces the named
criterion's canonical body; `Remove: Criterion <title>` has no body and
removes that keyed criterion. Extension update and remove use the exact
extension title in the H2 target. A target occurs at most once for an operation
kind when duplicate application would be ambiguous.

`Replace: Verification` uses the Verification fence grammar above. Every other
operation body uses the grammar of its target section. The complete amended
body is produced by applying the ordered operations to the current body; the
persisted amendment is that complete body.

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

Canonical rendering is the public `ContractBody.render` operation documented
in [public-api.md](public-api.md). The decoder, amendment applier, and arc
decoder are internal consumers of this grammar. A document is decoded once;
no consumer obtains a body by rendering and reparsing it.
