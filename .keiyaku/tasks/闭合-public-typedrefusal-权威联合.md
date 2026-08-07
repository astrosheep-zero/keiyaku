---
id: task/闭合-public-typedrefusal-权威联合
title: 闭合-public-TypedRefusal-权威联合
state: open
priority: 1
needs: []
parent: null
supersedes: []
relates: []
contractId: null
---
Independent review confirmed VerificationDeclarationRefusal currently has four owners: verification defines, protocol re-exports, library unions/re-exports, package root exports, while public-api does not explicitly own the named type. Settle the refusal shape in public-api and export from one package-root owner, or keep the internal name private and include only its documented structural union member.