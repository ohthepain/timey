---
name: Standard delivery
issueTypes: [bug, feature]
extension: user/flow/extensions/definitions/delivery.md
blocks:
  - { id: request, block: request }
  - { id: work, block: work, after: [request] }
  - { id: publish, block: publish, after: [work] }
  - { id: merge, block: merge, after: [publish] }
  - { id: close, block: close, after: [merge] }
---
