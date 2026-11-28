# Issue annotations and sequential master work

This plan starts with a fresh Factory data set. Deliver it as one master issue
with three sub-issues in the order below. Each sub-issue has its own acceptance
checks. Automatic Work gating and asset reference tracking are future work.

## 1. Build shared annotation infrastructure

Extend the existing Coordination-backed annotation store with typed
annotations. A type can declare a target issue and whether an active annotation
holds a reference to it. An annotation that holds a reference contributes one
to its target's incoming count. Labels, comments, and the derived
**Investigation** annotation contribute zero. A related issue mentioned in a
comment contributes zero.
[Current annotation storage](../../scripts/factory-ui/issue-annotations.mjs)

Store the annotation by its source issue and index retaining annotations by
target issue. Update the record and index together through guarded
Coordination writes. Use stable IDs, validate targets, reject duplicate active
links of the same type, and make retries safe. Derive counts from active
references. Batch counts for visible issue rows and show the named source
and purpose in issue details. Permanent Delete uses the same incoming lookup
under its existing deletion guard. Archive keeps active references. Clearing an
annotation or deleting its source releases the reference once.

Verify add, clear, retry, delete, and concurrent writes across two runners.
Add unrelated issues and show that annotation and incoming-reference reads
stay scoped to the affected issue IDs.

## 2. Show dependencies, review holds, and Factory restart requirements

Add these typed annotations to issue details and the relevant issue rows.

| Annotation                   | Purpose                                                                                                                                                                                           | Issue reference            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **Depends on**               | Points from a dependent issue to its prerequisite and gives the reader the intended order. Show the link in both directions.                                                                      | One on the prerequisite    |
| **Retains for review**       | Points from an investigation to an issue it needs to keep, optionally identifying an attempt or evidence. The investigation clears it when the review is done or has a verified snapshot it owns. | One on the retained issue  |
| **Requires Factory version** | Adds a version or commit requirement to a dependency that uses running Factory functionality. Show the required version or commit and the executing instance's reported startup revision.         | Zero additional references |

Keep one **Depends on** type. The runtime annotation adds information to it
and uses the underlying dependency's single reference. A merge can be visible
while the old Factory is still running. Show that a restart or deployment is
needed when the observed runtime is known to lack the change. Show an unknown
status when the running identity cannot establish availability. Use the existing
runtime identity and restart controls. The operator decides when to restart
or deploy. [Runtime identity](../agents/factory-ui.md#delivery-finalization-and-runtime-identity)

Verify dependency and reference visibility from both issue pages. Check a
merged change against a stale instance, a restart onto the same version,
and an instance running the required version. These annotations communicate
order and runtime readiness. Existing Work entry points keep their current
behavior in this release.

## 3. Use membership annotations for Sequential masters

Use the existing master and sub-issue workflow. Store active membership as
**Contains sub-issue** annotations owned by the master, with one reference to
each child and a position for Sequential Work. Use that position for the
master's execution order. The issue UI shows the ordered children, each
child's master, and the master's contribution to its reference count.

Route attach, detach, and reorder through existing guarded grouping controls.
Enforce one master per child, matching stores, and current eligibility rules.
Preserve Work and Close scope snapshots, per-child proof, and **Fixed by**
closure. Replace the active membership and order fields once grouping reads,
execution, and closure use the annotations.

Verify create, attach, reorder, detach, resume after a blocked child, and
**Fixed by** closure through Factory. Confirm that a child cannot be deleted
while its master holds the reference and that lookup work stays scoped as
unrelated issues are added. [Existing grouping workflow](issue-folder-strategies.md)
[Master acceptance](../adr/0014-accept-sub-issues-through-the-master.md)

## Future work

Enforce prerequisites at Work admission once the dependency and runtime
annotations are in use. At that point, Work waits for verified delivery on the
destination it needs and, where required, the appropriate running Factory
version. Planning can continue, and closure without a fix leaves the dependency
unresolved. Verify the check on the executing runner before dispatch.

Record asset ownership on publication. Keep owner references separate from
physical copies, and use indexed lookups for Asset Storage and cleanup. Reserve
S3 listings for explicit reconciliation.
