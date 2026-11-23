---
fields:
  storage_profile:
    label: Issue storage profile
    kind: storage-profile
    fallback: files
  branch:
    label: Target branch
    kind: branch
    fallback: dev
  skill:
    label: Skill
    kind: skill
    fallback: none
    choices:
      - value: none
        label: No issue-wide skill
  model:
    label: Model
    kind: choice
    fallback: gpt-6-luna
    choices:
      - value: gpt-6-luna
        label: GPT-6 Luna
        description: Fast and efficient for focused, frequent work.
      - value: gpt-6.1-sol
        label: GPT-6.1 Sol
        description: Near-Astra capability for complex work at lower cost.
      - value: gpt-6.1-terra
        label: GPT-6.1 Terra
        description: Fast visual reasoning, precise computer use, and clear writing.
      - value: gpt-6-astra
        label: GPT-6 Astra
        description: The most capable choice for demanding reasoning and coding.
      - value: anthropic:sonnet
        label: Claude Sonnet
        description: Runs the installed Claude Code agent with your configured account.
      - value: anthropic:opus
        label: Claude Opus
        description: Runs the installed Claude Code agent with your configured account.
      - value: google:pro
        label: Gemini Pro
        description: Runs the installed Gemini CLI agent with your configured account.
      - value: google:flash
        label: Gemini Flash
        description: Runs the installed Gemini CLI agent with your configured account.
  effort:
    label: Effort
    kind: choice
    fallback: medium
    choices:
      - value: low
        label: Low
      - value: medium
        label: Medium
      - value: high
        label: High
      - value: max
        label: Max
  selection_strategy:
    label: Selection strategy
    kind: strategy
    fallback: same-blast-radius
    choices:
      - value: same-blast-radius
        label: Same blast radius
      - value: different-blast-radii
        label: Different blast radii
---

# Folder settings reference

This file lists the inherited fields and their possible values. It does not
configure this directory or any other folder. Add new inherited fields to this
reference so project settings, folder controls, and missing-field repair include
them together.

Missing fields and `default` inherit through parent folders, then root `folder.md`,
then the built-in fallback listed above. A target branch accepts a valid Git branch
name. Skill choices also include installed and project skills. Selection strategy
choices also include Markdown files under `user/selection-strategies/`.

`is_default_folder` is folder-specific metadata and is deliberately excluded from
the inherited fields. It never inherits. A missing flag means false. Stable folder
`id` and optional `description` are also metadata, rather than inherited settings.
