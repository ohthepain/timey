import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

const name = z.string().regex(/^[\w.:-]{1,160}$/);
const schema = z.record(
  z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  z
    .object({
      skills: z.array(name).default([]),
      defaultSkill: name.nullable().optional(),
    })
    .strict()
);

export function blockSkillSettings(
  project,
  userPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'timey/block-skills.json')
) {
  const read = (path) => (path && existsSync(path) ? schema.parse(JSON.parse(readFileSync(path, 'utf8'))) : {});
  const user = read(userPath);
  const local = read(project && join(project, 'user/flow/block-skills.json'));
  return { user, project: local };
}

export function resolveBlockSkills(id, definition, settings) {
  const user = settings.user[id] || {};
  const project = settings.project[id] || {};
  const skills = [...new Set([...definition.skills, ...(user.skills || []), ...(project.skills || [])])];
  const defaultSkill =
    project.defaultSkill !== undefined
      ? project.defaultSkill
      : user.defaultSkill !== undefined
        ? user.defaultSkill
        : definition.defaultSkill;
  if (defaultSkill && !skills.includes(defaultSkill))
    throw Error(`Default skill ${defaultSkill} must be listed for block ${id}.`);
  return { skills, defaultSkill };
}
