import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { digest, requireThat, writeJson } from './common.mjs';
import { systemFlowDirectory, uiDirectory } from './ui-source.mjs';
import {
  createIssueFolderSettings,
  giveIssueFolderCopyNewId,
  readIssueFolderSettings,
} from './issue-folder-settings.mjs';

const run = promisify(execFile);
const markdown = /\.md$/i;
const maxRead = 2 * 1024 * 1024;
const maxWrite = 128000;
const ignored = new Set(['node_modules', '.git', '.issues', '.aws', '.ssh']);

const info = (path) => lstatSync(path, { throwIfNoEntry: false });

function components(path = '') {
  requireThat(typeof path === 'string', 'Choose a sidebar path.');
  const parts = path ? path.split('/') : [];
  requireThat(parts.every(validName), 'Choose a path within this sidebar folder.');
  return parts;
}

function validName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !ignored.has(name) &&
    !/[\\/:\x00-\x1f]/.test(name)
  );
}

function stepPath(base, parts, kind) {
  let path = base;
  for (const [index, name] of parts.entries()) {
    path = join(path, name);
    const entry = info(path);
    if (!entry) continue;
    const file = index === parts.length - 1 && kind === 'file';
    requireThat(
      file ? entry.isFile() : entry.isDirectory(),
      'Choose a regular file or folder inside this sidebar root.'
    );
  }
  return path;
}

export class SidebarFiles {
  constructor(project) {
    this.project = realpathSync(project);
  }

  pinsPath() {
    return join(this.project, '.issues/sidebar-files.local.json');
  }

