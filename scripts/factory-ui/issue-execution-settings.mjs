import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { digest } from './common.mjs';
import { deliveryTarget } from './flow-block-data.mjs';
import { readIssueFolderSettings, resolveFolderSettings } from './issue-folder-settings.mjs';
import { readSavedReport } from './report-document.mjs';
import { validateSettingValue } from './folder-settings-schema.mjs';
import { storedIssuePath } from './issue-report-storage.mjs';

const fields = ['branch', 'skill', 'model', 'effort'];

function localIssueModelOverrides(root, id) {
  const path = join(root, '.issues/model-settings.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).issues?.[id] || {} : {};
}

export function executionStarted(service, flow) {
  const record = service.lifecycleRuns?.[flow.issueId];
  return Boolean(
    flow.workspace ||
    record?.work ||
    record?.chatCheckout ||
    flow.destination?.pr ||
    [...flow.blocks, ...(flow.retiredBlocks || [])].some((block) => block.kind !== 'request' && block.attempts.length)
  );
}

function inheritedSettings(root, folder) {
  try {
    return resolveFolderSettings(root, folder);
  } catch (error) {
    const inherited = resolveFolderSettings(root, null);
    return { ...inherited, errors: [...inherited.errors, { key: 'folder', message: error.message }] };
  }
}

function explicitOverrides(overrides) {
  return fields.filter((key) => overrides[key] && overrides[key] !== 'default');
}

function applyOverrides(root, resolved, overrides) {
  const explicit = explicitOverrides(overrides);
  const errors = resolved.errors.filter(({ key }) => !explicit.includes(key));
  for (const key of explicit) {
    resolved.values[key] = overrides[key];
    resolved.sources[key] = 'Issue override';
    const message = validateSettingValue(root, key, overrides[key]);
    if (message) errors.push({ key, message });
  }
  resolved.errors = errors;
}

function retainExistingWork(root, flow, resolved, overrides) {
  const project = resolveFolderSettings(root, null);
  resolved.values.branch = deliveryTarget(flow).branch;
  resolved.sources.branch = 'Existing work';
  resolved.values.skill = 'none';
  resolved.sources.skill = 'Existing work';
  for (const key of ['model', 'effort']) {
    resolved.values[key] = project.values[key];
    resolved.sources[key] = project.sources[key];
  }
  resolved.errors = [];
  applyOverrides(root, resolved, overrides);
}

function applyDestination(flow, resolved) {
  if (!flow.destination?.branch) return;
  resolved.values.branch = flow.destination.branch;
  resolved.sources.branch = flow.destination.pr ? 'Linked pull request' : 'Issue destination';
}

export function resolveIssueExecutionSettings(root, issue, flow, { started = false } = {}) {
  const inherited = inheritedSettings(root, flow.folder);
  const overrides = { ...localIssueModelOverrides(root, issue.id), ...flow.settings };
  if (flow.destination?.branch) overrides.branch = flow.destination.branch;
  const resolved = {
    values: { ...inherited.values },
    sources: { ...inherited.sources },
    errors: [...inherited.errors],
  };
  applyOverrides(root, resolved, overrides);
  if (flow.executionSettings) {
    resolved.values = { ...flow.executionSettings.values };
    resolved.sources = { ...flow.executionSettings.sources };
    resolved.errors = [];
  } else if (started) retainExistingWork(root, flow, resolved, overrides);
  applyDestination(flow, resolved);
  const basis = digest(JSON.stringify([inherited.basis, overrides, resolved.values, resolved.sources]));
  return { ...resolved, overrides, basis, frozen: Boolean(flow.executionSettings || started) };
}

function configuredInboxName(folders) {
  return folders.find(({ name }) => name === 'Inbox')?.name ?? null;
}

export function savedIssueExecutionSettings(root, id) {
  const path = join(root, '.issues/flows', id, 'flow.json');
  const flow = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { issueId: id, blocks: [] };
  const location = ['open', 'closed', 'archive'].find((entry) => existsSync(storedIssuePath(root, id, entry)));
  const report = readSavedReport(root, id, location).content;
  const header = parse(report.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  const folders = readIssueFolderSettings(root);
  flow.folder =
    folders.find(({ id: folderId }) => folderId === header.folder_id)?.name ||
    flow.folder ||
    header.folder ||
    configuredInboxName(folders);
  return resolveIssueExecutionSettings(root, { id }, flow, { started: executionStarted({}, flow) });
}

export function executionBlockSkill(block, definition, settings) {
  const explicit =
    block.skillExplicit === true || (block.skillExplicit === undefined && block.skill !== definition.defaultSkill);
  if (explicit) return block.skill;
  return ['work', 'tdd', 'edit', 'understand'].includes(block.kind) && settings?.values.skill !== 'none'
    ? settings?.values.skill || block.skill || definition.defaultSkill
    : block.skill || definition.defaultSkill;
}
