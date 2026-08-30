# World

World is the shared directory coordinate for Task and Akuma products and
project-level Settings and Kanshi reads. A Git repository determines one World,
but World owns neither Git nor product facts.

## Coordinate

World resolution is an asynchronous edge operation. It provides the current
resolved World, the non-writing candidate it would establish, and an explicit
establish action. Reading resolution never changes the filesystem; establishment
creates only the selected World marker. Repository invocation selects the
canonical primary-worktree World, while a non-repository invocation may use the
nearest existing marker or establish its invocation directory. Home and the
filesystem root are deliberately never Worlds.

An explicit World construction establishes exactly its selected existing
directory and never climbs. Exact proof is the read-only capability boundary for
raw coordinates: it accepts only the canonical physical directory supplied by
the caller, never substitutes an ancestor, follows an alias, or creates a
marker. Outer operations prove raw process, transport, and JavaScript values
once before any product effect; product constructors consume the minted World
coordinate and do not resolve paths or inspect the current directory.

The invocation directory is edge input, never persisted identity. Linked and
managed worktrees of one repository share their World; no marker can split that
product identity. Execution working directories remain a separate Akuma concern.
Different repositories are different Worlds and are never combined into a
synthetic aggregate observation.

## Product Boundaries

Task authority, Akuma runtime facts, Settings, and Kanshi each retain their own
owner and storage. World only supplies their shared coordinate. Git discovery
and an explicit Contract repository are separate concerns: selecting a Contract
repository never rewrites the invocation World, and a Contract-selected Akuma
operation does not scan or substitute another World.

Plugins may receive validated, declared World-relative paths as their own
custody. Those paths remain ordinary project bytes rather than Keiyaku management
data; World grants no plugin a raw coordinate resolver, and plugin use never
extends the reset scope without an explicit owner adoption.

## Keiyaku-Owned Data Reset

`nuke` resets Keiyaku-owned management data for exactly one resolved World. It
is not repository cleanup or a generic directory teardown. World owns the reset
scope, literal confirmation, preservation rule, and one public execution answer;
each product owner deletes only its own custody.

Missing confirmation and a confirmation that differs from the resolved World
are typed refusals before every owner effect. Confirmed reset stops live writers
then independently invokes owner-local deletion. A failed owner remains
retryable under the same literal confirmation, but reset creates no preview,
token, snapshot hash, prompt, world-wide transaction, ledger, backup, trash,
undo, or lifecycle simulation.

Only recognized Keiyaku management custody in the selected World is in scope.
Repository source and business refs, ordinary worktree contents, authored
settings and configuration, global resources, unknown files, and foreign
worktrees remain. A marker or directory disappears only after its owner leaves
it empty. Unrecognized bytes within an otherwise known management area remain
preserved; reset never adopts arbitrary files merely because they lie nearby.

World composition has no fixed cross-owner deletion order, storage inventory, or
residue-specific knowledge. Git alone applies its state-first local reset rule;
that rule does not create a World-wide lock or transaction.
