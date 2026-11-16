import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { digest, requireThat } from './common.mjs';
import { withoutTarget } from './flow-block-data.mjs';
import { uiDirectory } from './ui-source.mjs';

export const issueTypes = ['bug', 'feature', 'investigation'];
const bundled = join(uiDirectory(), 'views', 'flow');
const customDirectory = 'factory/ui/flows';
const extensionDirectory = 'factory/ui/extensions/flow';
const maximumMarkdownBytes = 128000;
const flowId = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const blockId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const issueType = z.enum(issueTypes);
const node = z.strictObject({
  id: blockId,
  block: blockId.transform((id) => (id === 'merge-target' ? 'update-branch' : id)),
  after: z.array(blockId).default([]),
  lane: z.number().int().min(0).max(3).default(0),
  suggested: z.boolean().default(false),
});
const flowNodes = z.array(node).min(1).max(200);
const extensionPath = z
  .string()
  .refine(
    (path) =>
      path.endsWith('.md') &&
      path.split('/').every((part) => part && part !== '.' && part !== '..' && !/[\\:\0\r\n]/.test(part)),
    'Use a Markdown path relative to the project root.'
  );
const definitionData = z.strictObject({
  name: z.string().trim().min(1).max(100),
  issueTypes: z.array(issueType).min(1).max(issueTypes.length),
  skill: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,100}$/)
    .optional(),
  blocks: flowNodes,
  extension: extensionPath.optional(),
});
const defaultList = z.partialRecord(issueType, flowId);
const defaultData = z.strictObject({ defaults: defaultList, extension: extensionPath.optional() });
const projectDefaults = z.strictObject({ defaults: defaultList });
const projectDefinition = z.strictObject({ blocks: flowNodes.optional() });
const markdown = new MarkdownIt({ html: false });

function readMarkdown(path) {
  const file = lstatSync(path, { throwIfNoEntry: false });
  requireThat(file?.isFile() && file.size <= maximumMarkdownBytes, 'Expected a Markdown file under 128 KB.');
  return readFileSync(path, 'utf8');
}

function document(source) {
  const header = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const body = header ? source.slice(header[0].length) : source;
  const lines = body.split(/\r?\n/);
  const tokens = markdown.parse(body, {});
  const sections = tokens.flatMap((token, index) =>
    token.type === 'heading_open' && token.tag === 'h1' && token.level === 0
      ? [{ name: tokens[index + 1].content, lines: token.map }]
      : []
  );
  const section = (name) => {
    const index = sections.findIndex((item) => item.name === name);
    return index < 0
      ? ''
      : lines
          .slice(sections[index].lines[1], sections[index + 1]?.lines[0])
          .join('\n')
          .trim();
  };
  return { fields: header ? parse(header[1]) : {}, body, section };
}

