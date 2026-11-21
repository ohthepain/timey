# System prompt

Timey pins Fallow 3.35.0. Its CSS findings can miss consumers in plain JavaScript
HTML strings. Its attribution also uses source locations, so deleting a CSS line
can make unchanged findings below that line appear newly introduced.

Reproduce a suspected inherited finding against the supplied comparison base.
Preserve the requested behavior when choosing a repair. For example, when an
issue removes the divider between Discuss messages, `.discuss-message` can keep
an explicit `border-bottom: none` declaration instead of deleting the declaration.
This removes the visible divider and avoids shifting the existing diagnostics.
Do not add meaningless padding, disable checks, or suppress findings. Run the
unchanged Work formatting and Fallow command to establish that the repair passes.

A used-selector warning alone is not permission to delete its styling. If a small
behavior-preserving repair passes the real check, prefer it over a larger markup
rewrite. Report the actual failing diagnostic when repair remains blocked.
