---
id: task/make-task-nuke-delete-owned
title: Make Task nuke delete owned authority by path custody
state: in_progress
priority: 1
needs: []
parent: task/make-keiyaku-nuke-reset-converge
supersedes: []
relates: []
note: ""
createdAt: 2026-08-22T16:54:37.452Z
updatedAt: 2026-08-22T18:38:25.156Z
---
Faye ruling act/284 F1: Task nuke must not decode Task Markdown before deletion. Enumerate only regular non-symlink .md authority files under the owned tasks topology whose paths have valid Task coordinates; delete them under the existing allocation/per-Task lock discipline, regardless of document validity. Preserve unknown paths, nonregular entries, symlinks, and bytes outside Task authority. Remove empty owned Task directories when no unknown bytes remain.