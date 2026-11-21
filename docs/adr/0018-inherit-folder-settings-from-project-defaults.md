---
status: accepted
---

# Inherit folder settings from project defaults

Store project defaults in a tracked root `folder.md` and inherit missing or
`default` values through actual parent folders. This lets teams share settings
with their folder structure while preserving explicit issue overrides and the
resolved settings of work already started.

Keep `factory/system/folder.md` as the field reference, excluded from settings
discovery. Project settings and missing-field repair cover every field listed
there. The default issue folder is a project-wide choice declared on an actual
issue folder, so its flag is excluded from that reference and never inherits.

The [folder settings design](../plans/folder-settings.md) records the confirmed
behavior and remaining interview questions. This decision does not claim that
the implementation has changed.
