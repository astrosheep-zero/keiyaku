---
id: task/remove-known-akuma-entry-residue
title: Remove known Akuma entry residue during nuke
state: done
priority: 1
needs: []
parent: task/make-keiyaku-nuke-reset-converge
supersedes: []
relates: []
note: ""
createdAt: 2026-08-22T16:54:37.452Z
updatedAt: 2026-08-22T20:11:06.583Z
---
Faye ruling act/284 F2: recognized Akuma run entries are Keiyaku-owned. After stopping and holding custody, remove all known Keiyaku-produced entry files and directories, including leash.db and the requests channel, while preserving unknown child bytes. Remove empty recognized directories and the run root marker only when owner cleanup leaves no non-Keiyaku bytes. Keep lock files outside recognized entries and unknown .keiyaku bytes untouched.