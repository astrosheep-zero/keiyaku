---
id: task/add-honest-status-ages-and-semantic-color
title: Expose honest status timestamps and render ages
state: open
priority: 0
needs:
  - task/expose-kanshi-world-and-blocker-evidence
parent: null
supersedes: []
relates: []
note: "Scope split by Faye in Square act_340: Part A is bindable; semantic color moved to a separate on-hold decision task; public age/lifeSince fields dissolved."
createdAt: 2026-08-11T08:52:15.887Z
updatedAt: 2026-08-14T00:55:52.870Z
---
Square act_340 Part A only. Complete the Kanshi section readers with existing fact-level timestamps: Contract phase start from the owning journal entry, current gate attestation time from the selected attestation, and Akuma life-state start from the owning Heart facts (running current Body start; asleep last Body finish or soul.createdAt when never run; error occurrence time). The text renderer derives compact age from the report's one observedAt. Durations remain ephemeral: add no durable age, duration, telemetry, public age, or public lifeSince field. Future timestamps render as future rather than a false age; an absent lawful timestamp renders as —. Keep existing dim/alert behavior unchanged; semantic color policy is a separate product decision. Update the owning root documents in the same delivery.