# Contract Documents

This chapter owns the Keiyaku Markdown methodology at the library edge. It is
a pure document boundary: it decides edge syntax and private document values,
never lifecycle legality, journal admission, or transport effects. Core receives
only an opaque whole-document key and ordered opaque segment keys; it knows no
section name or Markdown grammar.

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

## Contract Document

A contract document has exactly one H1 title and these required H2 sections:

| Section | Content |
| --- | --- |
| `Context` | Nonblank prose. |
| `Objective` | Nonblank prose. |
| `Design` | Nonblank prose. |
| `Region` | One closed fence with no info string and one or more nonblank path patterns. |
| `Criteria` | One or more H3 criteria. Each title is unique after normalized comparison and each body is nonblank. |

The library owns interpretation of these sections and any extensions. They are
not structural core facts. In particular, `Region` and every other decoded
document field remain library methodology, not journal-model vocabulary.

The title has no content before the first H2. The document has no nonblank
bytes outside its H1 and H2 sections, no duplicate top-level H2, and no
frontmatter. An unrecognized H2 is an extension with its original title and
content bytes; its content is nonblank. Decoding mints the whole-document key
and ordered segment keys carried by core. `gates` and `after` are machine terms,
not Markdown-derived core fields.

Verification declaration syntax, its internal value shape, and its dependency
law are intentionally unfrozen. They are owned by the verification producer at
the outer library edge, never by core or this chapter's contract grammar.

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
```

`Replace` supplies the target's complete canonical content. `Append` adds
canonical prose or canonical collection entries. `Add` creates an extension or
adds one or more H3 criteria. `Update: Criterion <title>` replaces the named
criterion's canonical body; `Remove: Criterion <title>` has no body and
removes that keyed criterion. Extension update and remove use the exact
extension title in the H2 target. A target occurs at most once for an operation
kind when duplicate application would be ambiguous.

Every operation body uses the grammar of its target section. The complete
amended document is produced by applying the ordered operations at the edge;
the library then mints replacement opaque document keys for core. Producer
specific declaration updates are intentionally outside this generic amendment
grammar.

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
of this methodology. A document is decoded once; no public structured
`ContractBody` value or render operation exists. Edge formatting, when needed,
does not create core facts or a second document authority.
