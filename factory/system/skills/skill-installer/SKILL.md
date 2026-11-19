---
name: skill-installer
description: Install skills or skill collections for Factory into the current project's user/skills folder. Use for Set up skills or requests to install project skills from a repository.
---

# Install Factory skills

Install into `user/skills/<skill-name>/` under the current project working folder.
Factory discovers this folder directly. This skill is self-contained: use ordinary
file and shell tools and the source repository's installation documentation.

## Sources

When the person names one of these collections, use its official source without
asking for a link:

- Matt Pocock skills: https://github.com/mattpocock/skills. Inspect `skills/` and
  the README for the current collection layout.
- pstack by poteto: https://github.com/cursor/plugins/tree/main/pstack. Inspect
  `pstack/skills/` and `pstack/README.md` for the current collection layout.

For another named collection, find its official repository before asking the
person for a link. If the source cannot be established, ask for it.

## Install

1. Resolve the current project folder and inspect its `user/skills` directory.
   List what is already installed before changing files.
2. Fetch the requested official repository into a temporary directory, for example
   with `git clone --depth 1`. Use normal permission prompts for network access.
   Read its README and locate the requested folders containing `SKILL.md`.
   A request for a collection means all of its skill folders, unless narrowed.
3. Copy each complete skill folder, including its scripts, references, assets and
   metadata, to `user/skills/<skill-name>/`. Preserve relative references between
   sibling skills. Do not copy just SKILL.md when it has supporting resources.
   If a skill references collection resources outside these folders, include those
   resources inside the project and adjust the references to their project paths.
4. Keep existing custom skills. Skip identical installed content. If a destination
   differs, explain the conflict and ask before replacing it. Do not run a vendor
   installer that writes to another agent's personal directory. Adapt its steps
   to the project destination instead. Installing does not authorize starting the
   skills' workflows or changing model preferences.
5. Verify each installed folder has valid YAML name and description metadata in
   SKILL.md and that its referenced local resources exist. Check factory skill
   discovery if available; otherwise report the file checks and ask the person
   to use Refresh skills in Discuss. Report the installed names, project paths,
   source revision and anything skipped or still missing. Clean up the temporary
   checkout after verification.

Selecting this skill supplies instructions. Installation starts only from the
person's request or the explicit Set up skills action. It requires no API key.
