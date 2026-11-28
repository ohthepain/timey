import { existsSync, readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  readProviderConfig,
  providerNames,
  providerForModel,
  quotaAvailability,
  saveProviderConfig,
  saveProviderEnabled,
  initializeProviderConfig,
} from './provider-config.mjs';
import { writeJson } from './common.mjs';
import { readCodexQuota } from './codex-quota.mjs';

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
export function providerIsActive(root, id) {
  return !root || readProviderConfig(root)?.providers[id]?.active !== false;
}
export function assertProviderActive(root, id) {
  if (!providerIsActive(root, id))
    throw Object.assign(Error(`${providerNames[id]} is disabled in Factory settings.`), {
      code: 'PROVIDER_PAUSED',
      turnRejected: true,
    });
}
function observedModels(advertised, previous = []) {
  return [
    ...advertised.map((model) => ({ ...model, advertised: true })),
    ...previous
      .filter((model) => !advertised.some((entry) => entry.id === model.id))
      .map((model) => ({ ...model, advertised: false })),
  ];
}
function providerObservation(root, id, { quota, ...patch }) {
  if (quota && providerIsActive(root, id)) patch.quota = quota;
  return patch;
}
function mergeObservation(previous = {}, patch) {
  if (patch.accountKey && patch.accountKey !== previous.accountKey) patch.quota = { windows: [] };
  if (patch.models) patch.models = observedModels(patch.models, previous.models);
  return { ...previous, ...patch };
}
export function observeProvider(root, id, observation) {
  const patch = providerObservation(root, id, observation);
  if (!Object.keys(patch).length) return;
  const state = runtime(root);
  state.catalogs[id] = mergeObservation(state.catalogs[id], patch);
  mkdirSync(join(root, '.issues/factory-ui'), { recursive: true });
  writeJson(observationPath(root), state.catalogs);
  enforce(state);
}
export function modelAvailability(root, model, now = Date.now()) {
  const config = readProviderConfig(root);
  if (!config) return { status: 'available', reason: 'Legacy configuration' };
  const id = providerForModel(model),
    policy = config.providers[id];
  if (!policy.active) return { status: 'disabled', reason: `${providerNames[id]} is disabled in Factory settings.` };
  if (!policy.enabled.includes(model)) return { status: 'disabled', reason: 'Model is disabled in Factory settings.' };
  const catalog = runtime(root).catalogs[id];
  return catalogAvailability(catalog, policy, model, now);
}
function catalogAvailability(catalog = {}, policy, model, now) {
  const { ready, message = 'Set up this provider in Factory settings.', models = [], quota } = catalog;
  if (!ready) return { status: 'unavailable', reason: message };
  if (!models.some((entry) => entry.id === model && entry.advertised !== false))
    return {
      status: 'unavailable',
      reason: 'Model is no longer advertised by the native agent. Refresh available models.',
    };
  return quotaAvailability(policy, quota, model, now);
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
                { active: false, enabled: [], warning: 5, disable: 2, allowUnmonitored: false },
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

export function changeProviderEnabled(root, input) {
  saveProviderEnabled(root, input);
  if (!input.active)
    for (const watch of runtime(root).watches) if (watch.provider === input.provider) watch.allowCompletion = true;
  return providerSettings(root);
}
async function fetchQuota(root, id) {
  if (id !== 'codex') return;
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
  if (!providerIsActive(root, id)) return;
  const state = runtime(root);
  if (!state.pending.has(id))
    state.pending.set(
      id,
      fetchQuota(root, id).finally(() => state.pending.delete(id))
    );
  return state.pending.get(id);
}
function watchAvailability(root, watch) {
  try {
    if (watch.allowCompletion || !providerIsActive(root, watch.provider)) {
      watch.allowCompletion = true;
      return null;
    }
    return modelAvailability(root, watch.model);
  } catch {
    return {
      status: 'unavailable',
      reason: 'Provider settings are invalid. Repair Factory settings before continuing.',
    };
  }
}
function enforce(state) {
  for (const watch of state.watches) {
    if (watch.stopped) continue;
    const availability = watchAvailability(state.root, watch);
    if (availability && !usableModel(availability)) {
      watch.stopped = Object.assign(
        Error(`${providerNames[watch.provider]}: ${availability.reason} Resume explicitly when available.`),
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
  assertProviderActive(root, provider);
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
  const watch = { model, provider, stop, lastRefresh: Date.now() };
  state.watches.add(watch);
  const timer = setInterval(() => {
    enforce(state);
    if (Date.now() - watch.lastRefresh < 30000) return;
    watch.lastRefresh = Date.now();
    void refreshProviderQuota(root, provider).catch(() => {});
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
