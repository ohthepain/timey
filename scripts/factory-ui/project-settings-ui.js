(() => {
  'use strict';
  const pages = [
    ['issues', 'Issues'],
    ['app', 'App'],
    ['lifecycle', 'Issue Lifecycle'],
    ['git', 'Git'],
    ['storage', 'Issue Storage'],
    ['asset-storage', 'Asset Storage'],
    ['providers', 'AI providers', 'AI'],
    ['skills', 'Skills'],
    ['prompts', 'Prompts'],
    ['hotkeys', 'Hotkeys'],
  ];
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  const pre = (value) => `<pre>${esc(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</pre>`;
  const source = (value) => `<small class="muted" data-settings-source>Source · ${esc(value)}</small>`;
  const saveButton =
    '<div data-settings-save><button class="primary-button" type="submit">Save</button><span data-settings-status role="status"></span></div>';
  const promptNames = {
    project: 'Project chat prompts',
    issue: 'Issue chat prompts',
    report: 'Report chat prompts',
    investigation: 'Investigation chat prompts',
  };
  const hotkeyNames = {
    dictateHot: 'Dictate HOT',
    dictateCold: 'Dictate COLD',
    newNote: 'New Note',
    newIssue: 'New Issue',
  };

  window.createProjectSettingsUI = ({ request, changed }) => {
    const view = document.getElementById('project-settings-view');
    const workspace = document.getElementById('app');
    const header = document.querySelector('.factory-header');
    let returnFocus;
    let pendingProviderSetup = null;
    const content = document.getElementById('project-settings-content');
    const error = document.getElementById('project-settings-error');
    const unsaved = document.getElementById('settings-unsaved-dialog');
    let page = null;
    let data = null;
    let baseline = '';
    let savedStoreConfiguration = '';
    let busy = false;
    let pending = null;
    let sequence = 0;
    const resetPrompts = new Set();
    const post = (path, value) =>
      request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Factory-Action': 'manual' },
        body: JSON.stringify(value),
      });
    const issueStoreUI = window.createIssueStoreUI({ request });
    const form = () => content.querySelector('[data-settings-form]');
    const values = () =>
      Object.fromEntries(
        [...content.querySelectorAll('[data-settings-form]')].flatMap((element) => [...new FormData(element)])
      );
    const snapshot = () => JSON.stringify([values(), [...resetPrompts]]);
    const dirty = () => baseline !== snapshot();
    function showError(message = '') {
      error.textContent = message;
      error.hidden = !message;
    }
    function updateUrl(value) {
      const url = new URL(location.href);
      if (value) url.searchParams.set('settings', value);
      else url.searchParams.delete('settings');
      history.replaceState(null, '', url);
    }
    function pageUrl(value) {
      const url = new URL(location.href);
      url.searchParams.set('settings', value);
      return url.pathname + url.search + url.hash;
    }
    function navigation() {
      document.getElementById('settings-navigation').innerHTML = pages
        .map(
          ([id, label, group]) =>
            `${group ? `<p data-settings-group>${group}</p>` : ''}<a href="${esc(pageUrl(id))}" data-settings-page="${id}"${id === page ? ' aria-current="page"' : ''}>${label}</a>`
        )
        .join('');
    }
    function renderIssues() {
      if (data.kind === 'plain')
        return '<p>No project folder.md exists yet.</p><button type="button" data-settings-create>Create project defaults</button>';
      return `<p>Project defaults are inherited by folders and issues unless overridden.</p><form data-settings-form><div class="folder-settings-fields">${data.fields
        .filter(({ key }) =>
          ['storage_profile', 'branch', 'skill', 'model', 'effort', 'selection_strategy'].includes(key)
        )
        .map((field) => window.factorySettingField(field, data.settings[field.key], 'settings'))
        .join('')}</div>${source(data.path || 'folder.md')}${saveButton}</form>`;
    }
    function humanPolicyText(policy) {
      const policyText = [
        'Required human input is checked before dependent work proceeds.',
        policy.require_explicit_acceptance ? 'Closing a fixed issue requires explicit user acceptance.' : '',
        !policy.manual_checks_before_commit ? 'Local progress commits can retain outstanding human checks.' : '',
        'Each issue keeps its own requests and approvals. There is no policy preset selector.',
      ].filter(Boolean);
      return policyText.map((text) => `<p>${text}</p>`).join('');
    }
    function renderLifecycle() {
      const { lifecycle } = data;
      return `<h3>Lifecycle configuration</h3><p>${esc(lifecycle.path)}</p><button class="small-button" type="button" data-settings-action="open-lifecycle"${lifecycle.present ? '' : ' disabled'}>Open file</button><p>Project override · ${esc(lifecycle.overridePath)} · ${lifecycle.overrideExists ? 'Present' : 'Absent'}</p>${source(lifecycle.effectiveSource)}<details><summary>Effective configuration</summary>${pre(lifecycle.content)}</details><h3>Effective labels</h3>${lifecycle.labels.map((label) => `<p>${esc(label.role)} · ${esc(label.state)} · ${esc(label.meaning)}${source(label.source)}</p>`).join('')}${!lifecycle.present ? '<button class="small-button" type="button" data-settings-initialize>Initialize lifecycle configuration</button>' : ''}<h3>Human input</h3>${humanPolicyText(data.humanInputPolicy)}<button type="button" class="file-link" data-settings-action="open-policy">${esc(data.humanInputSource)}</button>`;
    }
    function references(connection) {
      return `<ul data-settings-references>${connection.references.map((ref) => `<li><code>${esc(ref.name)}</code> · ${ref.available ? 'Available' : 'Unavailable'}${source(ref.source)}</li>`).join('')}</ul>`;
    }
    function renderGit() {
      const git = data.git;
      return `<h3>GitHub App connection</h3><p>Repository · ${esc(git.repository || 'Not configured')}</p><p>Remote · ${esc(git.remote || 'Not configured')} · Target · ${esc(git.target || 'Not configured')}</p>${references(git)}<p>Required permissions</p>${pre(git.permissionsRequired)}<button class="small-button" type="button" data-settings-action="test-git">Test connection</button><p data-connection-result role="status"></p><h3>Maintenance</h3><p>Each operation opens its existing Admin preview and confirmation.</p><div data-settings-operations>${[
        ['admin-prune-worktrees', 'Prune Worktrees'],
        ['admin-remote-open', 'Clean up remote branches'],
        ['admin-local-open', 'Clean up local branches'],
        ['admin-archive-open', 'Delete archived issues'],
      ]
        .map(
          ([id, label]) =>
            `<button class="small-button" type="button" data-settings-maintenance="${id}">${label}</button>`
        )
        .join('')}</div><a href="/?projectTab=admin" data-settings-admin>Open Admin</a>`;
    }
    function storeField(store, key, label) {
      const readonly = key === 'schema' || (key !== 'label' && !store.unsaved);
      return `<label class="field">${esc(label)}<input name="store:${esc(store.id)}:${key}" value="${esc(store[key] || '')}"${readonly ? ' readonly' : ''} /></label>`;
    }
    function configuredStore(store) {
      const fields = {
        postgres: [['schema', 'Schema']],
        dynamodb: [
          ['table', 'Table'],
          ['region', 'Region'],
        ],
        s3: [
          ['bucket', 'Bucket override'],
          ['region', 'Region override'],
          ['prefix', 'Prefix'],
        ],
        git: [
          ['remote', 'Remote'],
          ['branch', 'Queue branch'],
        ],
        files: [],
      }[store.kind];
      const diskUsage =
        store.kind === 'postgres' && !store.unsaved
          ? `<section data-store-usage><h4>Disk usage</h4><button type="button" class="small-button" data-store-usage-refresh="${esc(store.id)}">Refresh</button><p data-store-usage-status role="status"></p><ul data-store-usage-tables></ul></section>`
          : '';
      return `<fieldset data-store-check><legend>${esc(store.label)} · ${esc(store.kind)}</legend>${storeField(store, 'label', 'Name')}${fields.map(([key, label]) => storeField(store, key, label)).join('')}${store.references ? references(store) : '<p>Connection references are checked after saving.</p>'}<button type="button" class="small-button" data-store-test="${esc(store.id)}"${store.unsaved ? ' disabled' : ''}>Test store connection</button><p data-store-result="${esc(store.id)}" role="status"></p>${diskUsage}</fieldset>`;
    }
    function storeOptions(role, selected) {
      const registry = data.storeRegistry;
      return registry.stores
        .filter(
          (store) =>
            store.roles.includes(role) && (registry.mode === 'local' ? store.kind === 'files' : store.kind !== 'files')
        )
        .map(
          (store) =>
            `<option value="${esc(store.id)}"${store.id === selected ? ' selected' : ''}>${esc(store.label)} · ${esc(store.kind === 'files' ? 'Local files' : store.kind)}</option>`
        )
        .join('');
    }
    function roleChoice(role, label, selected) {
      const key = role === 'artifact' ? 'artifacts' : role;
      if (role === 'coordination')
        return `<div data-store-check><label class="field" for="settings-coordination-store">${label}</label><div data-coordination-store-choice><select id="settings-coordination-store" name="role:${key}" required><option value="">Choose a store</option>${storeOptions(role, selected)}</select><button type="button" class="small-button" data-store-test-role="coordination">Test connection</button></div><p data-store-result role="status"></p></div>`;
      return `<label class="field">${label}<select name="role:${key}" required><option value="">Choose a store</option>${storeOptions(role, selected)}</select></label>`;
    }
    function configuredProfile(profile) {
      return `<fieldset data-storage-profile="${esc(profile.id)}"><legend>${esc(profile.label)}</legend><label class="field">Profile name<input name="profile:${esc(profile.id)}:label" value="${esc(profile.label)}" required maxlength="100" /></label><label class="field">Issue store<select name="profile:${esc(profile.id)}:issueStore" required><option value="">Choose a store</option>${storeOptions('issue', profile.issueStore)}</select></label><label class="field">Artifact store<select name="profile:${esc(profile.id)}:artifactStore" required><option value="">Choose a store</option>${storeOptions('artifact', profile.artifactStore)}</select></label><label class="field">Available for new selections<select name="profile:${esc(profile.id)}:retired"><option value="false"${profile.retired ? '' : ' selected'}>Available</option><option value="true"${profile.retired ? ' selected' : ''}>Retired</option></select></label></fieldset>`;
    }
    function renderStoreSettings() {
      const registry = data.storeRegistry;
      if (!registry) return '<p>Store configuration is unavailable.</p>';
      const kinds = registry.mode === 'local' ? ['files'] : ['git', 'postgres', 'dynamodb', 's3'];
      return `<h3>Project storage</h3><p>Profiles select Issue and Artifact destinations for new issues. Existing issues keep their saved destinations. Changing project Coordination storage performs a checked migration.</p>${pendingDeletions(registry)}<section data-storage-recovery><button type="button" class="small-button" data-store-discover>Find unfinished storage moves</button><p data-store-discovery-status role="status"></p><div data-pending-storage-moves></div></section><form data-settings-form data-store-settings><p>Project storage mode · ${registry.mode === 'local' ? 'Local' : 'Remote'}</p><p>Changing modes requires preparing a compatible project configuration before startup.</p>${roleChoice('coordination', 'Coordination store', registry.coordination)}${roleChoice('artifact', 'Coordination artifact store', registry.artifacts)}<h3>Issue storage profiles</h3><label class="field">Project profile default<select name="profileDefault" required><option value="">Choose a profile</option>${registry.profiles
        .filter((profile) => !profile.retired)
        .map(
          (profile) =>
            `<option value="${esc(profile.id)}"${profile.id === registry.profileDefault ? ' selected' : ''}>${esc(profile.label)}</option>`
        )
        .join(
          ''
        )}</select></label><p>Folders can override the profile default on the Issues page. Editing or retiring a profile never moves existing issues.</p>${registry.profiles.map(configuredProfile).join('')}<button type="button" class="small-button" data-profile-add>Add profile</button><h3>Configured destinations</h3><p>To change an existing connection, add a destination and perform a checked move.</p>${registry.stores.map(configuredStore).join('')}<label class="field">Add a configured store<select data-store-kind>${kinds.map((kind) => `<option value="add-${kind}">${kind === 'files' ? 'Local files' : kind}</option>`).join('')}</select></label><button type="button" class="small-button" data-store-add>Add store</button>${saveButton}</form>`;
    }
    function pendingDeletions(registry) {
      return (registry.pendingDeletions || [])
        .map(
          ({ operationId, canPause }) =>
            `<section data-pending-deletion><p>Issue deletion is holding shared changes. ${canPause ? 'Pause deletion to keep the issue and restore shared changes.' : 'Resume cleanup to restore shared changes.'}</p><button type="button" class="small-button" data-store-resume-delete="${esc(operationId)}"${registry.unavailable ? ' disabled' : ''}>Resume deletion</button>${canPause ? ` <button type="button" class="small-button" data-store-pause-delete="${esc(operationId)}"${registry.unavailable ? ' disabled' : ''}>Pause deletion</button>` : ''}</section>`
        )
        .join('');
    }
    function addedStore(kind) {
      const roles =
        kind === 's3'
          ? ['artifact']
          : kind === 'dynamodb'
            ? ['issue', 'coordination']
            : ['issue', 'coordination', 'artifact'];
      return {
        id: 'store-' + crypto.randomUUID(),
        label: 'New ' + kind + ' store',
        kind,
        roles,
        unsaved: true,
        ...(kind === 'postgres' && {
          schema: 'factory',
          urlEnv: 'FACTORY_ISSUES_DB_URL',
          userEnv: 'FACTORY_DB_USER',
          passwordEnv: 'FACTORY_DB_PASSWORD',
        }),
        ...(kind === 'dynamodb' && { table: '', regionEnv: 'AWS_REGION' }),
        ...(kind === 's3' && { bucketEnv: 'FACTORY_ARTIFACTS_BUCKET', regionEnv: 'FACTORY_ARTIFACTS_BUCKET_REGION' }),
        ...(kind === 'git' && { remote: 'origin', branch: 'issue-queue' }),
      };
    }
    function addStore() {
      const original = baseline;
      retainStoreFields(values());
      retainProfileFields(values());
      data.storeRegistry.stores.push(addedStore(content.querySelector('[data-store-kind]').value.replace(/^add-/, '')));
      render();
      baseline = original;
    }
    function retainStoreFields(fields) {
      for (const store of data.storeRegistry.stores)
        for (const [name, value] of Object.entries(fields)) {
          const prefix = `store:${store.id}:`;
          if (!name.startsWith(prefix)) continue;
          const key = name.slice(prefix.length);
          if (value.trim()) store[key] = value.trim();
          else delete store[key];
        }
    }
    function retainProfile(profile, fields) {
      const prefix = `profile:${profile.id}:`;
      for (const key of ['label', 'issueStore', 'artifactStore'])
        if (Object.hasOwn(fields, prefix + key)) profile[key] = fields[prefix + key].trim();
      if (Object.hasOwn(fields, prefix + 'retired')) profile.retired = fields[prefix + 'retired'] === 'true';
    }
    function retainProfileFields(fields) {
      const registry = data.storeRegistry;
      registry.profileDefault = fields.profileDefault || registry.profileDefault;
      for (const profile of registry.profiles) retainProfile(profile, fields);
    }
    function addProfile() {
      const original = baseline;
      const fields = values();
      retainStoreFields(fields);
      retainProfileFields(fields);
      data.storeRegistry.profiles.push({
        id: 'profile-' + crypto.randomUUID(),
        label: 'New profile',
        issueStore: '',
        artifactStore: '',
        retired: false,
      });
      render();
      baseline = original;
    }
    function storeConfiguration(registry) {
      const config = Object.fromEntries(
        ['version', 'projectId', 'mode', 'profileDefault', 'coordination', 'artifacts', 'profiles', 'stores'].map(
          (key) => [key, registry[key]]
        )
      );
      config.stores = config.stores.map(({ unsaved: _unsaved, references: _references, ...store }) => store);
      return config;
    }
    async function saveStoreConfiguration(fields) {
      const registry = data.storeRegistry;
      retainStoreFields(fields);
      retainProfileFields(fields);
      const next = storeConfiguration(registry);
      if (JSON.stringify(next) !== savedStoreConfiguration) {
        const saved = await post('/api/issue-store-action', {
          action: 'configure',
          revision: registry.revision,
          config: next,
        });
        Object.assign(registry, saved);
        savedStoreConfiguration = JSON.stringify(storeConfiguration(registry));
      }
      return registry;
    }
    async function saveStoreSettings(fields) {
      const registry = await saveStoreConfiguration(fields);
      const changes = Object.fromEntries(
        data.storage.editableFields
          .filter((key) => fields[key] !== String(data.storage.configuration[key]))
          .map((key) => [key, fields[key] === 'true'])
      );
      if (Object.keys(changes).length)
        data.storage = await post('/api/project-settings', {
          action: 'save-storage',
          revision: data.storage.revision,
          changes,
        });
      for (const role of ['coordination', 'artifacts']) {
        const storeId = fields['role:' + role];
        if (!storeId || storeId === registry[role]) continue;
        const input = { role, storeId };
        const options = await issueStoreUI.read({ migrationStoreId: storeId });
        const result = await post('/api/issue-store-action', {
          action: 'move-role',
          role,
          storeId,
          operationId: issueStoreUI.migrationId(options, input),
        });
        const confirmed = await request('/api/issue-stores');
        Object.assign(registry, confirmed);
        savedStoreConfiguration = JSON.stringify(storeConfiguration(registry));
        if (result.status !== 'confirmed' || confirmed[role] !== storeId)
          throw Error('Project storage move is pending reconciliation. Refresh its status before continuing.');
        issueStoreUI.finishMigration(confirmed, input);
      }
      return data;
    }
    function storeToTest(button) {
      const role = button.dataset.storeTestRole;
      const storeId = role ? form().elements['role:' + role].value : button.dataset.storeTest;
      const store = data.storeRegistry.stores.find(({ id }) => id === storeId);
      if (!store) throw Error('Choose a store to test.');
      if (store.unsaved) throw Error('Save the configured store before testing its connection.');
      return { storeId: store.id, role: role || store.roles[0] };
    }
    async function testStore(button) {
      const output = button.closest('[data-store-check]').querySelector('[data-store-result]');
      button.disabled = true;
      output.textContent = 'Testing connection…';
      try {
        const result = await post('/api/issue-store-action', {
          action: 'test',
          ...storeToTest(button),
        });
        output.textContent = result.message || 'Connection verified.';
      } catch (failure) {
        output.textContent = failure.message;
      } finally {
        button.disabled = false;
      }
    }
    async function refreshDiskUsage(button) {
      const section = button.closest('[data-store-usage]');
      const status = section.querySelector('[data-store-usage-status]');
      const tables = section.querySelector('[data-store-usage-tables]');
      button.disabled = true;
      status.textContent = 'Reading disk usage…';
      tables.replaceChildren();
      try {
        const usage = await request(
          '/api/issue-store-disk-usage?' +
            new URLSearchParams({
              store: button.dataset.storeUsageRefresh,
            })
        );
        status.textContent = 'Database total · ' + usage.total;
        tables.innerHTML = usage.tables.map(({ name, size }) => `<li>${esc(name)} · ${esc(size)}</li>`).join('');
      } catch (failure) {
        status.textContent = failure.message;
      } finally {
        button.disabled = false;
      }
    }
    function requireStorageDiscovery(found) {
      if (found.unavailable)
        throw Error(found.warning || 'Storage is unavailable. Retry discovery after restoring its connection.');
    }
    function storageMoveSummary(move) {
      const subject = move.kind === 'move-issue' ? `${move.issueIds.length} issue(s)` : move.role;
      return `<p>${esc(subject)} · ${esc(move.storeId)} <button type="button" class="small-button" data-store-resume-move="${esc(move.operationId)}">Resume storage move</button></p>`;
    }
    function storageUpdateSummary({ kind, operationId, issueId, ownerBound }) {
      const issue = issueId ? ` · <a href="/?issue=${encodeURIComponent(issueId)}">Open issue</a>` : '';
      const reconcile = ownerBound
        ? ` <button type="button" class="small-button" data-store-reconcile-flow="${esc(operationId)}">Reconcile stale save</button>`
        : '';
      return `<p>Pending ${esc(kind)} · ${esc(operationId)}${issue}${reconcile}</p>`;
    }
    function renderDiscoveredMoves(section, { pendingMigrations: moves, pendingUpdates, pendingDeletions }) {
      const updates = [...pendingUpdates, ...pendingDeletions];
      const entries = moves.map(storageMoveSummary).concat(updates.map(storageUpdateSummary)).join('');
      data.storeRegistry.pendingMigrations = moves;
      section.querySelector('[data-pending-storage-moves]').innerHTML = entries;
      section.querySelector('[data-store-discovery-status]').textContent = entries
        ? 'Unfinished storage operations found.'
        : 'No unfinished storage operations found.';
    }
    async function discoverStorageMoves(button) {
      const ticket = sequence;
      const section = button.closest('[data-storage-recovery]');
      const output = section.querySelector('[data-store-discovery-status]');
      button.disabled = true;
      output.textContent = 'Searching retained storage history…';
      try {
        const found = await issueStoreUI.read({ discoverMigrations: true });
        if (ticket !== sequence) return;
        requireStorageDiscovery(found);
        renderDiscoveredMoves(section, found);
      } catch (failure) {
        output.textContent = failure.message;
      } finally {
        button.disabled = false;
      }
    }
    async function resumeProjectStorageMove(move) {
      const result = await post('/api/issue-store-action', {
        action: 'move-role',
        role: move.role,
        storeId: move.storeId,
        operationId: move.operationId,
      });
      if (result.status !== 'confirmed')
        throw Error('Storage move is still pending. Retry after storage is available.');
    }
    function continueStorageMove(move) {
      if (move.kind === 'move-issue') return issueStoreUI.resumeMove(move.issueIds[0], move.operationId);
      return resumeProjectStorageMove(move);
    }
    async function resumeStorageMove(button) {
      const move = data.storeRegistry.pendingMigrations.find(
        ({ operationId }) => operationId === button.dataset.storeResumeMove
      );
      if (!move) return;
      button.disabled = true;
      showError();
      try {
        await continueStorageMove(move);
        Object.assign(data.storeRegistry, await request('/api/issue-stores'));
        render();
      } catch (failure) {
        showError(failure.message);
      } finally {
        button.disabled = false;
      }
    }
    async function controlDeletion(button) {
      const { storeResumeDelete, storePauseDelete } = button.dataset;
      button.disabled = true;
      showError();
      try {
        const result = await post('/api/issue-store-action', {
          action: storePauseDelete ? 'pause-proposal-delete' : 'resume-delete',
          operationId: storePauseDelete || storeResumeDelete,
        });
        if (result.status !== (storePauseDelete ? 'paused' : 'confirmed'))
          throw Error('Factory could not confirm the deletion update. Refresh Issue Storage and try again.');
        Object.assign(data.storeRegistry, await request('/api/issue-stores'));
        render();
      } catch (failure) {
        showError(failure.message);
      } finally {
        button.disabled = false;
      }
    }
    async function reconcileFlowSave(button) {
      button.disabled = true;
      showError();
      try {
        await post('/api/issue-store-action', {
          action: 'reconcile-flow-save',
          operationId: button.dataset.storeReconcileFlow,
        });
        button.parentElement.textContent = 'Superseded flow save reconciled. Its history was retained.';
      } catch (failure) {
        showError(failure.message);
        button.disabled = false;
      }
    }
    function renderStorage() {
      const storage = data.storage;
      const fields = Object.entries(storage.configuration)
        .map(([key, value]) =>
          storage.editableFields.includes(key)
            ? `<label class="field">${esc(key)}<select name="${esc(key)}"><option value="true"${value ? ' selected' : ''}>Enabled</option><option value="false"${!value ? ' selected' : ''}>Disabled</option></select></label>`
            : `<p>${esc(key)} · ${esc(value)}</p>`
        )
        .join('');
      return `${renderStoreSettings()}<h3>Existing Git publication</h3><p>Provider · ${esc(storage.provider)}</p><p>${esc(storage.status)}</p><form data-settings-form>${fields}${source(storage.source)}<p>${esc(storage.migration)}</p>${storage.restartRequired ? '<p>Publication options take effect when Factory starts. Restart Factory after saving.</p>' : ''}</form>${storage.provider === 'github' ? `<h3>Connection references</h3>${references(data.git)}` : ''}<button class="small-button" type="button" data-settings-action="test-storage">Test connection</button><p data-connection-result role="status"></p>`;
    }
    function renderSkills() {
      return `<h3>Installed skills</h3><ul>${data.skills.map((skill) => `<li>${esc(skill.name)}${source(skill.path || skill.source || 'Installed project skill catalogue')}</li>`).join('')}</ul><h3>Required skill libraries</h3>${data.setup.sets.map((set) => `<p>${esc(set.name)} · ${set.missing.length ? 'Missing ' + esc(set.missing.join(', ')) : 'Available'}${source(set.source || 'user/skills/requirements.json')}</p>`).join('') || '<p>No required libraries configured.</p>'}`;
    }
    function renderPrompts() {
      return `<form data-settings-form>${Object.entries(promptNames)
        .map(
          ([key, label]) =>
            `<label class="field">${label}<textarea name="${key}" rows="7">${esc(data.prompts[key].value)}</textarea></label>${source(data.prompts[key].source)}<button class="small-button" type="button" data-restore-prompt="${key}">Restore default</button>`
        )
        .join('')}${saveButton}</form>`;
    }
    function renderHotkeys() {
      return `<p>Use combinations such as Alt+D or Ctrl+Shift+N. Leave a binding empty to disable it. Duplicate Factory hotkeys cannot be saved.</p><p>Hold Dictate HOT to record, then release to stop. Press Dictate COLD to start recording and press it again to stop.</p><form data-settings-form>${Object.entries(
        hotkeyNames
      )
        .map(
          ([key, label]) =>
            `<label class="field">${label}<input name="${key}" autocomplete="off" value="${esc(data.hotkeys.values[key])}" /></label>`
        )
        .join(
          ''
        )}<button class="small-button" type="button" data-restore-hotkeys>Restore defaults</button>${saveButton}</form>`;
    }
    function renderApp() {
      const settings = data.settings;
      const field = (key, label) =>
        `<label class="field">${label}<input name="${key}" value="${esc(settings[key])}" maxlength="4000" /></label>`;
      return `<form data-settings-form>
        ${field('command', 'Start command')}
        ${field('url', 'App URL')}
        ${field('directory', 'Working directory')}
        <details><summary>Recognize a running app</summary>
          ${field('expected', 'Expected response text')}
          ${field('checkUrl', 'Check URL')}
        </details>
        <button class="small-button" data-detect-app type="button">🪄 Detect setup</button>
        <p data-app-detection role="status"></p>${saveButton}
      </form>`;
    }
    async function detectApp(button) {
      button.disabled = true;
      const output = content.querySelector('[data-app-detection]');
      output.textContent = 'Detecting setup…';
      try {
        const result = await post('/api/project-app', { action: 'detect' });
        if (output.isConnected) showDetection(result, output);
      } catch (failure) {
        output.textContent = failure.message;
      } finally {
        button.disabled = false;
      }
    }
    function showDetection(result, output) {
      for (const [key, value] of Object.entries(result.settings)) form().elements[key].value = value;
      output.textContent = [result.sources, result.undetermined && 'Undetermined: ' + result.undetermined]
        .filter(Boolean)
        .join(' · ');
    }
    content.addEventListener('click', (event) => {
      const button = event.target.closest('[data-detect-app]');
      if (button) void detectApp(button);
    });
    const renderers = {
      providers: () => window.factoryProviderSettings.render(data, esc, saveButton),
      issues: renderIssues,
      app: renderApp,
      lifecycle: renderLifecycle,
      git: renderGit,
      storage: renderStorage,
      'asset-storage': () => '',
      skills: renderSkills,
      prompts: renderPrompts,
      hotkeys: renderHotkeys,
    };
    function render() {
      navigation();
      document.getElementById('settings-page-title').textContent = pages.find(([id]) => id === page)[1];
      content.innerHTML = renderers[page]();
      if (page === 'asset-storage') window.renderProjectAssetStorage(content, data, esc);
      window.factoryAgentOptions(content);
      baseline = snapshot();
      for (const button of content.querySelectorAll('[data-store-usage-refresh]')) void refreshDiskUsage(button);
    }
    async function readAssetInventory(ticket, status) {
      const endpoint = '/api/project-asset-storage?status';
      let path = endpoint + '&refresh=true';
      while (ticket === sequence) {
        const result = await request(path);
        const inventory = finishedAssetInventory(result);
        if (inventory) return inventory;
        showAssetScanProgress(status, result);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        path = endpoint;
      }
    }
    function finishedAssetInventory(result) {
      if (result.phase === 'failed') throw Error('Factory could not read the asset inventory.');
      return result.inventory ?? (Array.isArray(result.assets) ? result : null);
    }
    function showAssetScanProgress(status, result) {
      if (result.phase === 'references') {
        status.textContent = `Checking retained references for ${result.count} listed assets…`;
      }
    }
    async function loadAssetStorage(ticket) {
      document.getElementById('settings-page-title').textContent = 'Asset Storage';
      content.innerHTML = '<p role="status">Listing assets in S3…</p>';
      try {
        const inventory = await readAssetInventory(ticket, content.firstElementChild);
        if (ticket !== sequence) return;
        data = inventory;
        render();
      } catch (failure) {
        if (ticket !== sequence) return;
        showError(failure.message);
        content.innerHTML =
          '<button type="button" class="small-button" data-asset-storage-retry>Retry inventory</button>';
      }
    }
    async function readSettings(value, path, ticket) {
      const result = await request(path);
      if (value === 'storage' && ticket === sequence) {
        result.storeRegistry = await request('/api/issue-stores');
        if (ticket === sequence) savedStoreConfiguration = JSON.stringify(storeConfiguration(result.storeRegistry));
      }
      return result;
    }
    async function load(
      value,
      { preserveScroll = false, scrollTop = view.querySelector('.settings-body').scrollTop } = {}
    ) {
      const ticket = ++sequence;
      page = value;
      resetPrompts.clear();
      showError();
      if (!preserveScroll) content.textContent = 'Loading settings…';
      baseline = snapshot();
      navigation();
      if (value === 'asset-storage') return loadAssetStorage(ticket);
      const endpoints = {
        providers: '/api/ai-providers',
        app: '/api/project-app',
        issues: '/api/folder-settings?project=true',
        prompts: '/api/project-preferences',
        hotkeys: '/api/project-preferences',
        skills: '/api/project-discuss-skills?all=true',
      };
      try {
        const result = await readSettings(value, endpoints[value] || '/api/project-settings', ticket);
        if (ticket !== sequence) return;
        data = result;
        render();
        view.querySelector('.settings-body').scrollTop = preserveScroll ? scrollTop : 0;
      } catch (failure) {
        showCurrentError(ticket, failure);
      }
    }
    function showCurrentError(ticket, failure) {
      if (ticket === sequence) showError(failure.message);
    }
    function notifySaved() {
      changed?.();
      window.dispatchEvent(new Event('factory-provider-settings-saved'));
      content
        .querySelector('[data-settings-status]')
        ?.replaceChildren(page === 'storage' ? 'Saved. Restart Factory to apply publication options.' : 'Saved');
    }
    function renderSavedSettings() {
      resetPrompts.clear();
      const body = view.querySelector('.settings-body');
      const scrollTop = body.scrollTop;
      render();
      body.scrollTop = scrollTop;
      if (page === 'hotkeys') window.FactoryHotkeys.apply(data.hotkeys.values);
      notifySaved();
    }
    function save() {
      if (busy || !form()) return false;
      if (!dirty()) {
        notifySaved();
        return true;
      }
      return persistDraft();
    }
    async function persistDraft() {
      busy = true;
      view.inert = true;
      showError();
      content.querySelector('[data-settings-status]').textContent = 'Saving…';
      try {
        const fields = values();
        const saves = {
          providers: () => post('/api/ai-providers', window.factoryProviderSettings.input(data, fields)),
          app: () => post('/api/project-app', { action: 'save', revision: data.revision, settings: fields }),
          issues: () =>
            post('/api/folder-settings', { project: true, action: 'save', revision: data.revision, changes: fields }),
          prompts: () =>
            post('/api/project-preferences', {
              revision: data.revision,
              prompts: Object.fromEntries(
                Object.entries(fields)
                  .filter(([key, value]) => resetPrompts.has(key) || value !== data.prompts[key].value)
                  .map(([key, value]) => [key, resetPrompts.has(key) ? null : value])
              ),
            }),
          hotkeys: () => post('/api/project-preferences', { revision: data.revision, hotkeys: fields }),
          storage: () => saveStoreSettings(fields),
        };
        data = await saves[page]();
        renderSavedSettings();
        return true;
      } catch (failure) {
        content.querySelector('[data-settings-status]').textContent = 'Not saved';
        showError(failure.message);
        return false;
      } finally {
        busy = false;
        view.inert = false;
      }
    }
    function leave(operation) {
      if (busy) return;
      if (!dirty()) {
        operation();
        return;
      }
      pending = operation;
      if (!unsaved.open) unsaved.showModal();
    }
    function closeView() {
      sequence++;
      view.hidden = true;
      workspace.hidden = false;
      header.inert = false;
      updateUrl(null);
      returnFocus?.focus();
    }
    function close() {
      leave(closeView);
    }
    function select(value) {
      leave(() => {
        updateUrl(value);
        void load(value);
      });
    }
    function open(value = 'issues') {
      const selected = Object.hasOwn(renderers, value) ? value : 'issues';
      if (!view.hidden) return select(selected);
      returnFocus = document.activeElement;
      view.hidden = false;
      workspace.hidden = true;
      header.inert = true;
      view.querySelector('[data-settings-close]').focus();
      updateUrl(selected);
      void load(selected);
    }
    content.addEventListener('submit', (event) => {
      if (!event.target.matches('[data-settings-form]')) return;
      event.preventDefault();
      void save();
    });
    content.addEventListener('change', (event) => {
      if (event.target.matches('[data-provider-enabled]')) void toggleProvider(event.target);
    });
    async function toggleProvider(checkbox) {
      const provider = data.providers.find(({ id }) => id === checkbox.dataset.providerEnabled);
      const configuration = view.querySelector(`[data-provider-configuration="${provider.id}"]`);
      const active = checkbox.checked;
      configuration.hidden = !active;
      view.inert = true;
      busy = true;
      showError();
      try {
        const result = await post('/api/ai-provider-enabled', {
          provider: provider.id,
          active,
          revision: data.revision,
        });
        data.revision = result.revision;
        provider.active = active;
        if (!active && pendingProviderSetup === provider.id) pendingProviderSetup = null;
        const saved = result.providers.find(({ id }) => id === provider.id);
        const reasons = new Map(saved.models.map((model) => [model.id, model.availability.reason]));
        for (const label of configuration.querySelectorAll('[data-model-availability]'))
          label.textContent = reasons.get(label.dataset.modelAvailability) ?? label.textContent;
        changed?.();
        window.dispatchEvent(new CustomEvent('factory-provider-settings-saved', { detail: result.providers }));
      } catch (failure) {
        checkbox.checked = provider.active;
        configuration.hidden = !provider.active;
        showError(failure.message);
      } finally {
        busy = false;
        view.inert = false;
        checkbox.focus();
      }
    }
    content.addEventListener('input', (event) => {
      resetPrompts.delete(event.target.name);
    });
    document.addEventListener('keydown', (event) => {
      if (view.hidden || event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.target !== document.body && !view.contains(event.target)) return;
      event.preventDefault();
      close();
    });
    function restorePrompt(button) {
      const key = button.dataset.restorePrompt;
      form().elements[key].value = data.prompts[key].default;
      resetPrompts.add(key);
    }
    function restoreHotkeys() {
      for (const [key, value] of Object.entries(data.hotkeys.defaults)) form().elements[key].value = value;
    }
    function openMaintenance(button) {
      leave(() => {
        closeView();
        document.getElementById('project-tab-admin').click();
        document.getElementById(button.dataset.settingsMaintenance).click();
      });
    }
    const clicks = [
      ['[data-provider-copy]', copyProviderCommand],
      ['[data-provider-action]', (button) => leave(() => void providerAction(button))],
      ['[data-settings-page]', (button) => select(button.dataset.settingsPage)],
      ['[data-settings-close]', close],
      ['[data-asset-storage-retry]', () => load('asset-storage')],
      ['[data-restore-prompt]', restorePrompt],
      ['[data-restore-hotkeys]', restoreHotkeys],
      ['[data-settings-action]', runAction],
      ['[data-settings-maintenance]', openMaintenance],
      ['[data-settings-initialize]', initialize],
      ['[data-settings-create]', createDefaults],
      ['[data-store-add]', addStore],
      ['[data-profile-add]', addProfile],
      ['[data-store-test], [data-store-test-role]', testStore],
      ['[data-store-usage-refresh]', refreshDiskUsage],
      ['[data-store-discover]', discoverStorageMoves],
      ['[data-store-resume-move]', (button) => leave(() => void resumeStorageMove(button))],
      ['[data-store-resume-delete], [data-store-pause-delete]', (button) => leave(() => void controlDeletion(button))],
      ['[data-store-reconcile-flow]', (button) => leave(() => void reconcileFlowSave(button))],
      [
        '[data-settings-admin]',
        (button) =>
          leave(() => {
            location.href = button.href;
          }),
      ],
    ];
    view.addEventListener('click', (event) => {
      for (const [selector, action] of clicks) {
        const button = event.target.closest(selector);
        if (!button) continue;
        event.preventDefault();
        void action(button);
        break;
      }
    });
    async function copyProviderCommand(button) {
      const setup = data.providers.find((provider) => provider.id === button.dataset.providerCopy)?.setup;
      const command = { install: setup?.command, check: setup?.checkCommand, signin: setup?.loginCommand }[
        button.dataset.commandKind
      ];
      if (!command) return;
      try {
        await navigator.clipboard.writeText(command);
        button.textContent = 'Copied';
      } catch {
        showError('Copy the displayed command manually; clipboard access is unavailable.');
      }
    }
    async function providerAction(button) {
      if (busy) return;
      const body = view.querySelector('.settings-body'),
        scrollTop = body.scrollTop;
      busy = true;
      view.inert = true;
      showError();
      const id = button.dataset.providerId,
        action = button.dataset.providerAction;
      const output = content.querySelector(`[data-provider-result="${id}"]`);
      if (output)
        output.textContent = {
          install: 'Opening installation in Terminal…',
          setup: 'Checking setup…',
          refresh: 'Checking native sign-in, models, and quota…',
        }[action];
      try {
        const result = await post('/api/ai-provider-action', { provider: id, action });
        await load('providers', { preserveScroll: true, scrollTop });
        providerActionResult(id, action, result);
        body.scrollTop = scrollTop;
      } catch (failure) {
        showError(failure.message);
      } finally {
        busy = false;
        view.inert = false;
      }
    }
    function providerActionResult(id, action, result) {
      if (action === 'refresh') {
        changed?.();
        window.dispatchEvent(new Event('factory-provider-settings-saved'));
        return;
      }
      pendingProviderSetup = result.ready || !['signin', 'installing'].includes(result.setup?.step) ? null : id;
      if (data.providers.find((provider) => provider.id === id)?.message === result.message) return;
      const status = content.querySelector(`[data-provider-result="${id}"]`);
      if (status) status.textContent = result.message;
    }
    window.addEventListener('focus', () => {
      if (!pendingProviderSetup || view.hidden || page !== 'providers' || busy || dirty()) return;
      const id = pendingProviderSetup;
      pendingProviderSetup = null;
      void providerAction({ dataset: { providerId: id, providerAction: 'refresh' } });
    });
    async function runAction(button) {
      button.disabled = true;
      showError();
      try {
        const result = await post('/api/project-settings', { action: button.dataset.settingsAction });
        const output = content.querySelector('[data-connection-result]');
        if (output)
          output.textContent = result.message + (result.permissions ? ' ' + JSON.stringify(result.permissions) : '');
      } catch (failure) {
        showError(failure.message);
      } finally {
        button.disabled = false;
      }
    }
    async function initialize() {
      try {
        await post('/api/project-settings-initialize', { digest: data.lifecycle.digest });
        await load(page);
      } catch (failure) {
        showError(failure.message);
      }
    }
    async function createDefaults() {
      try {
        await post('/api/folder-settings', { project: true, action: 'create' });
        await load(page);
      } catch (failure) {
        showError(failure.message);
      }
    }
    function finishLeaving() {
      const operation = pending;
      pending = null;
      unsaved.close();
      operation();
    }
    async function saveAndLeave() {
      unsaved.close();
      if (await save()) finishLeaving();
      else pending = null;
    }
    const unsavedChoices = {
      cancel: () => {
        unsaved.close();
        pending = null;
      },
      discard: finishLeaving,
      save: saveAndLeave,
    };
    unsaved.addEventListener('click', (event) => {
      const button = event.target.closest('[data-unsaved-choice]');
      if (!button || busy) return;
      void unsavedChoices[button.dataset.unsavedChoice]();
    });
    unsaved.addEventListener('cancel', () => {
      pending = null;
    });
    window.addEventListener('beforeunload', (event) => {
      if (!view.hidden && dirty()) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    window.addEventListener('popstate', () => {
      const requested = new URL(location.href).searchParams.get('settings');
      if (view.hidden) {
        if (requested) open(requested);
        return;
      }
      updateUrl(page);
      if (requested) select(requested);
      else close();
    });
    const requested = new URL(location.href).searchParams.get('settings');
    if (requested) open(requested);
    return { open };
  };
})();
