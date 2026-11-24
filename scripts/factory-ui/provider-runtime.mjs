import { existsSync, readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  readProviderConfig,
  providerNames,
  providerForModel,
  quotaAvailability,
  saveProviderConfig,
  initializeProviderConfig,
} from './provider-config.mjs';
import { writeJson } from './common.mjs';

const runtimes = new Map();
const observationPath = (root) => join(root, '.issues/factory-ui/provider-observations.json');
function runtime(root) {
  const key = realpathSync(root);
  if (!runtimes.has(key)) {
    const path = observationPath(key);
    const catalogs = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    runtimes.set(key, { root: key, catalogs, watches: new Set(), pending: new Map() });
  }
  return runtimes.get(key);
}
export function providerCatalogs(root) {
  return runtime(root).catalogs;
}
export function observeProvider(root, id, patch) {
  const state = runtime(root);
  if (patch.accountKey && patch.accountKey !== state.catalogs[id]?.accountKey)
    patch = { ...patch, quota: { windows: [] } };
  if (patch.models) {
    const previous = state.catalogs[id]?.models || [];
    patch = {
      ...patch,
      models: [
        ...patch.models.map((model) => ({ ...model, advertised: true })),
        ...previous
          .filter((model) => !patch.models.some((entry) => entry.id === model.id))
          .map((model) => ({ ...model, advertised: false })),
      ],
    };
  }
  state.catalogs[id] = { ...state.catalogs[id], ...patch };
  mkdirSync(join(root, '.issues/factory-ui'), { recursive: true });
  writeJson(observationPath(root), state.catalogs);
  enforce(state);
}
export function modelAvailability(root, model, now = Date.now()) {
  const config = readProviderConfig(root);
  if (!config) return { status: 'available', reason: 'Legacy configuration' };
  const id = providerForModel(model),
    policy = config.providers[id];
  if (!policy.enabled.includes(model)) return { status: 'disabled', reason: 'Model is disabled in Factory settings.' };
  const catalog = runtime(root).catalogs[id];
  if (!catalog?.ready)
    return { status: 'unavailable', reason: catalog?.message || 'Set up this provider in Factory settings.' };
  if (!catalog.models?.some((entry) => entry.id === model && entry.advertised !== false))
    return {
      status: 'unavailable',
      reason: 'Model is no longer advertised by the native agent. Refresh available models.',
    };
  return quotaAvailability(policy, catalog.quota, model, now);
}
const usableModel = (value) => ['available', 'warning', 'unmonitored'].includes(value.status);
export function providerModelChoices(root) {
  if (!readProviderConfig(root)) return null;
  return Object.values(runtime(root).catalogs)
    .flatMap((catalog) => catalog.models || [])
    .filter((model) => usableModel(modelAvailability(root, model.id)))
    .map((model) => ({ value: model.id, label: model.name, description: model.description || model.name }));
}
export function providerModelMetadata(root) {
  const config = readProviderConfig(root);
  if (!config) return null;
  const ids = new Set(Object.values(config.providers).flatMap((policy) => policy.enabled));
  for (const catalog of Object.values(providerCatalogs(root)))
    for (const model of catalog.models || []) ids.add(model.id);
  return Object.fromEntries([...ids].map((id) => [id, modelAvailability(root, id)]));
}
export function providerSettings(root, { initialize = true } = {}) {
  const config =
      readProviderConfig(root) ||
      (initialize
        ? initializeProviderConfig(root)
        : {
            revision: null,
            providers: Object.fromEntries(
              Object.keys(providerNames).map((id) => [
                id,
                { enabled: [], warning: 5, disable: 2, allowUnmonitored: false },
              ])
            ),
          }),
    catalogs = providerCatalogs(root);
  return {
    revision: config.revision,
    readOnly: !initialize,
    providers: Object.entries(providerNames).map(([id, name]) => {
      const policy = config.providers[id],
        catalog = catalogs[id];
      const models = [...(catalog?.models || [])];
      for (const model of policy.enabled)
        if (!models.some((entry) => entry.id === model)) models.push({ id: model, name: model });
      return {
        id,
        name,
        ...policy,
        ready: Boolean(catalog?.ready),
        message: catalog?.message || 'Not set up',
        setup: catalog?.setup || null,
        checkedAt: catalog?.checkedAt || null,
        models: models.map((model) => ({
          ...model,
          enabled: policy.enabled.includes(model.id),
          availability: modelAvailability(root, model.id),
        })),
      };
    }),
  };
}
export function saveProviderSettings(root, input) {
  const before = readProviderConfig(root);
  if (before)
    for (const [id, policy] of Object.entries(before.providers)) {
      const catalog = providerCatalogs(root)[id];
      const models = [...(catalog?.models || [])];
      for (const model of policy.enabled)
        if (!models.some((entry) => entry.id === model)) models.push({ id: model, name: model, advertised: false });
      if (models.length !== catalog?.models?.length) {
        const state = runtime(root);
        state.catalogs[id] = { ...catalog, models };
        mkdirSync(join(root, '.issues/factory-ui'), { recursive: true });
        writeJson(observationPath(root), state.catalogs);
      }
    }
  saveProviderConfig(root, input, providerCatalogs(root));
  enforce(runtime(root));
  return providerSettings(root);
}
async function fetchQuota(root, id) {
  if (id !== 'codex') return;
  const { readCodexQuota } = await import('./codex-quota.mjs');
  const value = await readCodexQuota({ force: true });
  // Named Codex allowance pools are not necessarily shared across all models.
  // Use only the documented default Codex pool; unknown pools cannot be assigned.
  if (value.status !== 'available') return;
  const limits = value.limits?.filter((limit) => !limit.id || limit.id === 'codex') || [];
  const windows = limits.flatMap((limit) => limit.windows.map((window) => ({ ...window, checkedAt: value.checkedAt })));
  if (value.limits?.some((limit) => limit.id && limit.id !== 'codex'))
    windows.push({ id: 'unmapped-pool', remainingPercent: null, checkedAt: value.checkedAt });
  if (windows.length) observeProvider(root, id, { quota: { windows } });
}
export async function refreshProviderQuota(root, id) {
  const state = runtime(root);
  if (!state.pending.has(id))
    state.pending.set(
      id,
      fetchQuota(root, id).finally(() => state.pending.delete(id))
    );
  return state.pending.get(id);
}
function enforce(state) {
  for (const watch of state.watches) {
    if (watch.stopped) continue;
    let availability;
    try {
      availability = modelAvailability(state.root, watch.model);
    } catch {
      availability = {
        status: 'unavailable',
        reason: 'Provider settings are invalid. Repair Factory settings before continuing.',
      };
    }
    if (!usableModel(availability)) {
      watch.stopped = Object.assign(
        Error(
          `${providerNames[providerForModel(watch.model)]}: ${availability.reason} Resume explicitly when available.`
        ),
        { code: 'PROVIDER_PAUSED' }
      );
      void Promise.resolve()
        .then(() => watch.stop(watch.stopped))
        .catch(() => {});
    }
  }
}
export function assertProviderModelReady(root, model) {
  const config = readProviderConfig(root);
  if (!config) return null;
  const provider = providerForModel(model);
  if (!config.providers[provider].enabled.includes(model))
    throw Object.assign(Error('Model is disabled in Factory settings.'), {
      code: 'PROVIDER_PAUSED',
      turnRejected: true,
    });
  const initial = modelAvailability(root, model);
  if (initial.status === 'unavailable')
    throw Object.assign(Error(initial.reason), { code: 'PROVIDER_PAUSED', turnRejected: true });
  return provider;
}
export async function guardProviderWork(root, model, stop) {
  const provider = root && assertProviderModelReady(root, model);
  if (!provider) return { close() {}, assert() {} };
  await refreshProviderQuota(root, provider);
  const state = runtime(root),
    availability = modelAvailability(root, model);
  if (!usableModel(availability))
    throw Object.assign(Error(`${providerNames[provider]}: ${availability.reason}`), {
      code: 'PROVIDER_PAUSED',
      turnRejected: true,
    });
  const watch = { model, stop, lastRefresh: Date.now() };
  state.watches.add(watch);
  const timer = setInterval(() => {
    enforce(state);
    if (Date.now() - watch.lastRefresh < 30000) return;
    watch.lastRefresh = Date.now();
    void refreshProviderQuota(root, providerForModel(model)).catch(() => {});
  }, 1000);
  timer.unref();
  return {
    close() {
      clearInterval(timer);
      state.watches.delete(watch);
    },
    assert() {
      if (watch.stopped) throw watch.stopped;
    },
  };
}

export function monitorProviders(root) {
  const timer = setInterval(() => {
    for (const [id, catalog] of Object.entries(providerCatalogs(root))) {
      if (catalog.ready) void refreshProviderQuota(root, id).catch(() => {});
    }
  }, 30000);
  timer.unref();
  return () => clearInterval(timer);
}
