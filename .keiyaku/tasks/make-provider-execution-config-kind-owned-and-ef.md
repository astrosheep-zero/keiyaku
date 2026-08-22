---
id: task/make-provider-execution-config-kind-owned-and-ef
title: Make provider execution config kind-owned and effective
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-15T06:53:27.986Z
updatedAt: 2026-08-22T07:19:08.350Z
---
Each provider kind owns the complete grammar and runtime consumption of its execution.config. For every kind, a nonempty config has exactly one honest fate at admission: decode the closed kind grammar and consume the decoded value at the native boundary, or return typed refusal. No config may be frozen into Soul while its fields are ignored.

Move any generic provider-index config decoding into the selected adapter. Keep Settings opaque, Archetype free of native-control fields, and Provider Core free of a capability registry or generic extension bag. Settle concrete provider grammars independently from readonly restraint.