---
id: task/unify-archetype-access-configuration-across-prov
title: Make readonly restraint honest across providers
state: in_progress
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-15T03:09:58.284Z
updatedAt: 2026-08-15T06:52:56.436Z
---
Replace the overclaimed Archetype `access: read | write | auto` axis with the one-sided optional `readonly: true` restriction.

The portable promise is only that an Akuma cannot mutate its task surface. Provider admission is the sole realization judge. Codex, Claude, and Pi must realize the restriction using native sandbox or tool removal; OpenCode V1 and generic ACP remain usable but expose one durable `none` restraint with a concrete diagnostic. Birth freezes that named fact in Soul; fork, Body Requests, call, status, and CLI only preserve or project it. Network, confinement, and provider-native controls remain separate.

Hard-cut old Heart/schema and all old access vocabulary. Do not add a warning framework, capability registry, prompt-based enforcement, compatibility reader, or provider-name judgment outside adapter admission.
