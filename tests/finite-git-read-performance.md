# Finite Git read measurements

Candidate: `kei/read-frozen-git-authority-with-0bf1`.
Measured on Darwin arm64, Node v26.10.0, Apple Git 2.54.0 (Git-157).

Reproduce from the appointed worktree:

```sh
node --import tsx tests/support/benchmark-git-reads.ts
```

Each row runs in a fresh Node process. Repository capability construction and
fixture preparation finish before the command counter and wall timer start.
Peak RSS is the reader process's lifetime high-water mark in KiB, including Node,
tsx, and package loading; it does not sum Git or logging-shim child memory. These
are single local observations with warm filesystem caches, not thresholds or a
promise about subprocess topology.

The object fixture has 10,000 distinct 1,024-byte binary blobs. The targeted
fixture contains those 10,000 selected-directory leaves, 100,000 unrelated private
leaves below a separate subtree, and the format marker. Unknown leaves share a
blob to keep fixture construction bounded. The logging shim records native Git
commands and finite cat-file input without substituting their behavior.

| Read | Git commands | Wall ms | Reader peak RSS KiB | Object requests |
| --- | ---: | ---: | ---: | ---: |
| 1 immutable object | 1 | 30.30 | 130480 | 1 |
| 10 immutable objects | 1 | 17.24 | 129168 | 10 |
| 100 immutable objects | 1 | 19.49 | 131760 | 100 |
| 10000 immutable objects | 1 | 143.05 | 167424 | 10000 |
| One selected blob in the 110000-path private tree | 10 | 187.44 | 135008 | 3 |

The selected read resolves the state ref, reads its commit, validates each loaded
directory's actual object type, lists only the root, format directory, and
selected directory, then reads the format and selected blob.
It neither recursively enumerates nor lists the unrelated subtree. The three
object requests are the state commit, format marker, and selected blob.

Finite batches retain complete command output before parsing; the larger batch's
memory observation reflects this tradeoff. Selected reads spend additional
commands at directory and batch boundaries. There is no resident process,
fixed two-command promise, transport pipeline, or later channel-close failure.
Measurements intentionally stay separate from behavior assertions.

After rebasing onto the independently delivered native-index writer, frozen
writer-directory inventories stay deleted. The remaining directory memo belongs
to immutable-root reads. Source reduction is measured against the current main;
none of the native writer's prior deletions are credited to this candidate.

## Review corrections

Real Git regression fixtures cover a non-root directory entry pointing to a blob
through exact-path, explicit-subtree (including a deeper corrupt descendant), and
complete reads. Each reports authority corruption rather than a plumbing failure.
Concurrent real cat-file commands also cover an early truncated-object failure
while a sibling remains alive: scope exit waits for that sibling, retains the
original error unchanged on clean retirement, and preserves both errors when the
sibling fails during draining.

Against approved base `09d59cc934de7ae3cb2988e2cf898a9bee74db1e`, the complete
candidate changes seven source files: 311 added and 583 removed lines, net -272.
Formatting both baseline and candidate source with repository Prettier 3.6.2
settings yields 2786 baseline lines and 2514 candidate lines, net -272. The
performance rows above are retained historical observations, not a rerun for
this final count. The count includes the correctness fixes; no packing or
native-writer deletion credit is used.
