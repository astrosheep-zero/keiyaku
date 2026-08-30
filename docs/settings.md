# Settings

Settings is the read-only shared resource for user and project configuration.
It owns the caller-supplied project and user coordinates, their precedence,
failure isolation, provenance, and observation. It owns no product namespace,
entry name, record grammar, default, or admission policy.

## Scope and observation

The process edge supplies an already resolved World coordinate and, when
needed, a user-home coordinate. Settings does not discover a current directory,
reinterpret a managed worktree as another project scope, load dotenv files, or
perform environment interpolation. An omitted project coordinate means there
is no project scope, rather than permission to guess one.

Each scope is independently observed as available, absent, or unavailable.
Missing configuration is ordinary absence; a read, decoding, or outer-resource
failure remains scoped failure with bounded diagnostic evidence. One scope's
failure never makes an unrelated scope or namespace look empty.

Settings exposes named namespace views as opaque product material. A malformed
namespace affects that namespace when it is selected, not unrelated namespaces.
An unavailable higher scope cannot silently fall through to a lower candidate:
the caller must see that the potential shadowing authority could not be read.

## Shadowing and product custody

When both scopes supply the same named entry, the project entry shadows the
whole user entry. Settings never deep-merges record fragments or fabricates
per-field provenance. A resolved value retains whether it came from project or
user scope and may reveal that it shadowed a lower candidate.

The consuming product owns its entry names, internal grammar, defaults,
validation, and the moment at which an invalid selected value is refused.
Unknown namespaces and unselected entries remain opaque to Settings so one
product cannot prevent another product or a future version from reading its
own material. Settings never imports Contract, Git, Akuma, or provider
vocabulary to validate it.

Settings observations are immutable input to a consumer's own decision. A
consumer may freeze the resolved value it used for a durable decision, but
later edits do not rewrite that decision. Settings itself has no write command,
no mutation API, no secrets-redaction fiction for the local trusted-user
boundary, and no execution role.

## Presentation and boundary

The CLI may present scope availability, selected entries, source, and shadowing
as a read-only diagnostic. That presentation neither validates opaque records
nor becomes a configuration editor. Product-specific errors identify the
consumer that selected the material; Settings errors identify only resource or
scope observation. Literal file layout and configuration shapes belong to the
resource implementation and leaf help, not Settings law.
