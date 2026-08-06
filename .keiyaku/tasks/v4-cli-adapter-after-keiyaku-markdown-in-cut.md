---
id: v4-cli-adapter-after-keiyaku-markdown-in-cut
title: v4 CLI adapter after Keiyaku markdown-in cut
state: open
pri: 0
needs:
  - v4-keiyaku-markdown-in-public-surface
parent: v4-architecture-correct-extensible-mvp
from: []
createdAt: 2026-08-06T02:35:55.379Z
updatedAt: 2026-08-06T02:35:55.379Z
creator: thekoc
---
Migrate src/cli to docs/cli.md: acquire one Keiyaku or Repo construction point, pass Markdown and structured flags directly, remove commands/body.ts and all body/arc deep imports, resolve selectors from Repo.status rows, render nullable Delivery.diff as diffUnavailable, and keep parser syntax-only. No lifecycle or document grammar changes.
