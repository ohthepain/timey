---
name: Investigation
issueTypes: [investigation]
extension: factory/ui/extensions/flow/definitions/investigation.md
blocks:
  - { id: request, block: request }
  - { id: work, block: understand, after: [request] }
  - { id: close, block: close, after: [work], suggested: true }
---
