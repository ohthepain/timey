Fetch the starting branch and merge it into the issue branch. Save local changes in a commit first when there are incoming changes. If there is already a merge in progress, then abort the merge first.

# User extensions

`user/flow/extensions/blocks/update-branch.md`

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
