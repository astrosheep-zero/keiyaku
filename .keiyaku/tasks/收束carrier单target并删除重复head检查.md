---
id: task/收束carrier单target并删除重复head检查
title: 收束carrier单target并删除重复head检查
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-07T04:47:52.798Z
updatedAt: 2026-08-07T11:29:07.456Z
contractId: null
---
Offer.target is singular but carrier admission wraps it in a 0/1 array and repeatedly indexes operations[0]. Keep the normalized target as RefOperation|null through publication/failure attribution. Also remove the duplicate initial headMoved calculation immediately repeated by the first loop iteration. Preserve post-publication target CAS attribution and all outer outcomes.