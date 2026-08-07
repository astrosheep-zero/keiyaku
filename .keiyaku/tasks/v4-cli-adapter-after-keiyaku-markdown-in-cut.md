---
id: task/v4-cli-adapter-after-keiyaku-markdown-in-cut
title: v4 CLI adapter after Keiyaku markdown-in cut
state: done
priority: 0
needs:
  - task/v4-keiyaku-markdown-in-public-surface
parent: task/v4-architecture-correct-extensible-mvp
supersedes: []
relates: []
contractId: null
---
Migrate src/cli to docs/cli.md: acquire one Keiyaku or Repo construction point, pass Markdown and structured flags directly, remove commands/body.ts and all body/arc deep imports, resolve selectors from Repo.status rows, render nullable Delivery.diff as diffUnavailable, and keep parser syntax-only. No lifecycle or document grammar changes.