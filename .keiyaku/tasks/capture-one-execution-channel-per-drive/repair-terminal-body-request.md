---
id: task/capture-one-execution-channel-per-drive/repair-terminal-body-request
title: Repair terminal Body Request custody for unregistered action
state: done
priority: 2
needs: []
parent: task/architecture-ownership/inject-one-per-drive-execution
supersedes: []
relates: []
note: "Focused akuma-body-requests regression passes: an envelope-valid akuma.wait missing from the serving registry receives a terminal refused receipt without external cancellation; no Heart request is admitted."
createdBy: aku/worker/4b5380b1
createdAt: 2026-08-29T08:22:41.805Z
updatedAt: 2026-08-29T08:27:23.970Z
---
Under docs/akuma-requests.md and the predecessor command/codec owner, ensure an action that decodes structurally but is absent from serving dispatch reaches one durable terminal refusal/receipt. Add focused unregistered.action regression. Do not add a second registry.