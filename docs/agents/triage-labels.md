# Matt Pocock triage classifications

This file adapts Matt Pocock skills that refer to five canonical triage roles.
The local `$issue`, `$issues`, and `$fix-issues` lifecycle is defined separately
in `.issues/triage-labels.md`.

- **Local workflow role:** maps an operation such as `ready-to-fix` to a saved
  lifecycle state such as `in-progress`, using `.issues/triage-labels.md`.
- **Lifecycle state:** the report's `state` field; controls queue progression.
- **Matt Pocock triage role:** optional `triage_role` metadata from the table
  below; records a classification only.

For Matt Pocock triage, retain these metadata values:

| Matt Pocock role | `triage_role` value |
| --- | --- |
| needs-triage | needs-triage |
| needs-info | needs-info |
| ready-for-agent | ready-for-agent |
| ready-for-human | ready-for-human |
| wontfix | wontfix |

Record `triage_role` only when a skill explicitly performs Matt Pocock triage.
Local queue operations need only their lifecycle state and required queue metadata.

There is no automatic mapping between these classifications and lifecycle states.
For example, `ready-for-agent` does not establish reproduction or verification,
and `wontfix` does not itself close a report. Read `.issues/triage-labels.md` and
follow the local queue contract before changing `state`. A triage classification
alone does not authorize implementation or closure.

When a Matt Pocock skill says “state role,” “apply a label,” or “move to
ready-for-agent,” it means `triage_role` here. Store its category roles (`bug`
or `enhancement`) separately as `category`. These optional fields are repo
adapter conventions, not built-in local queue features.

For triage discovery, query `triage_role` (missing, `needs-triage`, or
`needs-info` with subsequent reporter input), not the lifecycle `state`.
Do not require these fields on reports captured through the local skills.
For a `wontfix` recommendation, record the reason; apply closure only when
authorized under the local queue contract. A classification command alone
authorizes changing classification, not closing or deleting a report.

