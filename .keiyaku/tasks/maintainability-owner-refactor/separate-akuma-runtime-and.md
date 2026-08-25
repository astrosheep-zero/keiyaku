---
id: task/maintainability-owner-refactor/separate-akuma-runtime-and
title: Separate Akuma runtime and addressed product owners
state: done
priority: 1
needs: []
parent: task/maintainability-owner-refactor/return-all-oversized-source
supersedes:
  - task/separate-akuma-body-supervision-from-turn-execut
  - task/separate-akuma-request-transport-from-request-ex
relates: []
note: Current-main replacement Contract landed and claimed the owner split.
createdAt: 2026-08-24T01:49:58.212Z
updatedAt: 2026-08-24T04:32:20.409Z
---
Move Body lifetime supervision out of Turn drive, admitted request execution out of the filesystem pump, and addressed handle controls out of product birth and list composition. Preserve Heart admission, parent lease, cancellation fences, and provider custody order.