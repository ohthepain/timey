import { readStoreConfig, requireStore } from './config.mjs';
import { resolveFolderSettings } from '../issue-folder-settings.mjs';

export function resolveIssueStore(root, { storeId, folder } = {}) {
  const config = readStoreConfig(root);
  let selected = storeId;
  let source = 'Explicit issue choice';
  if (!selected || selected === 'default') {
    const settings = resolveFolderSettings(root, folder || null);
    const problem = settings.errors.find(({ key }) => key === 'issue_store');
    if (problem) throw Error(problem.message);
    selected = settings.values.issue_store || config.issueDefault;
    source = settings.sources.issue_store || 'Project store default';
  }
  const store = requireStore(config, selected, 'issue');
  return { id: store.id, label: store.label, kind: store.kind, source };
}
