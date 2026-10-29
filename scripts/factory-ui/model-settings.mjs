import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson, requireThat } from './common.mjs';

export const modelChoices = [
  {
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    description: 'Fast and efficient for focused, frequent work.',
  },
  {
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1 Sol',
    description: 'Near-Astra capability for complex work at lower cost.',
  },
  {
    id: 'gpt-6.1-terra',
    name: 'GPT-6.1 Terra',
    description: 'Fast visual reasoning, precise computer use, and clear writing.',
  },
  {
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    description: 'The most capable choice for demanding reasoning and coding.',
  },
];

export const effortChoices = ['low', 'medium', 'high', 'max'];
const defaultValues = { model: 'gpt-6-luna', effort: 'medium' };
const issueSettingsPath = (root) => join(root, '.issues', 'model-settings.json');

function readProjectConfig(root) {
  const path = join(root, 'factory.config.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

function readLocalSettings(root) {
  const path = issueSettingsPath(root);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { issues: {} };
}

export function readModelSettings(root) {
  const config = readProjectConfig(root);
  const local = readLocalSettings(root);
  const defaults = local.defaults || {};
  return {
    defaults: {
      model: modelChoices.some((choice) => choice.id === defaults.model)
        ? defaults.model
        : modelChoices.some((choice) => choice.id === config.factoryModel)
          ? config.factoryModel
          : defaultValues.model,
      effort: effortChoices.includes(defaults.effort)
        ? defaults.effort
        : effortChoices.includes(config.factoryEffort)
          ? config.factoryEffort
          : defaultValues.effort,
    },
    models: modelChoices,
    efforts: effortChoices,
  };
}

function issueOverrides(root, issueId) {
  const all = readLocalSettings(root);
  return all.issues?.[issueId] || {};
}

export function readIssueModelSettings(root, issueId) {
  const defaults = readModelSettings(root).defaults;
  const overrides = issueOverrides(root, issueId);
  return {
    model: overrides.model || '',
    effort: overrides.effort || '',
    effectiveModel: overrides.model || defaults.model,
    effectiveEffort: overrides.effort || defaults.effort,
  };
}

export function newChatModelSettings(root, issueId = null) {
  const defaults = readModelSettings(root).defaults;
  const overrides = issueId ? issueOverrides(root, issueId) : {};
  return {
    model: overrides.model || defaults.model,
    effort: overrides.effort || defaults.effort,
  };
}

export function saveDefaultModelSettings(service, input) {
  service.ownServer();
  requireThat(
    modelChoices.some((choice) => choice.id === input.model),
    'Choose one of the listed models.'
  );
  requireThat(effortChoices.includes(input.effort), 'Choose one of the listed effort levels.');
  const path = issueSettingsPath(service.root);
  const all = readLocalSettings(service.root);
  writeJson(path, { ...all, defaults: { model: input.model, effort: input.effort } });
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
  requireThat(
    input.model === '' || modelChoices.some((choice) => choice.id === input.model),
    'Choose one of the listed models or use the default.'
  );
  requireThat(
    input.effort === '' || effortChoices.includes(input.effort),
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
  return readIssueModelSettings(service.root, input.issueId);
}
