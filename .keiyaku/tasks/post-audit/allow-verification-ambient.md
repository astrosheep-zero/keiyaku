---
id: task/post-audit/allow-verification-ambient
title: Allow Verification ambient environment without persisting it
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T08:38:53.943Z
updatedAt: 2026-09-01T09:16:40.540Z
---
Change Verification execution and hooks to use the caller process environment without recording environment values in evidence or creating a second authority. Keep current subject/currentness and evidence reuse semantics as an intentional product tradeoff. Update docs/verification.md and invert tests that currently assert host environment is hidden.