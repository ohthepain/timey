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
    function migrationKey(data, input) {
      if (!data.projectId) throw Error('Refresh project stores before moving storage.');
      return (
        'factory-storage-migration:' +
        JSON.stringify([data.projectId, input.role || 'issue', input.issueId || '', input.storeId])
      );
    }
    function migrationId(data, input) {
      const key = migrationKey(data, input);
      const pending = (data.pendingMigrations || []).find(
        (item) =>
          item.storeId === input.storeId &&
          (input.role
            ? item.kind === 'move-project-store' && item.role === input.role
            : item.kind === 'move-issue' && item.issueIds.includes(input.issueId))
      );
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
    async function fill(select, { folder, issueId, selected, role = 'issue' } = {}) {
      const ticket = (selections.get(select) || 0) + 1;
      selections.set(select, ticket);
      select.disabled = true;
      select.required = true;
      select.value = '';
      const data = await read({ folder, issueId });
      if (selections.get(select) !== ticket) return data;
      if (data.unavailable) throw Error(data.warning || 'Shared storage is unavailable. Cached data is read-only.');
      const value = selected ?? (role === 'issue' ? data.selected : data[role === 'artifact' ? 'artifacts' : role]);
      const stores = data.stores.filter((store) => store.roles.includes(role));
      select.replaceChildren(
        new Option('Choose a store', ''),
        ...stores.map((store) => new Option(`${store.label} · ${store.kind}`, store.id))
      );
      select.value = stores.some((store) => store.id === value) ? value : '';
      select.disabled = false;
      return data;
    }
    async function move(issueId, storeId, { issueIds } = {}) {
      const options = await read({ issueId, migrationStoreId: storeId });
      if (options.unavailable) throw Error(options.warning || 'Shared storage is unavailable.');
      const members = options.moveGroup?.issueIds || [issueId];
      if (issueIds && JSON.stringify([...issueIds].sort()) !== JSON.stringify([...members].sort()))
        throw Error('The selected issue group changed. Review the storage move again.');
      const input = { issueId, storeId };
      const result = await post('issue-store-action', {
        action: 'move-issue',
        issueId,
        storeId,
        issueIds: members,
        operationId: migrationId(options, input),
      });
      await changed();
      const current = await read({ issueId });
      if (result.status !== 'confirmed' || current.selected !== storeId)
        throw Error('Storage move is pending reconciliation. Refresh its status before continuing.');
      finishMigration(current, input);
      return result;
    }
    return { read, fill, move, migrationId, finishMigration };
  };
})();
