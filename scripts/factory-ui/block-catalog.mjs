import { copyFileSync, constants, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import { digest } from './common.mjs';
import { uiDirectory } from './ui-source.mjs';

const blockPath = 'flow/blocks';
export const userBlocks = 'factory/ui/overrides/' + blockPath;
export const blockExtensions = 'factory/ui/extensions/' + blockPath;
const bundledBlocks = join(uiDirectory(), 'views', blockPath);
const markdown = new MarkdownIt({ html: false });
const colors = new Set(['neutral', 'yellow', 'orange', 'green', 'blue']);
const fields = new Set(['label', 'color', 'order', 'defaultSkill']);
const fieldTypes = new Set(['text', 'long text', 'number', 'boolean', 'choice', 'filename', 'url']);
const validSkill = (value) => typeof value === 'string' && /^[\w.:-]{1,160}$/.test(value);

function mergeWorkflow(path, section) {
  if (section === undefined) return undefined;
  const fence = /^```json\s*\n([\s\S]+)\n```$/.exec(section);
  if (!fence) throw Error(path + ' needs a JSON code block under Merge workflow.');
  const { policy, pollSeconds, checkTimeoutSeconds, repairAttempts, ...unknown } = JSON.parse(fence[1]);
  const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (
    Object.keys(unknown).length ||
    !['human-first', 'automatic'].includes(policy) ||
    !integer(pollSeconds, 1, 60) ||
    !integer(checkTimeoutSeconds, pollSeconds, 7200) ||
    !integer(repairAttempts, 0, 3)
  )
    throw Error(path + ' has invalid Merge workflow settings.');
  return { policy, pollSeconds, checkTimeoutSeconds, repairAttempts };
}

function settings(directory) {
  const path = join(directory, 'catalog.json');
  const text = source(path);
  const entries = text === null ? {} : JSON.parse(text);
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw Error(path + ' needs a block map.');
  for (const [id, value] of Object.entries(entries)) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !fields.has(key))
    )
      throw Error(path + ' has unknown block settings for ' + id + '.');
    const { label, color, order, defaultSkill } = value;
    if (
      ('label' in value && (typeof label !== 'string' || !label.trim() || label.length > 160)) ||
      ('color' in value && !colors.has(color)) ||
      ('order' in value && !Number.isSafeInteger(order)) ||
      ('defaultSkill' in value && defaultSkill !== null && !validSkill(defaultSkill))
    )
      throw Error(path + ' has invalid settings for ' + id + '.');
  }
  return entries;
}

function source(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw Error(path + ' must be a regular file.');
  return readFileSync(path, 'utf8');
}

function skillList(path, lines) {
  const skills = lines
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => /^ {0,3}[-+*]\s+`?([\w.:-]{1,160})`?[ \t]*$/.exec(line)?.[1]);
  if (skills.some((skill) => !skill) || new Set(skills).size !== skills.length)
    throw Error(path + ' needs one unique skill name per bullet under Skill list.');
  return skills;
}

