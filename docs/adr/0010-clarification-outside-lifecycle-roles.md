# Clarification is not a required lifecycle role

The Clarify/`ready-for-grilling` role is optional. Human clarification and
grilling remain available independently of lifecycle position, as recorded in
[ADR 0001](0001-human-input-separate-from-lifecycle.md). Projects may remove the
role from their local lifecycle table without renaming saved states or rewriting
report history.

Capture validates the remaining configured roles and explicit `Next` links. When
the optional role is absent, captured proposals skip only lifecycle stages that
are actually present; their saved clarification and grilling records remain
separate from those stage outcomes. Existing projects that retain the role keep
their current behavior until they update their local lifecycle table.
