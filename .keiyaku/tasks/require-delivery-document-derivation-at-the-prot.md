---
id: task/require-delivery-document-derivation-at-the-prot
title: Require delivery document derivation at the protocol boundary
state: drop
priority: 1
needs: []
parent: task/审计项目架构边界-重复与-owner-错位
supersedes: []
relates: []
note: Implementation proved the proposed cleanup was representational churn rather than a production-code reduction; Contract abandoned with no source change.
createdAt: 2026-08-18T03:55:57.451Z
updatedAt: 2026-08-18T08:59:25.195Z
---
All production delivery and audit callers provide document derivation at the Library edge. Require it for audit and remove optional-capability checks that production cannot construct.

Deliver already requires the capability. Retain its existing narrow runtime correlation guard when removing that guard would require a larger staging type or new abstraction; this cleanup must reduce production code rather than mechanize an impossible state.

Do not move document decoding into Protocol, change public DeliverInput or AuditInput, or alter missing-Contract, document-moved, verification, or Git behavior.
