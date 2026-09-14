---
id: task/usability/drain-akuma-body-fixture-plugin-bc3b
title: Drain Akuma Body fixture plugin runtimes before teardown
state: done
priority: 1
needs: []
parent: task/usability/investigate-inconsistent-full-6096
supersedes: []
relates: []
note: ""
createdAt: 2026-09-09T23:16:49.453Z
updatedAt: 2026-09-09T23:38:25.916Z
---
Read-only report AMEND_FIXTURE_CLEANUP_REPORT.md proves the live-receipt fixture can remove its World while builtin Square turn-outcome delivery still writes .square/KEIYAKU.square after driveAkumaBody resolves. Repair test teardown ownership only: explicitly drain the same process-local plugin runtime before recursive World removal for closely identical driven-Body fixtures. Preserve plugin non-authority and the hanging-handler Body close/leash boundary; no production lifecycle change, cleanup retry, suppressed ENOTEMPTY, or broad disabling of plugin coverage.
Completed and placed f1717dfa41446761f8032a0df8d310fd335a000c on main over 149fe92 after independent review and all four final Verification declarations satisfied. Test-only helper drains the process-local plugin runtime before recursive teardown for 30 default driven-Body fixtures. Evidence: plugin-teardown-review.json and plugin-teardown-delivery.json under /private/tmp/keiyaku-pi-flash-ux.iAwdzr. The reviewer retained an earlier out-of-scope plugin-runtime ENOTEMPTY as contrary evidence; it did not recur in the final full suite and remains separate if it recurs.