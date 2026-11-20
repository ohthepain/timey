---
name: project-investigate
description: Create, configure, discuss, run, retry, or stop an investigation of this project's codebase or working processes.
---

Use the registered `project_home` tool for the current branch and folder choices,
then `project_investigation` for the requested operation. Creation makes an idle
investigation issue; run it only when the person requests execution. Keep its
issue ID and link in the response.

A discussion of investigation goals can use `investigation-discuss`; save the
reviewed configuration with `investigation-save`. A repeated full run or retry
uses the existing investigation controls and retains their approval rules.

Return the direct command result and issue link. Investigation progress,
findings, follow-up issues, and later runs remain in the investigation interface.
Do not import its conversation, subscribe to progress, or implement an alternative
runner. If these tools are unavailable in the current chat, identify that limitation
and direct the person to the project's Discuss tab; never fabricate a tool result.
