import { readStoreConfig, requireProfile } from './config.mjs';
import { resolveFolderSettings } from '../issue-folder-settings.mjs';

function requireValidProfileSetting(settings) {
  const problem = settings.errors.find(({ key }) => key === 'storage_profile');
  if (problem) throw Error(problem.message);
}

function inheritedProfile(root, folder, config) {
  const settings = resolveFolderSettings(root, folder || null);
  requireValidProfileSetting(settings);
  return {
    profileId: settings.values.storage_profile || config.profileDefault,
    source: settings.sources.storage_profile || 'Project storage profile default',
  };
}

export function resolveIssueStorage(root, { profileId, folder } = {}) {
  const config = readStoreConfig(root);
  const selected =
    profileId && profileId !== 'default'
      ? { profileId, source: 'Explicit issue choice' }
      : inheritedProfile(root, folder, config);
  const profile = requireProfile(config, selected.profileId);
  return {
    profileId: profile.id,
    storeId: profile.issueStore,
    artifactStoreId: profile.artifactStore,
    label: profile.label,
    source: selected.source,
  };
}

export function inheritedIssueCaptureProfile(service) {
  return service.projectStores ? 'default' : undefined;
}
