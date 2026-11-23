import MarkdownIt from 'markdown-it';
import { existsSync, readFileSync, mkdirSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
const markdown = new MarkdownIt();

export function skillEntries(path, section) {
  const entries = section
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('<!--'))
    .map((line) => {
      const name = /^ {0,3}[-+*]\s+`?([\w.:-]{1,160})`?[ \t]*$/.exec(line)?.[1];
      if (name) return { name };
      const link = /^ {0,3}[-+*]\s+\[([\w.:-]{1,160})\]\(([^\s)]+)\)[ \t]*$/.exec(line);
      return link
        ? { name: link[1], source: /^https?:\/\//.test(link[2]) ? link[2] : resolve(dirname(path), link[2]) }
        : null;
    });
  if (
    entries.some((entry) => !entry || ['none', '__setup_skills__', '__add_skill__'].includes(entry.name)) ||
    new Set(entries.map((entry) => entry.name)).size !== entries.length
  )
    throw Error(path + ' needs one unique skill name per bullet under Skill list.');
  return entries;
}

export function markdownSkillEntries(path, text) {
  const tokens = markdown.parse(text, {});
  const headings = tokens
    .map((token, i) => ({ token, i }))
    .filter(({ token }) => token.type === 'heading_open' && token.tag === 'h1' && token.level === 0);
  const matches = headings.filter(({ i }) => tokens[i + 1].content.toLowerCase() === 'skill list');
  if (matches.length > 1) throw Error(path + ' repeats Skill list.');
  if (!matches.length) return [];
  const index = headings.indexOf(matches[0]);
  const lines = text.split(/\r?\n/);
  return skillEntries(path, lines.slice(matches[0].token.map[1], headings[index + 1]?.token.map[0]).join('\n'));
}

export function personalSkillExtension(relative) {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'timey', relative);
}
export function readSkillExtension(path) {
  return existsSync(path) ? markdownSkillEntries(path, readFileSync(path, 'utf8')) : [];
}
export function ensureSkillExtension(path) {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) throw Error('Choose a regular Markdown extension file.');
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '# Skill list\n\n<!-- Add skill names or [skill-name](path-or-url) links here. -->\n', {
      flag: 'wx',
    });
  }
  return path;
}
