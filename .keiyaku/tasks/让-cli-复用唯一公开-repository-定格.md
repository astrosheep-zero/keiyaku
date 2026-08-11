---
id: task/让-cli-复用唯一公开-repository-定格
title: 让 CLI 复用唯一公开 repository 定格
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-07T04:48:15.052Z
updatedAt: 2026-08-07T11:29:07.461Z
---
docs/cli.md 要求一次 invocation 只取得一个 pinned public handle。当前 @/cwd selector 必须 Repo.at().status() 后再 Keiyaku.of()，bind 为 settings 先 Repo.at() 后再 Keiyaku.bind()，带 gates 的 amend 还会再次 Repo.at()；每次构造都会重新发现同一 Git world。现有 package-root 没有从已定格 Repo 构造 Keiyaku/bind 的能力。先封闭 public capability flow，再让 CLI 一次 scope acquisition；不得用模块缓存、裸 GitRepository、CLI deep import 或双权威 registry。

Faye act_362 closes the public shape: Repo.at is the only world construction point; add `repo.contract({id})` and `repo.bind({...})` sharing one private PinnedScope; delete static `Keiyaku.of/bind` entirely. CLI creates one Repo and derives selector/settings/verb/reconcile from it. No convenience dual path or raw public scope.

While moving CLI to one Repo, also remove the second ContractId grammar in cli/selectors.ts. Full IDs should be validated by the one public repo.contract/library boundary (with CLI translating its programmer error to usage); @ resolution compares against StatusReport ContractIds. Do not keep a parallel /^kei.../ authority or add a public identity mint solely for CLI.