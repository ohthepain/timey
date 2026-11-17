import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemFlowDirectory } from './ui-source.mjs';
import { BlockCatalog, userBlocks } from './block-catalog.mjs';

const views = [
  {
    id: 'flow/block-inspector',
    screen: 'Flow',
    name: 'Block inspector',
    sections: ['details-tab', 'conversation-tab', 'artifacts-tab'],
  },
];
const overrideRoot = 'user/flow/overrides';
const digest = (text) => createHash('sha256').update(text).digest('hex');
const revisionOf = (text) => digest(JSON.stringify(text));

function viewFiles(view) {
  const path = join(systemFlowDirectory(), view.id.slice('flow/'.length) + '.md');
  const overridePath = join(overrideRoot, view.id.slice('flow/'.length) + '.md');
  return { bundled: { path, text: readFileSync(path, 'utf8') }, overridePath };
}

function projectPath(root, relative, create = false) {
  let path = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const file = index === parts.length - 1;
    let info = lstatSync(path, { throwIfNoEntry: false });
    if (!info && !file && create) {
      mkdirSync(path, { recursive: true });
      info = lstatSync(path);
    }
    if (!info) return file ? path : null;
    if (file ? !info.isFile() : !info.isDirectory()) throw Error(`${relative} must be a regular project file.`);
  }
  return path;
}

function readOverride(root, relative) {
  const path = projectPath(root, relative);
  if (!path) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sections(view, path, text) {
  const document = text;
  const headings = [...document.matchAll(/^ {0,3}##[\t ]+([a-z][a-z0-9-]*)[\t ]*(?:[\t ]+#+[\t ]*)?\r?$/gm)];
  const result = new Map();
  for (const [index, heading] of headings.entries()) {
    const [, id] = heading;
    const headingEnd = heading.index + heading[0].length;
    const start = headingEnd + (text[headingEnd] === '\n' ? 1 : 0);
    const end = headings[index + 1]?.index ?? document.length;
    const body = text.slice(start, end);
    const [firstLine, ...rest] = body.trim().split(/\r?\n/);
    const label = firstLine.trim();
    const description = rest.join('\n').trim();
    const line = text.slice(0, heading.index).split('\n').length;
    const location = `${path}:${line}`;
    if (!view.sections.includes(id)) throw Error(`${location} refers to an unknown section: ${id}.`);
    if (result.has(id)) throw Error(`${location} repeats section ${id}.`);
    if (!validLabel(label) || description)
      throw Error(`${location} needs one line of text for ${id}, up to 120 characters.`);
    result.set(id, { path, line, label, description, start, end, body });
  }
  const introduction = document.slice(0, headings[0]?.index ?? document.length);
  if (introduction.trim() && !/^ {0,3}#[\t ]+[^\r\n]+$/.test(introduction.trim()))
    throw Error(`${path} needs a title followed by named sections.`);
  if (!result.size && text.trim()) throw Error(`${path} contains no named sections.`);
  return result;
}

function validLabel(label) {
  return label.length > 0 && label.length <= 120 && !/[\r\n\x00-\x1f]/.test(label);
}

function location(section) {
  const { path, line, label } = section;
  return { path, line, label };
}

function compile(view, bundled, override) {
  const defaults = sections(view, bundled.path, bundled.text);
  const overrides = sections(view, override.path, override.text ?? '');
  for (const section of view.sections) {
    if (!defaults.has(section)) throw Error(`${bundled.path} is missing required section ${section}.`);
  }
  const entries = view.sections.map((section) => {
    const base = defaults.get(section);
    const custom = overrides.get(section);
    return {
      id: `${view.id}/${section}`,
      view: view.id,
      screen: view.screen,
      name: view.name,
      section,
      label: (custom ?? base).label,
      bundled: location(base),
      override: custom ? location(custom) : null,
      overridePath: override.path,
      editRevision: revisionOf(override.text),
      consumers: [view.id],
    };
  });
  return { entries, overrides };
}

export class ViewSources {
  #cache = new Map();

  constructor(project, catalog = new BlockCatalog(project)) {
    this.project = realpathSync(project);
    this.catalog = catalog;
  }

  update() {
    const changed = [];
    const errors = [];
    const entries = [];
    for (const view of views) {
      const previous = this.#cache.get(view.id);
      try {
        const { bundled, overridePath } = viewFiles(view);
        if (!previous) {
          const defaults = compile(view, bundled, { path: overridePath, text: null });
          this.#cache.set(view.id, { entries: defaults.entries });
        }
        const sources = { bundled, override: { path: overridePath, text: readOverride(this.project, overridePath) } };
        const revision = revisionOf(sources);
        if (revision !== previous?.revision) {
          const compiled = compile(view, sources.bundled, sources.override);
          this.#cache.set(view.id, { revision, entries: compiled.entries });
          changed.push(view.id);
        }
      } catch (error) {
        errors.push(error.message);
      }
      entries.push(...(this.#cache.get(view.id)?.entries ?? []));
    }
    const catalog = this.catalog.read();
    errors.push(...catalog.errors);
    for (const item of catalog.entries) {
      const { bundled, override, extension, extensionPath, html, inspectorHtml } = item.content;
      const id = 'flow/blocks/' + item.id;
      const entry = {
        id,
        view: id,
        screen: 'Flow',
        name: item.label,
        section: 'Content',
        label: item.label,
        description: item.description,
        html,
        inspectorHtml,
        document: true,
        bundled: bundled ? { path: bundled, line: 1, label: item.label } : null,
        override: override ? { path: override, line: 1, label: item.label } : null,
        extension,
        extensionPath,
        overridePath: userBlocks + '/' + item.id + '.md',
        consumers: [id],
      };
      if (this.#cache.get(id)?.revision !== revisionOf(entry)) {
        changed.push(id);
        this.#cache.set(id, { revision: revisionOf(entry) });
      }
      entries.push(entry);
    }
    return { changed, errors, entries };
  }

  edit(id, expectedRevision, label) {
    const view = views.find((item) => item.sections.some((section) => id === `${item.id}/${section}`));
    if (!view) throw Error('Choose a known UI source section.');
    if (typeof label !== 'string' || !validLabel(label.trim()))
      throw Error('Enter one line of text, up to 120 characters.');
    const { bundled, overridePath } = viewFiles(view);
    const override = { path: overridePath, text: readOverride(this.project, overridePath) };
    if (revisionOf(override.text) !== expectedRevision)
      throw Error(`${override.path} changed on disk. Copy your draft before reopening the editor.`);
    const { overrides } = compile(view, bundled, override);
    const section = id.slice(view.id.length + 1);
    const existing = overrides.get(section);
    const text = override.text ?? `# ${view.name}\n`;
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const next = existing
      ? text.slice(0, existing.start) +
        existing.body.replace(existing.label, () => label.trim()) +
        text.slice(existing.end)
      : `${text}${text.endsWith(newline) ? '' : newline}${newline}## ${section}${newline}${newline}${label.trim()}${newline}`;
    compile(view, bundled, { path: override.path, text: next });
    const target = projectPath(this.project, override.path, true);
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, next, { flag: 'wx' });
      if (readOverride(this.project, override.path) !== override.text)
        throw Error(`${override.path} changed on disk. Copy your draft before reopening the editor.`);
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
    return this.update();
  }
}
