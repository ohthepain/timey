---
name: Standard delivery
issueTypes: [bug, feature]
extension: factory/ui/extensions/flow/definitions/delivery.md
blocks:
  - { id: request, block: request }
  - { id: work, block: work, after: [request] }
  - { id: publish, block: publish, after: [work], suggested: true }
  - { id: merge, block: merge, after: [publish], suggested: true }
  - { id: close, block: close, after: [merge], suggested: true }
---
