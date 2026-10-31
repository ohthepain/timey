import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { digest, requireThat } from './common.mjs';

const maxSelections = 8;

export async function listAvailableSkills(connection, cwd) {
  await connection.ready();
  const result = await connection.call('skills/list', { cwds: [cwd], forceReload: true });
  return (result.data || [])
    .flatMap((entry) => (entry.skills || []).map((skill) => ({ skill, entry })))
    .filter(({ skill }) => skill.enabled && typeof skill.name === 'string' && typeof skill.path === 'string')
    .map(({ skill, entry }) => ({
      name: skill.name,
      path: skill.path,
      description: String(skill.shortDescription || skill.description || 'Codex skill').slice(0, 180),
      source: sourceLabel(skill.source || entry.source, skill.path, cwd),
      sha256: digest(readFileSync(skill.path)),
    }));
}

export function selectedSkills(skills, names) {
  requireThat(Array.isArray(names) && names.length <= maxSelections, `Choose up to ${maxSelections} skills.`);
  const unique = [...new Set(names)];
  requireThat(unique.length === names.length, 'A skill can only be selected once.');
  return unique.map((name) => {
    const skill = skills.find((item) => item.name === name);
    requireThat(skill, 'Refresh the skill list and choose an available skill.');
    return skill;
  });
}

export function skillInputs(skills) {
  return skills.map(({ name, path }) => ({ type: 'skill', name, path }));
}

export function publicSkills(skills) {
  return skills.map(({ name, description, source }) => ({ name, description, source, icon: '✦' }));
}

function sourceFor(path, cwd) {
  const personal = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills') + sep;
  if (path.startsWith(personal)) return 'Personal';
  if (relative(join(cwd, '.agents', 'skills'), path).startsWith('..')) return 'Codex';
  return 'Project';
}

function sourceLabel(value, path, cwd) {
  const label = typeof value === 'string' ? value : value?.label || value?.name || value?.kind || value?.type;
  if (!label) return sourceFor(path, cwd);
  if (/personal|user/i.test(label)) return 'Personal';
  if (/project|workspace|repository/i.test(label)) return 'Project';
  return String(label).slice(0, 60);
}
