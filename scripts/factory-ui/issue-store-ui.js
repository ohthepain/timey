(() => {
  'use strict';
  async function defaultRequest(url, options) {
    const response = await fetch(url, options);
    const value = await response.json();
    if (!response.ok) throw Error(value.error || 'Could not access project storage.');
    return value;
  }
  const defaultPost = (path, value) =>
    defaultRequest('/api/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Factory-Action': 'manual' },
      body: JSON.stringify(value),
    });
  window.createIssueStoreUI = ({
    request = defaultRequest,
    post = defaultPost,
    changed = async () => {},
    storage = window.localStorage,
  }) => {
    const selections = new WeakMap();
    function migrationScope(input) {
      return [input.role || 'issue', input.issueId || ''];
    }
    function sameIssueMigration(item, input) {
      return (
        item.kind === 'move-issue' &&
        item.issueIds.includes(input.issueId) &&
        item.artifactStoreId === input.artifactStoreId
      );
    }
    function matchingMigration(item, input) {
      if (item.storeId !== input.storeId) return false;
      if (input.role) return item.kind === 'move-project-store' && item.role === input.role;
      return sameIssueMigration(item, input);
    }
    function migrationKey(data, input) {
      if (!data.projectId) throw Error('Refresh project stores before moving storage.');
      return (
        'factory-storage-migration:' +
        JSON.stringify([data.projectId, ...migrationScope(input), input.storeId, input.artifactStoreId || ''])
      );
    }
    function migrationId(data, input) {
      const key = migrationKey(data, input);
      const pending = (data.pendingMigrations || []).find((item) => matchingMigration(item, input));
      try {
        const id = pending?.operationId || storage.getItem(key) || crypto.randomUUID();
        storage.setItem(key, id);
        return id;
      } catch {
        throw Error('Allow browser storage to retain storage-move retry identities before continuing.');
      }
    }
    function finishMigration(data, input) {
      storage.removeItem(migrationKey(data, input));
    }
    async function read(input = {}) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(input)) if (value) query.set(key, value);
      return request('/api/issue-stores' + (query.size ? '?' + query : ''));
    }
    function requireAvailable(data) {
      if (data.unavailable) throw Error(data.warning || 'Shared storage is unavailable. Cached data is read-only.');
    }
    function requireInheritedSelection(data, role, selected) {
      if (role !== 'issue') return;
      if (selected !== undefined) return;
      if (data.selectionError) throw Error(data.selectionError);
    }
    function roleSelection(data, role) {
      if (role === 'issue') return data.selected;
      return data[role === 'artifact' ? 'artifacts' : role];
    }
    function storageChoices(data, role) {
      if (role === 'issue')
        return data.profiles
          .filter((profile) => !profile.retired)
          .map((profile) => ({ id: profile.id, label: profile.label }));
      return data.stores.filter((store) => store.roles.includes(role));
    }
    function renderSelection(select, choices, value, role) {
      select.replaceChildren(
        new Option(role === 'issue' ? 'Choose a profile' : 'Choose a store', ''),
        ...choices.map((choice) => new Option(choice.label, choice.id))
      );
      select.value = choices.some((choice) => choice.id === value) ? value : '';
      select.disabled = false;
    }
    async function fill(select, { folder, issueId, selected, role = 'issue' } = {}) {
      const ticket = (selections.get(select) || 0) + 1;
      selections.set(select, ticket);
      select.disabled = true;
      select.required = true;
      select.value = '';
      const data = await read({ folder, issueId });
      if (selections.get(select) !== ticket) return data;
      requireAvailable(data);
      requireInheritedSelection(data, role, selected);
      renderSelection(select, storageChoices(data, role), selected ?? roleSelection(data, role), role);
      return data;
    }
    function savedLabel(data) {
      if (!data.savedStorage) return '';
      const name = (id) => data.stores.find((store) => store.id === id)?.label || id;
      return `Issue records: ${name(data.savedStorage.storeId)} · Artifacts: ${name(data.savedStorage.artifactStoreId)}`;
    }
    function sameStorage(actual, expected) {
      return actual?.storeId === expected.storeId && actual?.artifactStoreId === expected.artifactStoreId;
    }
    function moveMembers(options, issueId) {
      return options.moveGroup?.issueIds || [issueId];
    }
    function requireReviewedMembers(expected, actual) {
      if (!expected) return;
      if (JSON.stringify([...expected].sort()) !== JSON.stringify([...actual].sort()))
        throw Error('The selected issue group changed. Review the storage move again.');
    }
    function moveTarget(options, expected) {
      if (!options.targetStorage) throw Error('Choose a valid storage profile before moving the issue.');
      if (expected && !sameStorage(options.targetStorage, expected))
        throw Error('The storage profile changed. Review the destinations before moving the issue.');
      return options.targetStorage;
    }
    async function confirmMove(result, issueId, target) {
      await changed();
      const current = await read({ issueId });
      if (result.status !== 'confirmed')
        throw Error('Storage move is pending reconciliation. Refresh its status before continuing.');
      if (!sameStorage(current.savedStorage, target))
        throw Error('Storage move is pending reconciliation. Refresh its status before continuing.');
      finishMigration(current, { issueId, storeId: target.storeId, artifactStoreId: target.artifactStoreId });
      return result;
    }
    async function move(issueId, storageProfile, { issueIds, expectedStorage } = {}) {
      const options = await read({ issueId, migrationStorageProfile: storageProfile });
      requireAvailable(options);
      const members = moveMembers(options, issueId);
      requireReviewedMembers(issueIds, members);
      const target = moveTarget(options, expectedStorage);
      const input = { issueId, ...target };
      const result = await post('issue-store-action', {
        action: 'move-issue',
        issueId,
        storageProfile,
        expectedStorage: target,
        issueIds: members,
        operationId: migrationId(options, input),
      });
      return confirmMove(result, issueId, target);
    }
    function retainedMove(options, issueId, operationId) {
      return (options.pendingMigrations || []).find(
        (item) => item.kind === 'move-issue' && item.operationId === operationId && item.issueIds.includes(issueId)
      );
    }
    async function resumeMove(issueId, operationId) {
      const options = await read({ issueId });
      requireAvailable(options);
      const pending = retainedMove(options, issueId, operationId);
      if (!pending?.artifactStoreId) throw Error('Refresh the issue to find its retained storage move.');
      const result = await post('issue-store-action', { action: 'resume-move', issueId, operationId });
      return confirmMove(result, issueId, pending);
    }
    return { read, fill, move, resumeMove, savedLabel, migrationId, finishMigration };
  };
})();
