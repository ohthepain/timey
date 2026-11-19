import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';
import { fileURLToPath } from 'node:url';
import { digest, requireThat } from './common.mjs';

const maxSelections = 8;

export async function listAvailableSkills(connection, cwd) {
  await connection.ready();
  const result = await connection.call('skills/list', { cwds: [cwd], forceReload: true });
  const found = (result.data || [])
    .flatMap((entry) => (entry.skills || []).map((skill) => ({ skill, entry })))
    .filter(({ skill }) => skill.enabled && typeof skill.name === 'string' && typeof skill.path === 'string')
    .map(({ skill, entry }) => ({
      name: skill.name,
      path: skill.path,
      description: String(skill.shortDescription || skill.description || 'Codex skill').slice(0, 180),
      source: sourceLabel(skill.source || entry.source, skill.path, cwd),
      sha256: digest(readFileSync(skill.path)),
      ...skillPolicy(skill.path),
    }));
  const directories = [
    { directory: fileURLToPath(new URL('../../factory/system/skills/', import.meta.url)), source: 'Factory' },
    { directory: join(cwd, 'user/skills'), source: 'Project' },
  ];
  for (const { directory: local, source } of directories) {
    if (!existsSync(local)) continue;
    for (const directory of readdirSync(local, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const path = join(local, directory.name, 'SKILL.md');
      if (!existsSync(path) || found.some((entry) => entry.path === path)) continue;
      const content = readFileSync(path, 'utf8');
      const metadata = skillMetadata(content);
      if (typeof metadata.name !== 'string' || !metadata.name) continue;
      const duplicate = found.findIndex((entry) => entry.name === metadata.name);
      if (duplicate !== -1) {
        if (source !== 'Factory') continue;
        found.splice(duplicate, 1);
      }
      found.push({
        name: metadata.name,
        path,
        description: String(metadata.description || 'Project skill').slice(0, 180),
        source,
        sha256: digest(content),
        ...skillPolicy(path),
      });
    }
  }
  return found;
}

function skillMetadata(content) {
  const yaml = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return yaml ? parse(yaml) || {} : {};
}

function skillPolicy(path) {
  const metadata = skillMetadata(readFileSync(path, 'utf8'));
  const configPath = join(dirname(path), 'agents/openai.yaml');
  const config = existsSync(configPath) ? parse(readFileSync(configPath, 'utf8')) : null;
  return {
    displayName: config?.interface?.display_name || metadata.name,
    allowImplicitInvocation:
      metadata['disable-model-invocation'] !== true && config?.policy?.allow_implicit_invocation !== false,
  };
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
  return skills.map(({ name, path, source }) =>
    source === 'Factory' || source === 'Project'
      ? {
          type: 'text',
          text: `Selected project skill: ${name}\nSkill file: ${path}\nResolve supporting files relative to this skill file. Follow these instructions for this request:\n\n${readFileSync(path, 'utf8')}`,
        }
      : { type: 'skill', name, path }
  );
}

export function publicSkills(skills) {
  return skills.map(({ name, description, source, displayName, allowImplicitInvocation }) => ({
    name,
    description,
    source,
    displayName,
    allowImplicitInvocation,
    icon: '✦',
  }));
}

function sourceFor(path, cwd) {
  const personal = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills') + sep;
  if (path.startsWith(personal)) return 'Personal';
  const projectSkills = [join(cwd, '.agents', 'skills'), join(cwd, 'user', 'skills')];
  return projectSkills.some((directory) => !relative(directory, path).startsWith('..')) ? 'Project' : 'Codex';
}

function sourceLabel(value, path, cwd) {
  const label = typeof value === 'string' ? value : value?.label || value?.name || value?.kind || value?.type;
  if (!label) return sourceFor(path, cwd);
  if (/personal|user/i.test(label)) return 'Personal';
  if (/project|workspace|repository/i.test(label)) return 'Project';
  return String(label).slice(0, 60);
}
