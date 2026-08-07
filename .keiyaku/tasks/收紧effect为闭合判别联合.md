---
id: task/收紧effect为闭合判别联合
title: 收紧Effect为闭合判别联合
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
contractId: null
---
Make carrier Effect exactly match docs/transport.md: a closed worktree branch with path/action and a closed ref branch with name/before/after/action. Remove optional cross-branch fields so impossible effect shapes are unrepresentable. Update consumers with exhaustive narrowing only.