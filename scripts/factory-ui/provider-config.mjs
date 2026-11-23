import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'yaml';
import { z } from 'zod';
import { digest, requireThat, writeJson } from './common.mjs';

export const providerNames = { codex: 'OpenAI', anthropic: 'Anthropic', google: 'Google' };
export const providerForModel = (model = '') =>
  model.startsWith('anthropic:') ? 'anthropic' : model.startsWith('google:') ? 'google' : 'codex';
export const providerConfigPath = (root) => join(root, 'user/ai-providers.json');
const policySchema = z
  .object({
    enabled: z.array(z.string().min(1).max(200)).max(1000),
    warning: z.number().min(0).max(100),
    disable: z.number().min(0).max(100),
    allowUnmonitored: z.boolean(),
  })
  .strict()
  .refine((value) => value.disable < value.warning, 'Disable threshold must be below warning threshold.');
const configSchema = z.object(Object.fromEntries(Object.keys(providerNames).map((id) => [id, policySchema]))).strict();

export function readProviderConfig(root) {
  const path = providerConfigPath(root);
  if (!existsSync(path)) return null;
  const source = readFileSync(path, 'utf8');
  return { providers: configSchema.parse(JSON.parse(source)), revision: digest(source) };
}

function collectModels(value, models) {
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === 'model' || key.endsWith('Model')) && typeof entry === 'string' && entry !== 'default' && entry)
      models.add(entry);
    else collectModels(entry, models);
  }
}

function referencedModels(root) {
  const models = new Set(['gpt-6-luna', 'gpt-6.1-sol']);
  const nativeConfig = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
  if (existsSync(nativeConfig)) {
    const configured = /^model\s*=\s*"([^"]+)"/m.exec(readFileSync(nativeConfig, 'utf8'));
    if (configured) models.add(configured[1]);
  }
  const visit = (directory, depth = 0) => {
    if (depth > 30) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        !['.git', '.issues', 'node_modules', '.output', '.agents', '.codex', 'factory'].includes(entry.name)
      )
        visit(join(directory, entry.name), depth + 1);
      if (entry.isFile() && entry.name === 'folder.md') {
        const text = readFileSync(join(directory, entry.name), 'utf8');
        const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (header) collectModels(parse(header[1], { maxAliasCount: 0 }), models);
      }
    }
  };
  visit(root);
  for (const path of ['.issues/model-settings.json', 'factory.config.json']) {
    if (existsSync(join(root, path))) collectModels(JSON.parse(readFileSync(join(root, path), 'utf8')), models);
  }
  const flows = join(root, '.issues/flows');
  if (existsSync(flows))
    for (const entry of readdirSync(flows, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json'))
        collectModels(JSON.parse(readFileSync(join(flows, entry.name), 'utf8')), models);
    }
  return models;
}

export function initializeProviderConfig(root) {
  const existing = readProviderConfig(root);
  if (existing) return existing;
  const models = [...referencedModels(root)];
  const providers = Object.fromEntries(
    Object.keys(providerNames).map((id) => [
      id,
      {
        enabled: models.filter((model) => providerForModel(model) === id),
        warning: 5,
        disable: 2,
        allowUnmonitored: false,
      },
    ])
  );
  mkdirSync(join(root, 'user'), { recursive: true });
  writeJson(providerConfigPath(root), providers);
  return readProviderConfig(root);
}

export function saveProviderConfig(root, input, catalogs) {
  const previous = initializeProviderConfig(root);
  requireThat(input.revision === previous.revision, 'Factory settings changed. Refresh before saving.');
  const providers = configSchema.parse(input.providers);
  for (const [id, policy] of Object.entries(providers)) {
    const allowed = new Set([
      ...previous.providers[id].enabled,
      ...(catalogs[id]?.models || []).map((model) => model.id),
    ]);
    requireThat(
      policy.enabled.every((model) => providerForModel(model) === id && allowed.has(model)),
      'Choose a discovered model. Custom model IDs are not supported.'
    );
    policy.enabled = [...new Set(policy.enabled)];
  }
  mkdirSync(join(root, 'user'), { recursive: true });
  writeJson(providerConfigPath(root), providers);
  return readProviderConfig(root);
}

export function quotaAvailability(policy, quota, model, now = Date.now()) {
  const windows = (quota?.windows || []).filter((window) => !window.models || window.models.includes(model));
  const known = windows.filter(
    (window) =>
      Number.isFinite(window.remainingPercent) &&
      now - window.checkedAt <= 120000 &&
      now >= window.checkedAt &&
      (!window.resetsAt || window.resetsAt * 1000 > now)
  );
  const exhausted = windows.some(
    (window) => window.remainingPercent <= 0 && (!window.resetsAt || window.resetsAt * 1000 > now)
  );
  if (exhausted) return { status: 'disabled', reason: 'Allowance exhausted.' };
  const remaining = known.length ? Math.min(...known.map((window) => window.remainingPercent)) : null;
  if (remaining !== null && remaining <= policy.disable)
    return {
      status: 'disabled',
      remaining,
      reason: `Allowance at ${remaining.toFixed(1)}% (disable at ${policy.disable}%).`,
    };
  const complete = quota?.complete !== false && windows.length > 0 && known.length === windows.length;
  if (!complete && !policy.allowUnmonitored)
    return {
      status: 'unknown',
      remaining,
      reason: 'Quota is unknown or stale. Refresh or allow work without quota monitoring.',
    };
  if (remaining !== null && remaining <= policy.warning)
    return {
      status: 'warning',
      remaining,
      reason: `Allowance at ${remaining.toFixed(1)}% (warning at ${policy.warning}%).`,
    };
  return {
    status: complete ? 'available' : 'unmonitored',
    remaining,
    reason: complete ? 'Available' : 'Quota unknown · unmonitored work allowed',
  };
}
