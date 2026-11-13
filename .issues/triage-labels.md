# Triage Labels

This file defines this project's local issue lifecycle. State values are exact strings saved in issue reports. Roles connect the lifecycle to the skills' workflow; they are not external tracker labels.

| Role                 | State                | Next state           | Meaning / exit condition                                                                                                                                                             |
| -------------------- | -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ready-for-grilling` | `backlog`            | `to-do`              | Needs clarification; record unanswered questions. Deferral sets `grill_later: true`.                                                                                                 |
| `ready-for-repro`    | `to-do`              | `ready-to-prototype` | Ready to investigate. Advance once evidence and intended behavior support a bounded fix.                                                                                             |
| `ready-to-prototype` | `ready-to-prototype` | `in-progress`        | Optional design experiment. Enter when a recorded design question benefits from a prototype; skip when unnecessary. Advance after user feedback resolves design decisions and scope. |
| `ready-to-fix`       | `in-progress`        | `in-review`          | Ready to implement. Advance once a fix exists.                                                                                                                                       |
| `ready-to-verify`    | `in-review`          | `ready-for-commit`   | Advance after relevant automated checks pass; record outstanding human checks separately. Checks that block dependent work still apply.                                              |
| `ready-for-commit`   | `ready-for-commit`   | `resolved`           | Advance after the selected commit is recorded, or commits are explicitly disabled.                                                                                                   |
| `ready-to-close`     | `resolved`           | `closed`             | Implementation, automated verification, and selected commit complete; final human checks and explicit acceptance gate closure.                                                       |
| `closed`             | `closed`             | —                    | Terminal. Preserve the report and closure reason.                                                                                                                                    |

Edit State and Next state to use your vocabulary. Keep each role and state unique. Add rows with Role `custom` for additional stages, and update the preceding row's Next state to enter them. Give every added stage a concrete exit condition. Use `—` for no next state. Explicit Next state links, not row order, determine progression. Multiple `custom` rows are allowed; the seven required workflow roles each occur once. The optional `ready-to-prototype` role occurs at most once; older files without it remain valid. Features may skip reproduction, and issues that need no design experiment skip prototyping, with the reason recorded. Preserve unrelated custom stages when routing.

For example, insert `custom | qa | resolved | Required QA passed` between `ready-for-commit` and `resolved` by changing the former's Next state to `qa` (format state strings with backticks as above).

With commits disabled, skip only the row with role `ready-for-commit`, following its Next state; retain custom verification or approval stages. Renaming a state requires explicitly migrating reports that use its old value. Unknown states or ambiguous/broken transitions remain unchanged until clarified. These definitions never establish evidence or waive the queue's verification and acceptance requirements.

## Closed reasons

Edit these labels and meanings for your project. Keep IDs stable; `fixed` always
means verified work accepted by the user. Other reasons record a decision to
stop work, without claiming a fix, passing checks, or acceptance. Record the
selected reason and any user details when closing. Setup preserves existing
project files; add this section explicitly to an older project to customize it.

| ID               | Label                  | Meaning                                                                      |
| ---------------- | ---------------------- | ---------------------------------------------------------------------------- |
| fixed            | Fixed                  | The code has been updated, and the bug is verified as solved.                |
| wont-do          | Won’t Do               | The team has decided not to do the work due to impact, cost, or priorities.  |
| duplicate        | Duplicate              | Another issue already tracks the same work; include its ID in the details.   |
| cannot-reproduce | Cannot Reproduce       | We tried but could not reproduce the reported behavior on the current build. |
| incomplete       | Not Enough Information | The report lacks steps, logs, or environment details needed to investigate.  |
| obsolete         | No Longer Relevant     | The feature or code has changed, making the issue irrelevant.                |

## Issue Priorities

Ordered highest first. Edit names, colors, and meanings for your project. Every
issue defaults to Major until a priority is explicitly saved. Keep Major in the
list. Use Orange, Red, Yellow, Green, Pink, or a six-digit hex color. Priority is
independent of lifecycle stage and does not mark any work complete.

| Name        | Color  | Meaning                                                                                 |
| ----------- | ------ | --------------------------------------------------------------------------------------- |
| Showstopper | Orange | The system or application is completely broken, crashed, or entirely inaccessible.      |
| Critical    | Red    | Core functionality is broken, heavily degraded, or causing data loss.                   |
| Major       | Yellow | A significant feature is broken, but the core workflow still works.                     |
| Minor       | Green  | A small inconvenience that does not break actual functionality.                         |
| Suggestion  | Pink   | An idea, enhancement request, or cosmetic improvement rather than broken functionality. |
