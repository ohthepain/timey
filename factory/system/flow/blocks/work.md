# Work block

Complete only this block using the selected skill.

# Skill list

- poteto-mode
- arena
- swarm

# User extensions

`user/flow/extensions/blocks/work.md`

# System prompt

Install dependencies. Perform the requested work.

Use the supplied comparison base to identify issue changes. Before running any
test suite, run the supplied formatting and audit command in the issue checkout.
It formats changed files first and checks Fallow for the issue changes. Fix new
or worsened Fallow findings before testing. Run it again before tests if you edit
the source.

Run only focused tests that cover the changed behavior and Requested Proof.
If a local-server check fails with `listen EPERM` or `listen EACCES`, request
native execution permission for that exact command and rerun it after approval.
Stop if the request is denied or permission requests are unavailable. Report the
permission restriction and the proof it prevented, rather than a project test
failure. Do not repeat the restricted command unchanged.

Run individual test files or scenarios directly when an aggregate command would
also run unrelated tests. Leave full suites such as `pnpm run test:factory` and
full candidate verification to the delivery checks. Add a focused test when there
is no suitable existing test. Report the commands and what they demonstrated. When a
failure may already exist on the supplied destination revision, reproduce the
same failure there in an isolated checkout. Record the revision and matching
failure and continue. Report issue-specific failures that you cannot repair as
blockers. Factory checks formatting and Fallow again after the response.

In the final `flow-result` JSON, include a top-level `focusedTests` array
with the passing focused test commands Merge should rerun. Use argument
arrays without shell syntax or environment assignments. Supported commands
include `["node","--test","scripts/example.check.mjs"]`,
`["node","scripts/flow-browser.mjs","--project-discuss"]`, a named focused
`pnpm run test:…` script, and `pnpm exec vp test run` with specific test paths.
Use `"focusedTests": []` when no focused automated tests apply, and explain why.

Keep all work inside the saved issue checkout. Preserve unrelated changes. Report actual evidence and uncertainty. Do not turn advice into execution.

Use Requested Proof to check the current result. In each response, describe what
you did and what you observed. Retain a supporting file as the `proof` artifact
when one is available. Save temporary evidence files in an ignored location inside
the checkout. Report any gap and why the proof could not be collected in the
response. Use the structured failure field for blockers to completing the work.

When a project check prevents tests or Requested Proof, lead the response and
structured failure with the failed command and its relevant diagnostic. State
whether the failure also occurs on the supplied destination revision, or whether
that is still unknown. Then explain which tests or proof could not run because of
that failure. A missing-proof message alone does not explain the blocker.

# Details

| Key            | Source                 | Label           | Type      | Options                           | Default |
| -------------- | ---------------------- | --------------- | --------- | --------------------------------- | ------- |
| title          | issue.title            | Issue title     | text      |                                   |         |
| report         | issue.content          | Issue report    | long text |                                   |         |
| type           | Request.type           | Issue type      | choice    | ["bug","feature","investigation"] |         |
| goal           | Request.goal           | Goal            | long text |                                   |         |
| requestedProof | Request.requestedProof | Requested proof | long text |                                   |         |
| knownFacts     | Request.knownFacts     | Known facts     | long text |                                   |         |
| constraints    | Request.constraints    | Constraints     | long text |                                   |         |

# Artifacts

| Key                  | Kind  | Label                    | Type    | Options |
| -------------------- | ----- | ------------------------ | ------- | ------- |
| response             | file  | Block response           | file    |         |
| proof                | file  | Requested proof evidence | file    |         |
| candidate            | value | Candidate commit         | text    |         |
| candidateBase        | value | Candidate base           | text    |         |
| candidateTree        | value | Candidate tree           | text    |         |
| candidateCommit      | value | Candidate commit         | text    |         |
| candidateUncommitted | value | Candidate uncommitted    | boolean |         |
