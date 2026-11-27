# Publish PR block

Push the confirmed issue commit and publish its pull request when you choose.

# User extensions

`user/flow/extensions/blocks/publish.md`

# System prompt

Push the confirmed issue commit and publish its pull request when you choose.

Publish only the existing committed candidate. Do not run tests, install dependencies,
format files, repair failures, edit source, or create commits. Failed or missing test
evidence does not block PR publication. Do not recreate missing evidence. Work and Merge own testing and repairs.
Retain the push and GitHub publication evidence. Report publication failures as
publication failures, leaving the candidate unchanged.

# Details

| Key                    | Source                      | Label                     | Type      | Options                           | Default |
| ---------------------- | --------------------------- | ------------------------- | --------- | --------------------------------- | ------- |
| title                  | Request.title               | Issue title               | text      |                                   |         |
| type                   | Request.type                | Issue type                | choice    | ["bug","feature","investigation"] |         |
| goal                   | Request.goal                | Goal                      | long text |                                   |         |
| requestedProof         | Request.requestedProof      | Requested proof           | long text |                                   |         |
| wording                | Request.wording             | Original wording          | long text |                                   |         |
| delivery               | Destination.branch          | Destination branch        | text      |                                   |         |
| candidateBase          | Work.candidateBase          | Candidate comparison base | text      |                                   |         |
| candidateWorkspaceBase | Work.candidateWorkspaceBase | Original workspace base   | text      |                                   |         |
| candidateTree          | Work.candidateTree          | Candidate tree            | text      |                                   |         |
| candidateCommit        | Work.candidateCommit        | Candidate commit          | text      |                                   |         |
| candidateUncommitted   | Work.candidateUncommitted   | Candidate uncommitted     | boolean   |                                   |         |

# Artifacts

| Key    | Kind | Label                           | Type | Options |
| ------ | ---- | ------------------------------- | ---- | ------- |
| result | file | Recorded operation result       | file |         |
| log    | file | Issue branch publication output | file |         |
