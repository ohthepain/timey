// Core skills used to detect whether each supported collection is ready.
export const requiredSkillSets = [
  {
    name: 'pstack by poteto',
    source: 'https://github.com/cursor/plugins/tree/main/pstack',
    skills: ['poteto-mode', 'setup-pstack', 'grilling'],
  },
  {
    name: 'Matt Pocock skills',
    source: 'https://github.com/mattpocock/skills',
    skills: ['grill-me', 'grill-with-docs'],
  },
];

export function skillSetup(available) {
  const names = new Set(available.map((skill) => skill.name));
  const sets = requiredSkillSets.map((set) => ({ ...set, missing: set.skills.filter((name) => !names.has(name)) }));
  const missing = sets.filter((set) => set.missing.length);
  return {
    sets,
    needed: missing.length > 0,
    prompt: missing.length
      ? 'Set up the missing supported skill collections for this project in Codex:\n' +
        missing
          .map((set) => `- ${set.name}: ${set.source} (missing core skills: ${set.missing.join(', ')})`)
          .join('\n') +
        '\nRead the official installation instructions and install the collections in a location discoverable by Codex for this project. Preserve existing custom skills; do not overwrite conflicts. Use the skill-installer skill if available. Check discovery afterward and report what was installed and anything still missing. Respect ordinary permission prompts. Do not change model preferences or start other workflows.'
      : '',
  };
}
