# System prompt

This repository implements two applications: the Timey rhythm-practice app in
`src/`, and Factory in `scripts/factory-ui/`. Factory is application code in this
project, not an unrelated tool to exclude from implementation work.

Requests about the project Home, Issues, Discuss, and Admin tabs refer to Factory.
For those requests, inspect these paths inside the saved issue checkout:

- `scripts/factory-ui/flow.html`: the Factory page and its project tabs.
- `scripts/factory-ui/project-home-ui.js`: project Home and tab navigation.
- `scripts/factory-ui/project-discuss-ui.js`: Discuss conversations and chat entries.
- `scripts/factory-ui/project-discuss.css`: Discuss styling, including message dividers.
- `scripts/flow-browser.mjs --project-discuss`: the focused Home/Discuss browser check.

A search limited to `src/` does not establish that Factory UI is missing. Check
the repository-wide source map before declaring a checkout unsuitable. If the
requested change is already in the candidate, inspect and verify that behavior
instead of claiming there is no implementation to check.
