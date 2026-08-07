---
id: task/复用-admission-的-frozen-journal-bytes
title: 复用 admission 的 frozen journal bytes
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
contractId: null
---
One semantic attempt already reads and canonically decodes every targeted journal in carrier observation. carrier/admission.ts buildOffer then reads the same blobs and decodeJournal again solely to append canonical bytes. Carry the already frozen raw canonical journal bytes through the private carrier observation/admission boundary so one snapshot has one physical read and one canonical decode. Preserve corruption validation and exact original bytes; do not re-encode entries, broaden package API, or introduce a second cache/state authority. Verify Git/blob read counts on a multi-contract claimed offer.