function content(path, text, isExtension, id) {
  if (isExtension) {
    const tokens = markdown.parse(text, {});
    const heading = (token) => token.type === 'heading_open' && token.tag === 'h1' && token.level === 0;
    const index = tokens.findIndex(
      (token, i) => heading(token) && tokens[i + 1].content.toLowerCase() === 'system prompt'
    );
    const next = index >= 0 && tokens.slice(index + 1).find(heading);
    const prompt = index < 0 ? '' : text.split(/\r?\n/).slice(tokens[index].map[1], next?.map[0]).join('\n').trim();
    return { path, text, html: markdown.render(text), prompt };
  }
  if (/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text))
    throw Error(path + ' contains front matter. Move block settings to catalog.json.');
  const tokens = markdown.parse(text, {});
  const lines = text.split(/\r?\n/);
  const sections = new Map();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'heading_open' || token.tag !== 'h1' || token.level !== 0) continue;
    const end = tokens
      .slice(index + 1)
      .find((item) => item.type === 'heading_open' && item.tag === 'h1' && item.level === 0);
    const heading = tokens[index + 1].content.toLowerCase();
    if (['system prompt', 'details', 'artifacts', 'merge workflow'].includes(heading)) {
      if (sections.has(heading)) throw Error(path + ' repeats ' + heading + '.');
      sections.set(heading, lines.slice(token.map[1], end?.map[0]).join('\n').trim());
    }
  }
  const rows = (section) => {
    const lines = (sections.get(section) || '').split(/\r?\n/).filter((line) => line.trim());
    const cells = (line) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim());
    const headers = cells(lines[0] || '').map((header) => header.replace(/^`|`$/g, '').toLowerCase());
    return lines.slice(2).map((line) => {
      const values = cells(line).map((cell) => cell.replace(/^`|`$/g, ''));
      const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
      const key = row.key;
      const field = row.source || row.kind;
      if (!/^[a-zA-Z][\w-]*$/.test(key) || !field) throw Error(path + ' has an invalid ' + section + ' row.');
      const type = row.type || (field === 'file' ? 'filename' : 'text');
      if (type !== 'file' && !fieldTypes.has(type)) throw Error(path + ' has an invalid ' + section + ' field type.');
      let options = [];
      if (row.options) {
        try {
          options = JSON.parse(row.options);
        } catch {
          throw Error(path + ' needs Options as a JSON array.');
        }
        if (
          !Array.isArray(options) ||
          options.length < 1 ||
          options.length > 100 ||
          options.some((option) => typeof option !== 'string' || !option || option.length > 160)
        )
          throw Error(path + ' needs one to 100 nonempty string options.');
      }
      if (type === 'choice' && !options.length) throw Error(path + ' needs Options for choice fields.');
      return { key, field, label: row.label || key, initial: row.default || '', type, options };
    });
  };
  const details = rows('details').map(({ key, field, label, initial, type, options }) => ({
    key,
    source: field,
    label,
    initial,
    type: type === 'file' ? 'filename' : type,
    options,
  }));
  const artifacts = rows('artifacts').map(({ key, field, label, type, options }) => {
    if (!['value', 'file'].includes(field)) throw Error(path + ' needs an artifact kind of value or file.');
    return { key, kind: field, label, type: field === 'file' ? 'file' : type, options };
  });
  for (const fields of [details, artifacts])
    if (new Set(fields.map(({ key }) => key)).size !== fields.length) throw Error(path + ' repeats a field name.');
  let skills;
  let extensionFile;
  let hasExtensionSection = false;
  const visible = [];
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    const heading =
      token.type === 'heading_open' && token.tag === 'h1' && token.level === 0
        ? tokens[index + 1].content.toLowerCase()
        : '';
    if (heading !== 'skill list' && heading !== 'user extensions' && !sections.has(heading)) {
      visible.push(token);
      index += 1;
      continue;
    }
    const start = token.map[1];
    index += 3;
    while (
      index < tokens.length &&
      !(tokens[index].type === 'heading_open' && tokens[index].tag === 'h1' && tokens[index].level === 0)
    )
      index += 1;
    const section = lines.slice(start, tokens[index]?.map?.[0]).join('\n').trim();
    if (heading === 'skill list') {
      if (skills) throw Error(path + ' has more than one Skill list section.');
      skills = skillList(path, section);
    } else if (heading === 'user extensions') {
      if (hasExtensionSection) throw Error(path + ' has more than one User extensions section.');
      hasExtensionSection = true;
      const filename = id + '.md';
      const extensionPath = blockExtensions + '/' + filename;
      const declared = section.replace(/^`([^`]+)`$/, '$1');
      if (declared && declared !== filename && declared !== extensionPath)
        throw Error(path + ' must name ' + extensionPath + ' under User extensions.');
      if (declared) extensionFile = filename;
      if (declared === extensionPath) {
        // Both spellings locate the same file and must keep the saved block checksum.
        const sourceLines = text.split(/(?<=\n)/);
        const line = sourceLines.findIndex((source, index) => index >= start && source.trim() === section);
        sourceLines[line] = sourceLines[line].replace(extensionPath, filename);
        text = sourceLines.join('');
      }
    }
  }
  const paragraph = visible.findIndex((token) => token.type === 'paragraph_open');
  const description = (paragraph < 0 ? undefined : visible[paragraph + 1]?.children)
    ?.map((token) => token.content || (token.type === 'softbreak' || token.type === 'hardbreak' ? ' ' : ''))
    .join('')
    .trim();
  if (!description && skills === undefined && !sections.size)
    throw Error(path + ' needs a paragraph describing the block.');
  return {
    path,
    text,
    description,
    skills,
    extensionFile,
    details: sections.has('details') ? details : undefined,
    artifacts: sections.has('artifacts') ? artifacts : undefined,
    prompt: sections.get('system prompt'),
    mergeWorkflow: mergeWorkflow(path, sections.get('merge workflow')),
    detailsSource: sections.get('details'),
    artifactsSource: sections.get('artifacts'),
    html: markdown.renderer.render(visible, markdown.options, {}),
  };
}

export class BlockCatalog {
  #cache = new Map();
  #settings = new Map();

  constructor(project) {
    this.project = project;
  }

  read() {
    const errors = [];
    const bundled = this.#folder(bundledBlocks, errors);
    const project = this.project ? this.#folder(join(this.project, userBlocks), errors) : { ids: [], entries: {} };
    const entries = [];
    for (const id of new Set([...bundled.ids, ...project.ids])) {
      if (id === 'target') continue;
      const diagnostics = [];
      const base = bundled.ids.includes(id) ? this.#content(bundledBlocks, id, diagnostics) : null;
      const override = project.ids.includes(id) ? this.#content(project.directory, id, diagnostics) : null;
      const visible = override?.description ? override : (base ?? override);
      const description = visible?.description || (!base && override?.prompt ? id : null);
      if (!description) {
        errors.push(...diagnostics);
        continue;
      }
      const extensionFile = override?.extensionFile ?? base?.extensionFile ?? id + '.md';
      const extension = this.project ? this.#extension(id, extensionFile, project.directory, diagnostics) : null;
      const appliedExtension = extension?.text.trim() ? extension : null;
      errors.push(...diagnostics);
      const kind = bundled.ids.includes(id) ? id : 'work';
      const basePrompt = override?.prompt ?? base?.prompt;
      const prompt = appliedExtension?.prompt
        ? [basePrompt, appliedExtension.prompt].filter(Boolean).join('\n\n')
        : basePrompt;
      const detailsSource = override?.detailsSource ?? base?.detailsSource;
      const artifactsSource = override?.artifactsSource ?? base?.artifactsSource;
      const definitionHtml = [
        ['System prompt', prompt],
        ['Details', detailsSource],
        ['Artifacts', artifactsSource],
      ]
        .filter(([, body]) => body !== undefined)
        .map(([title, body]) => markdown.render('# ' + title + '\n\n' + body))
        .join('');
      const inherited = [
        override?.prompt === undefined ? base?.prompt : undefined,
        override?.details === undefined ? base?.details : undefined,
        override?.artifacts === undefined ? base?.artifacts : undefined,
        override?.skills === undefined ? base?.skills : undefined,
        ...(id === 'merge' ? [override?.mergeWorkflow === undefined ? base?.mergeWorkflow : undefined] : []),
      ];
      const effective = [
        visible.text,
        override?.path,
        override?.text,
        override?.extensionFile ?? base?.extensionFile,
        appliedExtension?.path,
        appliedExtension?.text,
        bundled.entries[id],
        project.entries[id],
        inherited,
        diagnostics,
      ];
      entries.push({
        id,
        kind,
        usable: !diagnostics.length,
        label: id,
        order: 100,
        color: 'green',
        skills: override?.skills ?? base?.skills ?? [],
        defaultSkill: null,
        ...bundled.entries[id],
        ...project.entries[id],
        description,
        details: override?.details ?? base?.details ?? [],
        artifacts: override?.artifacts ?? base?.artifacts ?? [],
        prompt,
        mergeWorkflow: override?.mergeWorkflow ?? base?.mergeWorkflow,
        checksum: digest(JSON.stringify(effective)),
        content: {
          html: visible.html + definitionHtml + (extension?.html ? '<h2>User extensions</h2>\n' + extension.html : ''),
          inspectorHtml:
            visible.html +
            (extension?.html ? '<details><summary>User extensions</summary>\n' + extension.html + '</details>' : ''),
          bundled: base?.path ?? null,
          override: override?.path ?? null,
          extension: extension?.path ?? null,
          extensionPath: extensionFile ? `${blockExtensions}/${extensionFile}` : null,
        },
      });
    }
    return { entries: entries.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)), errors };
  }

  openExtension(id) {
    const entry = this.read().entries.find((item) => item.id === id);
    if (!entry || !this.project) throw Error('Choose a block definition in a project.');
    if (entry.content.extension) return entry.content.extension;
    const destination = join(this.project, entry.content.extensionPath);
    mkdirSync(join(this.project, blockExtensions), { recursive: true });
    try {
      writeFileSync(destination, '', { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST' || !lstatSync(destination).isFile()) throw error;
    }
    return destination;
  }

  createOverride(id) {
    const entry = this.read().entries.find((item) => item.id === id);
    if (!entry?.content.bundled) throw Error('Choose a bundled block definition.');
    const directory = join(this.project, userBlocks);
    mkdirSync(directory, { recursive: true });
    const destination = join(directory, id + '.md');
    copyFileSync(entry.content.bundled, destination, constants.COPYFILE_EXCL);
    return destination;
  }

  #folder(directory, errors) {
    let ids = [];
    try {
      ids = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => /^[a-z0-9][a-z0-9-]*\.md$/.test(entry.name))
        .map((entry) => entry.name.slice(0, -3));
      this.#settings.set(directory, settings(directory));
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push(error.message);
    }
    return { directory, ids, entries: this.#settings.get(directory) ?? {} };
  }

  #extension(id, filename, overrideDirectory, errors) {
    const current = filename && this.#content(join(this.project, blockExtensions), id, errors, true);
    return current ?? this.#content(overrideDirectory, id + '_user', errors, true);
  }

  #content(directory, id, errors, isExtension = false) {
    const path = join(directory, id + '.md');
    const cached = this.#cache.get(path);
    try {
      const text = source(path);
      if (text === null) return null;
      if (text === cached?.text) return cached.value;
      const value = content(path, text, isExtension, id);
      this.#cache.set(path, { text, value });
      return value;
    } catch (error) {
      errors.push(error.message);
      return cached?.value ?? null;
    }
  }
}