function extension(base, root, declared, legacyPath) {
  const legacy = base.section('User extensions').replace(/^`([^`]+)`$/, '$1');
  if (!declared && legacy) {
    requireThat(
      legacy === legacyPath || legacy === legacyPath.split('/').at(-1),
      `User extensions must name ${legacyPath}.`
    );
    declared = legacyPath;
  }
  if (!root || !declared) return null;
  let path = root;
  for (const part of declared.split('/')) {
    path = join(path, part);
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) return null;
    requireThat(!info.isSymbolicLink(), 'Use a regular project path for the extension.');
  }
  return document(readMarkdown(path));
}

function promptSection(doc) {
  return doc.section('Prompt') || doc.section('Build prompt');
}

function promptContent(prompt) {
  return markdown.parse(prompt, {}).flatMap((token) => {
    if (['fence', 'code_block'].includes(token.type)) return [['code', token.info.trim(), token.content]];
    if (token.type !== 'inline') return [];
    const line = token.children
      .map((child) => {
        if (['softbreak', 'hardbreak'].includes(child.type)) return ' ';
        if (child.type === 'link_open') return ' ' + child.attrGet('href') + ' ';
        if (child.type === 'code_inline') return ' [code:' + digest(child.content) + '] ';
        return child.content;
      })
      .join('')
      .trim()
      .replace(/\s+/g, ' ');
    return [line];
  });
}

export function validateFlowNodes(value, catalog) {
  const blocks = flowNodes.parse(value);
  const kinds = catalog && new Set(catalog.filter((entry) => entry.usable).map((entry) => entry.id));
  requireThat(
    blocks[0].id === 'request' && blocks[0].block === 'request',
    'Start the flow with the Request block, using the key request.'
  );
  const seen = new Set();
  for (const [index, block] of blocks.entries()) {
    requireThat(
      !seen.has(block.id) && block.after.every((id) => seen.has(id)),
      'Use unique block keys and list each dependency before its block.'
    );
    requireThat(block.block !== 'target', 'Starting point and Destination belong to the issue flow.');
    requireThat(index === 0 || block.block !== 'request', 'Use Request only once.');
    requireThat(!kinds || kinds.has(block.block), `Block definition "${block.block}" is unavailable.`);
    seen.add(block.id);
  }
  return blocks;
}

function loadDefinition(path, id, root, catalog) {
  const base = document(readMarkdown(path));
  const data = definitionData.parse(base.fields);
  const { blocks, extension: declared, ...fields } = data;
  const appended = extension(base, root, declared, extensionDirectory + '/definitions/' + id + '.md');
  const projectBlocks = appended && projectDefinition.parse(appended.fields ?? {}).blocks;
  const prompts = [promptSection(base), appended && (promptSection(appended) || appended.body.trim())].filter(Boolean);
  let effectiveBlocks = projectBlocks ?? blocks;
  for (const node of effectiveBlocks.filter((node) => node.block === 'target'))
    effectiveBlocks = withoutTarget(effectiveBlocks, node);
  const definition = { id, ...fields, blocks: validateFlowNodes(effectiveBlocks, catalog) };
  return {
    ...definition,
    path,
    prompt: prompts.join('\n\n'),
    checksum: digest(JSON.stringify([definition, prompts.map(promptContent)])),
  };
}

function readDefaults(root) {
  const base = document(readMarkdown(join(bundled, 'defaults.md')));
  const data = defaultData.parse(base.fields);
  const project = extension(base, root, data.extension, extensionDirectory + '/defaults.md');
  return { ...data.defaults, ...(project ? projectDefaults.parse(project.fields).defaults : {}) };
}

let builtinFlows;
export function bundledFlow(type) {
  builtinFlows ??= readFlowDefinitions().entries;
  return builtinFlows.find((entry) => entry.issueTypes.includes(type)) ?? builtinFlows[0];
}

export function readFlowDefinitions(root, catalog) {
  const entries = [];
  const errors = [];
  const sources = new Map();
  const folders = [join(bundled, 'definitions'), ...(root ? [join(root, customDirectory)] : [])];
  const seen = new Set();
  for (const folder of folders) {
    for (const file of definitionFiles(folder)) {
      if (!file.name.endsWith('.md')) continue;
      const id = file.name.slice(0, -3);
      try {
        flowId.parse(id);
        requireThat(!seen.has(id), 'This flow ID is already in use.');
        seen.add(id);
        const path = join(folder, file.name);
        if (file.isFile()) sources.set(id, path);
        entries.push(loadDefinition(path, id, root, catalog));
      } catch (error) {
        errors.push(`${file.name}: ${firstIssue(error)}`);
      }
    }
  }
  let defaults = {};
  try {
    defaults = readDefaults(root);
  } catch (error) {
    errors.push(`defaults.md: ${firstIssue(error)}`);
  }
  return { entries, defaults, errors, sources, occupiedIds: seen };
}

function definitionFiles(folder) {
  try {
    return readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function firstIssue(error) {
  return error.issues?.[0]?.message ?? error.message;
}

export function selectFlowDefinition(catalog, type, id = catalog.defaults[type]) {
  const entry = catalog.entries.find((item) => item.id === id && item.issueTypes.includes(type));
  requireThat(
    entry,
    id
      ? `Flow "${id}" is unavailable for ${type}. Check the project Markdown.`
      : `Set a default flow for ${type} in defaults.md.`
  );
  return entry;
}

export function suggestFlowExport(linked, current, occupiedIds) {
  const skillId = current?.skill?.toLowerCase().replaceAll('_', '-');
  const base = skillId && /^[a-z]/.test(skillId) ? skillId : linked.id;
  let flowId = base.slice(0, 80);
  for (let copy = 2; occupiedIds.has(flowId); copy++) {
    const suffix = '-' + copy;
    flowId = base.slice(0, 80 - suffix.length).replace(/-+$/, '') + suffix;
  }
  return { flowId, directory: customDirectory };
}

export function exportFlowDefinition(root, input, flow, catalog) {
  const id = flowId.parse(input.flowId);
  requireThat(
    !lstatSync(join(bundled, 'definitions', id + '.md'), { throwIfNoEntry: false }),
    'That flow ID is already in use.'
  );
  const { names, blocks } = exportedNodes(flow);
  const data = definitionData.parse({ name: input.name, issueTypes: [flow.routeType], blocks });
  const path = join(root, customDirectory, id + '.md');
  const source = '---\n' + stringify(data) + '---\n';
  validateFlowNodes(data.blocks, catalog);
  requireThat(Buffer.byteLength(source) <= maximumMarkdownBytes, 'Keep exported Markdown under 128 KB.');
  let directory = root;
  for (const part of customDirectory.split('/')) {
    directory = join(directory, part);
    const info = lstatSync(directory, { throwIfNoEntry: false });
    if (!info) mkdirSync(directory);
    else requireThat(info.isDirectory() && !info.isSymbolicLink(), 'Use a regular project folder for exported flows.');
  }
  requireThat(!lstatSync(path, { throwIfNoEntry: false }), 'That flow ID is already in use.');
  writeFileSync(path, source, { flag: 'wx' });
  return { definition: loadDefinition(path, id, undefined, catalog), names, source };
}

function exportedNodes(flow) {
  const names = new Map(flow.blocks.map((block) => [block.id, block.flowKey ?? block.id]));
  const blocks = flow.blocks.map((block) => ({
    id: names.get(block.id),
    block: block.definition ?? block.kind,
    after: block.after.map((id) => names.get(id)),
    lane: block.lane,
    suggested: block.suggested,
  }));
  return { names, blocks };
}
