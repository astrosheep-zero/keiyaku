---
id: task/usability/make-additive-akuma-permissions-6abb
title: Make additive Akuma permissions discoverable and inspectable
state: done
priority: 2
needs: []
parent: task/usability/follow-up-on-the-pi-flash-d8e2
supersedes: []
relates: []
note: ""
createdAt: 2026-09-09T12:54:16.998Z
updatedAt: 2026-09-09T16:18:14.028Z
---
Usability follow-up from the trials: the lead searched implementation files for legal product.action values and effective permission facts. The slashAll lead later claimed each worker received only its seat action, although all six workers' frozen Souls contained all 16 default forwarded actions.

Preserve existing semantics: --allowed adds to the selected configuration defaults; it does not narrow or replace them. Inspect configuration defaults, explicit empty grants, and existing inheritance rules before changing their presentation. Keep worker-a-only prompt restrictions distinct from harness action permissions.

Make the legal action vocabulary discoverable through executable help, and make the effective frozen set available through a targeted public Akuma observation without reading private databases. Inspect existing public/status values first and reuse the owning observation rather than adding a second permission store or reinterpreting the configuration after birth. Exact output placement is an implementation design detail still to settle; do not print a full permission table on every ordinary call receipt.

Update call help and relevant skills so the additive behavior and defaults are understood at commission time. Test empty/default/explicit configuration cases, additions, direct-parent clipping, and the correspondence between displayed effective actions and the frozen set. This task must not add a narrowing flag, invent a role model, or alter allowed-action semantics.

Evidence: /private/tmp/keiyaku-pi-flash-ux.iAwdzr/REPORT.md, evidence/slash-array-lead-answer.txt, and evidence/fork-interview-wait.txt.

Read docs/akuma-allowed.md, public-akuma.md, akuma-public.md and cli-output.md through the authority index. Keep any newly settled observation law in its owning chapter, not in this Task. npm-only verification.
Completed through independent revised-candidate review, exact current-target integration review, and reviewed + verified gates. Placed 06a28aa5a96109dda2bb72dd18f24fcee19d87ba on main, predecessor df33c3a. All four final Verification declarations passed; final review reused that same subject testimony and claimed. Evidence: evidence/permissions-delivery.json, permissions-final-review.json, review-permissions-integration-verdict.txt under /private/tmp/keiyaku-pi-flash-ux.iAwdzr. No claim of narrowing or changed grants; allowed is frozen observation.