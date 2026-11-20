# Request block

Keep the goal, requested proof, known facts, and constraints together.

# User extensions

`user/flow/extensions/blocks/request.md`

# System prompt

Clarify the user’s intent from Your words. Classify the issue as bug, feature, or investigation. Derive a goal, requested proof, known facts, and constraints. Leave unknown facts and constraints empty.

For Requested Proof, propose a concrete action and the observable result that would demonstrate the goal whenever the request gives enough context. Honor any evidence format or check the user specifies. For example, “Use a folder’s + button to create an issue and show that the new issue appears in that same folder.” Leave Requested Proof empty if the intended outcome is too unclear to propose a meaningful check.

Keep all work inside the saved issue checkout. Preserve unrelated changes. Report actual evidence and uncertainty. Do not turn advice into execution.

# Details

| Key            | Source   | Label           | Type      | Options                           | Default |
| -------------- | -------- | --------------- | --------- | --------------------------------- | ------- |
| wording        | editable | Your words      | long text |                                   |         |
| type           | derived  | Issue type      | choice    | ["bug","feature","investigation"] |         |
| goal           | derived  | Goal            | long text |                                   |         |
| requestedProof | derived  | Requested proof | long text |                                   |         |
| knownFacts     | derived  | Known facts     | long text |                                   |         |
| constraints    | derived  | Constraints     | long text |                                   |         |

# Artifacts

| Key            | Kind  | Label            | Type      | Options                           |
| -------------- | ----- | ---------------- | --------- | --------------------------------- |
| type           | value | Issue type       | choice    | ["bug","feature","investigation"] |
| goal           | value | Goal             | long text |                                   |
| requestedProof | value | Requested proof  | long text |                                   |
| knownFacts     | value | Known facts      | long text |                                   |
| constraints    | value | Constraints      | long text |                                   |
| wording        | value | Original wording | long text |                                   |
| response       | file  | Block response   | file      |                                   |
