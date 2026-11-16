Fetch the starting branch and merge it into the issue branch. Save local changes in a commit first when there are incoming changes.

# User extensions

`factory/ui/extensions/flow/blocks/update-branch.md`

# Details

| Key            | Source                | Label           | Type | Options | Default |
| -------------- | --------------------- | --------------- | ---- | ------- | ------- |
| startingBranch | Starting point.branch | Starting branch | text |         |         |

# Artifacts

| Key          | Kind | Label                         | Type | Options |
| ------------ | ---- | ----------------------------- | ---- | ------- |
| mergeMessage | file | Merge message                 | file |         |
| result       | file | Git ancestry proof            | file |         |
| log          | file | Branch fetch and merge output | file |         |
