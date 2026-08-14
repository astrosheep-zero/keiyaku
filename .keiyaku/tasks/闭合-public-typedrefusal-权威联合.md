---
id: task/闭合-public-typedrefusal-权威联合
title: 闭合-public-TypedRefusal-权威联合
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: Current package root keeps VerificationDeclarationRefusal private and public export tests enforce the chosen closure; independent review by aku/review-akuma/c3457e95 found no remaining delivery.
createdAt: 2026-08-06T23:09:57.203Z
updatedAt: 2026-08-14T00:49:30.386Z
---
Independent review confirmed VerificationDeclarationRefusal currently has four owners: verification defines, protocol re-exports, library unions/re-exports, package root exports, while public-api does not explicitly own the named type. Settle the refusal shape in public-api and export from one package-root owner, or keep the internal name private and include only its documented structural union member.