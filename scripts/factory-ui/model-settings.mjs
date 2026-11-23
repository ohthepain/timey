import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson, requireThat } from './common.mjs';
import {
  initializeFolderSettings,
  readFolderSettings,
  resolveFolderSettings,
  updateFolderSettings,
} from './issue-folder-settings.mjs';
import { savedIssueExecutionSettings } from './issue-execution-settings.mjs';
import { FlowStore } from './flow-store.mjs';
import { folderSettingsFields } from './folder-settings-schema.mjs';
import { afterReportWrite } from './stores/report-access.mjs';
import { agentModel } from './agent-models.mjs';

const issueSettingsPath = (root) => join(root, '.issues', 'model-settings.json');

function readLocalSettings(root) {
  const path = issueSettingsPath(root);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { issues: {} };
}

export function readModelSettings(root, { initialize = false } = {}) {
  if (initialize) initializeFolderSettings(root);
  const { values, errors } = resolveFolderSettings(root, null);
  const fields = folderSettingsFields(root, { branchChoices: false });
  return {
    defaults: { model: values.model, effort: values.effort },
    errors,
    models: fields
      .find(({ key }) => key === 'model')
      .choices.map(({ value, label, description }) => ({
        id: value,
        name: label,
        description: description || label,
        provider: agentModel(value).provider,
        supportsEffort: agentModel(value).supportsEffort,
      })),
    efforts: fields.find(({ key }) => key === 'effort').choices.map(({ value }) => value),
  };
}

export function readIssueModelSettings(root, issueId) {
  const { values, overrides, errors } = savedIssueExecutionSettings(root, issueId);
  return {
    model: overrides.model === 'default' ? '' : overrides.model || '',
    effort: overrides.effort === 'default' ? '' : overrides.effort || '',
    effectiveModel: values.model,
    effectiveEffort: values.effort,
    ...(errors.length ? { errors } : {}),
  };
}

export function newChatModelSettings(root, issueId = null) {
  const project = readModelSettings(root);
  const resolved = issueId ? savedIssueExecutionSettings(root, issueId) : null;
  requireThat(
    !(resolved?.errors || project.errors).length,
    'Fix project or folder settings before starting this issue.'
  );
  const defaults = resolved?.values || project.defaults;
  return {
    model: defaults.model,
    effort: defaults.effort,
  };
}

export function codexHelperModelSettings(root) {
  const settings = newChatModelSettings(root);
  if (agentModel(settings.model).provider === 'codex') return settings;
  const fields = folderSettingsFields(root, { branchChoices: false });
  return {
    model: fields.find(({ key }) => key === 'model').fallback,
    effort: fields.find(({ key }) => key === 'effort').fallback,
  };
}

export function saveDefaultModelSettings(service, input) {
  service.ownServer();
  const choices = readModelSettings(service.root);
  requireThat(
    choices.models.some((choice) => choice.id === input.model),
    'Choose one of the listed models.'
  );
  requireThat(choices.efforts.includes(input.effort), 'Choose one of the listed effort levels.');
  initializeFolderSettings(service.root);
  const settings = readFolderSettings(service.root, service.root);
  updateFolderSettings(service.root, {
    directory: service.root,
    revision: settings.revision,
    changes: { model: input.model, effort: input.effort },
  });
  return readModelSettings(service.root);
}

export function saveIssueModelSettings(service, input) {
  service.ownServer();
  requireThat(
    typeof input.issueId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.issueId),
    'Choose a valid issue.'
  );
  requireThat(
    existsSync(join(service.root, '.issues', input.issueId + '.md')),
    'This issue no longer exists. Refresh the queue.'
  );
  const choices = readModelSettings(service.root);
  requireThat(
    !savedIssueExecutionSettings(service.root, input.issueId).frozen,
    'Issue settings are fixed after execution starts.'
  );
  requireThat(
    input.model === '' || choices.models.some((choice) => choice.id === input.model),
    'Choose one of the listed models or use the default.'
  );
  requireThat(
    input.effort === '' || choices.efforts.includes(input.effort),
    'Choose one of the listed effort levels or use the default.'
  );

  const path = issueSettingsPath(service.root);
  const all = readLocalSettings(service.root);
  const overrides = { ...(all.issues?.[input.issueId] || {}) };
  if (input.model) overrides.model = input.model;
  else delete overrides.model;
  if (input.effort) overrides.effort = input.effort;
  else delete overrides.effort;
  const issues = { ...(all.issues || {}) };
  if (Object.keys(overrides).length) issues[input.issueId] = overrides;
  else delete issues[input.issueId];
  writeJson(path, { ...all, issues });
  const store = new FlowStore(service.root);
  if (existsSync(store.path(input.issueId))) {
    const flow = JSON.parse(readFileSync(store.path(input.issueId), 'utf8'));
    flow.settings = { ...flow.settings, model: input.model || 'default', effort: input.effort || 'default' };
    return afterReportWrite(store.save(flow, flow.revision), () => readIssueModelSettings(service.root, input.issueId));
  }
  return readIssueModelSettings(service.root, input.issueId);
}
