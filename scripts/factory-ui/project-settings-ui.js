(() => {
  'use strict';
  const pages = [
    ['issues', 'Issues'],
    ['lifecycle', 'Issue Lifecycle'],
    ['git', 'Git'],
    ['storage', 'Issue Storage'],
    ['skills', 'Skills', 'AI Skills'],
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
    const dialog = document.getElementById('project-settings-dialog');
    const content = document.getElementById('project-settings-content');
    const error = document.getElementById('project-settings-error');
    const unsaved = document.getElementById('settings-unsaved-dialog');
    let page = null;
    let data = null;
    let baseline = '';
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
    const form = () => content.querySelector('[data-settings-form]');
    const values = () => (form() ? Object.fromEntries(new FormData(form())) : {});
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
        .filter(({ key }) => ['branch', 'skill', 'model', 'effort', 'selection_strategy'].includes(key))
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
    function renderStorage() {
      const storage = data.storage;
      const fields = Object.entries(storage.configuration)
        .map(([key, value]) =>
          storage.editableFields.includes(key)
            ? `<label class="field">${esc(key)}<select name="${esc(key)}"><option value="true"${value ? ' selected' : ''}>Enabled</option><option value="false"${!value ? ' selected' : ''}>Disabled</option></select></label>`
            : `<p>${esc(key)} · ${esc(value)}</p>`
        )
        .join('');
      return `<p>Current provider · ${esc(storage.provider)}</p><p>Existing providers · ${storage.providers.map(esc).join(', ')}</p><p>${esc(storage.status)}</p><form data-settings-form>${fields}${source(storage.source)}<p>${esc(storage.migration)}</p>${storage.restartRequired ? '<p>Publication options take effect when Factory starts. Restart Factory after saving.</p>' : ''}${storage.editableFields.length ? saveButton : ''}</form>${storage.provider === 'github' ? `<h3>Connection references</h3>${references(data.git)}` : ''}<button class="small-button" type="button" data-settings-action="test-storage">Test connection</button><p data-connection-result role="status"></p>`;
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
      return `<p>Use combinations such as Alt+D or Ctrl+Shift+N. Leave a binding empty to disable it. Duplicate Factory hotkeys cannot be saved.</p><p id="cold-hotkey-help">Dictate COLD is unbound. Its behavior needs to be defined before assigning a shortcut.</p><form data-settings-form>${Object.entries(
        hotkeyNames
      )
        .map(
          ([key, label]) =>
            `<label class="field">${label}<input name="${key}" autocomplete="off" value="${esc(data.hotkeys.values[key])}"${key === 'dictateCold' ? ' readonly aria-describedby="cold-hotkey-help"' : ''} /></label>`
        )
        .join(
          ''
        )}<button class="small-button" type="button" data-restore-hotkeys>Restore defaults</button>${saveButton}</form>`;
    }
    const renderers = {
      issues: renderIssues,
      lifecycle: renderLifecycle,
      git: renderGit,
      storage: renderStorage,
      skills: renderSkills,
      prompts: renderPrompts,
      hotkeys: renderHotkeys,
    };
    function render() {
      navigation();
      document.getElementById('settings-page-title').textContent = pages.find(([id]) => id === page)[1];
      content.innerHTML = renderers[page]();
      baseline = snapshot();
    }
    async function load(value) {
      const ticket = ++sequence;
      page = value;
      resetPrompts.clear();
      showError();
      content.textContent = 'Loading settings…';
      baseline = snapshot();
      navigation();
      const endpoints = {
        issues: '/api/folder-settings?project=true',
        prompts: '/api/project-preferences',
        hotkeys: '/api/project-preferences',
        skills: '/api/project-discuss-skills?all=true',
      };
      try {
        const result = await request(endpoints[value] || '/api/project-settings');
        if (ticket !== sequence) return;
        data = result;
        render();
      } catch (failure) {
        showCurrentError(ticket, failure);
      }
    }
    function showCurrentError(ticket, failure) {
      if (ticket === sequence) showError(failure.message);
    }
    function notifySaved() {
      changed?.();
      content
        .querySelector('[data-settings-status]')
        ?.append(page === 'storage' ? 'Saved. Restart Factory to apply publication options.' : 'Saved');
    }
    async function save() {
      if (busy || !form()) return false;
      busy = true;
      dialog.inert = true;
      showError();
      try {
        const fields = values();
        const saves = {
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
          storage: () =>
            post('/api/project-settings', {
              action: 'save-storage',
              revision: data.storage.revision,
              changes: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value === 'true'])),
            }),
        };
        await saves[page]();
        resetPrompts.clear();
        await load(page);
        await window.FactoryHotkeys.refresh();
        notifySaved();
        return true;
      } catch (failure) {
        showError(failure.message);
        return false;
      } finally {
        busy = false;
        dialog.inert = false;
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
    function close() {
      leave(() => {
        sequence++;
        dialog.close();
        updateUrl(null);
      });
    }
    function select(value) {
      leave(() => {
        updateUrl(value);
        void load(value);
      });
    }
    function open(value = 'issues') {
      const selected = Object.hasOwn(renderers, value) ? value : 'issues';
      if (dialog.open) return select(selected);
      dialog.showModal();
      updateUrl(selected);
      void load(selected);
    }
    content.addEventListener('submit', (event) => {
      if (!event.target.matches('[data-settings-form]')) return;
      event.preventDefault();
      void save();
    });
    content.addEventListener('input', (event) => {
      resetPrompts.delete(event.target.name);
    });
    dialog.addEventListener('cancel', (event) => {
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
        dialog.close();
        updateUrl(null);
        document.querySelector('[data-project-home=home]').click();
        document.querySelector('[data-project-tab=admin]').click();
        document.getElementById(button.dataset.settingsMaintenance).click();
      });
    }
    const clicks = [
      ['[data-settings-page]', (button) => select(button.dataset.settingsPage)],
      ['[data-settings-close]', close],
      ['[data-restore-prompt]', restorePrompt],
      ['[data-restore-hotkeys]', restoreHotkeys],
      ['[data-settings-action]', runAction],
      ['[data-settings-maintenance]', openMaintenance],
      ['[data-settings-initialize]', initialize],
      ['[data-settings-create]', createDefaults],
      [
        '[data-settings-admin]',
        (button) =>
          leave(() => {
            location.href = button.href;
          }),
      ],
    ];
    dialog.addEventListener('click', (event) => {
      for (const [selector, action] of clicks) {
        const button = event.target.closest(selector);
        if (!button) continue;
        event.preventDefault();
        void action(button);
        break;
      }
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
      if (dialog.open && dirty()) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    window.addEventListener('popstate', () => {
      const requested = new URL(location.href).searchParams.get('settings');
      if (!dialog.open) {
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
