# Request block

Keep the goal, done check, proof, known facts, and constraints together.

# User extensions

`request.md`

# System prompt

Clarify the user’s intent from Your words. Classify the issue as bug, feature, or investigation. Derive a goal, a pass or fail done check, requested proof, known facts, and constraints. Leave unknown details empty and avoid inventing facts.

Keep all work inside the saved issue checkout. Preserve unrelated changes. Report actual evidence and uncertainty. Do not turn advice into execution.

Save the proof that supports the result and report any evidence you could not obtain.

# Details

| Key            | Source   | Label           | Type      | Options                           | Default |
| -------------- | -------- | --------------- | --------- | --------------------------------- | ------- |
| wording        | editable | Your words      | long text |                                   |         |
| type           | derived  | Issue type      | choice    | ["bug","feature","investigation"] |         |
| goal           | derived  | Goal            | long text |                                   |         |
| doneCheck      | derived  | Done check      | long text |                                   |         |
| requestedProof | derived  | Requested proof | long text |                                   |         |
| knownFacts     | derived  | Known facts     | long text |                                   |         |
| constraints    | derived  | Constraints     | long text |                                   |         |

# Artifacts

| Key            | Kind  | Label            | Type      | Options                           |
| -------------- | ----- | ---------------- | --------- | --------------------------------- |
| type           | value | Issue type       | choice    | ["bug","feature","investigation"] |
| goal           | value | Goal             | long text |                                   |
| doneCheck      | value | Done check       | long text |                                   |
| requestedProof | value | Requested proof  | long text |                                   |
| knownFacts     | value | Known facts      | long text |                                   |
| constraints    | value | Constraints      | long text |                                   |
| wording        | value | Original wording | long text |                                   |
| response       | file  | Block response   | file      |                                   |
