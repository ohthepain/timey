import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const requirements = z.array(
  z
    .object({
      name: z.string().min(1),
      source: z.url().optional(),
      skills: z.array(z.string().min(1)).min(1),
    })
    .strict()
);

export function readRequiredSkillSets(root) {
  const path = join(root, 'user/skills/requirements.json');
  return existsSync(path) ? requirements.parse(JSON.parse(readFileSync(path, 'utf8'))) : [];
}

export function skillSetup(available, required, root = process.cwd()) {
  const requiredSkillSets = readRequiredSkillSets(root);
  const names = new Set(available.map((skill) => skill.name));
  const sets = requiredSkillSets.map((set) => ({
    ...set,
    missing: set.skills.filter((name) => (!required || required.includes(name)) && !names.has(name)),
  }));
  const missing = sets.filter((set) => set.missing.length);
  return {
    sets,
    needed: missing.length > 0,
    prompt: missing.length
      ? 'Set up the missing supported skill collections for this project in Codex:\n' +
        missing
          .map(
            (set) =>
              `- ${set.name}: ${set.source || 'project-owned skill; inspect the project sources'} (missing skills: ${set.missing.join(', ')})`
          )
          .join('\n') +
        '\nRead the official installation instructions and install the collections in a location discoverable by Codex for this project. Preserve existing custom skills; do not overwrite conflicts. Use the factory skill-installer and install complete skill folders into this project’s user/skills directory. Check discovery afterward and report what was installed and anything still missing. Respect ordinary permission prompts. Do not change model preferences or start other workflows.'
      : '',
  };
}