  pins() {
    const path = this.pinsPath();
    const queue = info(dirname(path));
    if (!queue) return [];
    requireThat(queue.isDirectory(), 'The issue directory must be a real directory.');
    if (!info(path)) return [];
    requireThat(info(path).isFile(), 'Sidebar pins must be saved in a regular file.');
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  roots() {
    return [
      { id: 'system-flow', name: 'flow', section: 'System', base: systemFlowDirectory(), writable: false },
      {
        id: 'system-skills',
        name: 'skills',
        section: 'System',
        base: resolve(uiDirectory(), '../..', '.agents/skills'),
        writable: false,
      },
      { id: 'user', name: 'user', section: '', base: join(this.project, 'user'), writable: true },
      ...this.pins().map(({ id, base }) => ({
        id,
        name: basename(base),
        section: 'Added folders',
        base,
        writable: false,
      })),
    ];
  }

  index() {
    return this.roots().map(({ id, name, section, writable, base }) => ({
      id,
      name,
      section,
      writable,
      missing: !info(base)?.isDirectory(),
    }));
  }

  locate({ root, path }, type) {
    const entry = this.roots().find(({ id }) => id === root);
    requireThat(entry, 'Choose a sidebar root.');
    const rootInfo = info(entry.base);
    requireThat(
      !rootInfo || (rootInfo.isDirectory() && realpathSync(entry.base) === entry.base),
      'This sidebar folder no longer points to an ordinary directory.'
    );
    const parts = components(path);
    return { entry, path: stepPath(entry.base, parts, type), parts };
  }

  directory(input) {
    const { entry, path } = this.locate(input, 'directory');
    const rows = info(path)
      ? readdirSync(path, { withFileTypes: true })
          .filter((item) => validName(item.name) && (item.isDirectory() || (item.isFile() && markdown.test(item.name))))
          .map((item) => ({ name: item.name, directory: item.isDirectory() }))
      : [];
    if (entry.id === 'user' && !input.path)
      for (const name of ['flow', 'skills'])
        if (!rows.some((row) => row.name === name)) rows.push({ name, directory: true });
    rows.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    const issueFolder =
      entry.id === 'user' &&
      input.path &&
      readIssueFolderSettings(this.project, { includeCopies: true }).find(({ name }) => name === input.path);
    return { rows, issueFolder: issueFolder || null };
  }

  file(input) {
    const { entry, path } = this.locate(input, 'file');
    const file = info(path);
    requireThat(markdown.test(path) && file?.isFile() && file.size <= maxRead, 'Choose a Markdown file under 2 MB.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
    return { name: basename(path), text, revision: digest(text), writable: entry.writable && file.size <= maxWrite };
  }

  change(input) {
    switch (input.action) {
      case 'add':
        return this.pin(input.path);
      case 'remove': {
        const pins = this.pins();
        requireThat(
          pins.some(({ id }) => id === input.root),
          'Choose an added folder.'
        );
        writeJson(
          this.pinsPath(),
          pins.filter(({ id }) => id !== input.root)
        );
        return { removed: true };
      }
      case 'enable-issues':
        requireThat(input.root === 'user', 'Choose a folder inside user/.');
        return createIssueFolderSettings(this.project, input.path);
      case 'new-folder-id':
        requireThat(input.root === 'user', 'Choose a folder inside user/.');
        return giveIssueFolderCopyNewId(this.project, input.path);
      case 'install-skill':
        return this.installSkill(input);
      case 'choose':
        return this.choose();
      case 'open':
        return this.open(input);
      case 'directory':
      case 'create':
      case 'save':
      case 'copy':
        return this.write(input);
      default:
        throw Error('Choose a folder or file action.');
    }
  }

  pin(chosen) {
    const absolute = typeof chosen === 'string' && chosen.startsWith('file:') ? fileURLToPath(chosen) : chosen;
    requireThat(typeof absolute === 'string' && isAbsolute(absolute), 'Enter the full path to the folder.');
    const base = realpathSync(absolute);
    requireThat(
      info(base)?.isDirectory() &&
        base !== this.project &&
        dirname(base) !== base &&
        !base.split(sep).some((name) => ignored.has(name)),
      'Choose an ordinary folder outside Factory runtime storage.'
    );
    const existing = this.roots().find((entry) => entry.base === base);
    if (existing) return { id: existing.id };
    const pins = this.pins();
    requireThat(pins.length < 40, 'Remove an added folder before adding another.');
    const id = randomUUID();
    const destination = this.pinsPath();
    mkdirSync(dirname(destination), { recursive: true });
    writeJson(destination, [...pins, { id, base }]);
    return { id };
  }

  installSkill(input) {
    const { entry, parts, path } = this.locate(input, 'file');
    const [scope, name, fileName] = parts;
    requireThat(
      entry.id === 'user' &&
        scope === 'skills' &&
        /^[\w-]{1,100}$/.test(name || '') &&
        parts.length === 3 &&
        fileName === 'SKILL.md' &&
        info(path)?.isFile(),
      'Choose user/skills/<name>/SKILL.md.'
    );
    const directory = stepPath(this.project, ['.agents', 'skills'], 'directory');
    mkdirSync(directory, { recursive: true });
    const destination = join(directory, name);
    const existing = info(destination);
    if (existing)
      requireThat(
        existing.isSymbolicLink() && realpathSync(destination) === dirname(path),
        'A different project skill already has that folder name.'
      );
    else symlinkSync(relative(directory, dirname(path)), destination, 'dir');
    return { installed: true };
  }

  async choose() {
    requireThat(process.platform === 'darwin', 'Enter the full path to the folder on this platform.');
    try {
      const { stdout } = await run(
        '/usr/bin/osascript',
        ['-e', 'POSIX path of (choose folder with prompt "Add a folder to Factory")'],
        {
          timeout: 120000,
        }
      );
      const i = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
      return this.pin(i);
    } catch (error) {
      if (error.stderr?.includes('(-128)')) return { cancelled: true };
      throw error;
    }
  }

  async open(input) {
    const { path } = this.locate(input, 'file');
    this.file(input);
    requireThat(process.platform === 'darwin', 'Open the file with your usual editor.');
    await run('/usr/bin/open', [path], { timeout: 5000 });
    return { opened: true };
  }

  write(input) {
    const copy = input.action === 'copy';
    const directory = input.action === 'directory';
    const target = this.locate(
      copy ? { root: 'user', path: input.destination } : input,
      directory ? 'directory' : 'file'
    );
    requireThat(target.entry.writable && target.parts.length, 'Choose a file or folder inside user/.');
    if (directory) {
      mkdirSync(target.path, { recursive: true });
      return { created: true };
    }
    requireThat(markdown.test(target.path), 'Use a .md file name.');
    const text = copy ? this.file(input).text : input.text;
    requireThat(typeof text === 'string' && Buffer.byteLength(text) <= maxWrite, 'Keep edited Markdown under 128 KB.');
    mkdirSync(dirname(target.path), { recursive: true });
    if (input.action !== 'save') {
      writeFileSync(target.path, text, { flag: 'wx' });
      return { created: true };
    }
    requireThat(this.file(input).revision === input.revision, 'The file changed on disk. Reopen it before saving.');
    const temporary = target.path + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, text, { flag: 'wx', mode: info(target.path).mode & 0o777 });
      renameSync(temporary, target.path);
    } finally {
      if (info(temporary)) unlinkSync(temporary);
    }
    return this.file(input);
  }
}
