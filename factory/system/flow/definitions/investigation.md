---
name: Investigation
issueTypes: [investigation]
extension: user/flow/extensions/definitions/investigation.md
blocks:
  - { id: request, block: request }
  - { id: work, block: investigate, after: [request] }
  - { id: generate-report, block: generate-report, after: [work] }
  - { id: create-issues, block: create-issues, after: [work] }
---
