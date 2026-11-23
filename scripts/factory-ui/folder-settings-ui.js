(() => {
  'use strict';

  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
    );
  const choiceValue = (choice) => (typeof choice === 'string' ? choice : (choice.id ?? choice.value));
  const choiceLabel = (choice) =>
    typeof choice === 'string' ? choice : (choice.name ?? choice.label ?? choiceValue(choice));

  function settingSelect(field, raw, id, disabled, unavailable) {
    const choices = field.choices || [];
    const options = choices
      .filter((choice) => choiceValue(choice) !== 'default')
      .map(
        (choice) =>
          `<option value="${escape(choiceValue(choice))}"${raw === choiceValue(choice) ? ' selected' : ''}>${escape(choiceLabel(choice))}</option>`
      );
    if (raw !== 'default' && !choices.some((choice) => choiceValue(choice) === raw))
      options.push(
        `<option value="${escape(raw)}" selected>${escape(raw)}${unavailable ? ' · unavailable' : ''}</option>`
      );
    return `<select id="${escape(id)}" name="${escape(field.key)}"${disabled ? ' disabled' : ''}><option value="default">Default</option>${options.join('')}</select>`;
  }
  function settingInput(field, setting = {}, prefix, disabled = false) {
    const raw = setting?.raw == null || setting.raw === '' ? 'default' : setting.raw;
    const id = `${prefix}-${field.key}`;
    const selectedAvailability = field.availability?.[setting.value];
    const unavailable =
      selectedAvailability && !['available', 'warning', 'unmonitored'].includes(selectedAvailability.status);
    const input =
      field.choices?.length || field.key === 'model'
        ? settingSelect(field, raw, id, disabled, unavailable)
        : `<input id="${escape(id)}" name="${escape(field.key)}" value="${escape(raw)}" placeholder="default" autocomplete="off"${disabled ? ' disabled' : ''} />`;
    const effective = setting?.value == null ? '' : `${setting.value}${setting.source ? ` · ${setting.source}` : ''}`;
    return `<label class="folder-setting-field" for="${escape(id)}" data-setting-value="${escape(setting.value)}"><span>${escape(field.label || field.key)}</span>${input}<small class="muted">${escape(effective)}${unavailable ? ' · ' + escape(selectedAvailability.reason) : ''}</small></label>`;
  }

  function settingsWand(view) {
    const errors = view.errors || [];
    const missing = view.missing || [];
    let tooltip = 'Your folder.md is up-to-date';
    if (missing.length) tooltip = 'Add missing fields: ' + missing.join(', ');
    if (errors.length) tooltip = errors.map((entry) => entry.message || entry).join('\n');
    const label = errors.length ? 'Repair folder settings' : 'Add missing settings fields';
    return `<button class="icon-button folder-settings-wand${errors.length ? ' invalid' : ''}" type="button" data-settings-repair aria-label="${label}" title="${escape(tooltip)}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m4 20 12-12 4 4L8 24M14 10l4 4M5 2v6M2 5h6M19 1v6M16 4h6M21 16v6M18 19h6" /></svg></button>`;
  }

  function configuredFolderSettings(view, project, prefix, omitFields) {
    const heading = project
      ? '<h2>Project defaults</h2>'
      : `<label class="folder-check"><input type="checkbox" data-default-folder${view.isDefaultFolder ? ' checked' : ''} /> Is default folder</label>`;
    const errors = (view.errors || []).map((entry) => `<li>${escape(entry.message || entry)}</li>`).join('');
    const fields = (view.fields || [])
      .filter(({ key }) => !omitFields.includes(key))
      .map((field) => settingInput(field, view.settings?.[field.key], prefix))
      .join('');
    return `<form data-settings-form><div class="folder-settings-heading">${heading}${settingsWand(view)}</div>${errors ? `<ul class="folder-settings-errors">${errors}</ul>` : ''}<div class="folder-settings-fields">${fields}</div><div class="folder-controls"><button class="small-button" type="submit">Save settings</button><span class="muted" data-settings-saved role="status"></span></div></form>`;
  }

  function plainFolderSettings(view) {
    return `<p class="muted">System folder</p>${view.canConfigure ? '<button class="small-button" type="button" data-settings-create>Create folder.md</button>' : ''}`;
  }

  window.factorySettingField = settingInput;
  window.factoryAgentOptions = (container) => {
    const model = container.querySelector('[name="model"]');
    const effort = container.querySelector('[name="effort"]');
    if (!model || !effort) return;
    const value = model.value === 'default' ? model.closest('label').dataset.settingValue : model.value;
    effort.closest('label').hidden = /^(anthropic|google):/.test(value);
  };
  document.addEventListener('change', (event) => {
    if (event.target.matches('[name="model"]')) window.factoryAgentOptions(event.target.closest('form'));
  });

  window.createFolderSettingsUI = ({
    container,
    request,
    changed,
    notify,
    prefix = 'folder-setting',
    omitFields = [],
  }) => {
    let location;
    let current;
    let sequence = 0;
    let busy = false;
    const error = (message) => {
      const panel = container.querySelector('[data-settings-error]');
      panel.textContent = message || '';
      panel.hidden = !message;
    };
    const perform = async (operation) => {
      if (busy) return;
      busy = true;
      container.inert = true;
      error('');
      try {
        await operation();
      } catch (failure) {
        error(failure.message);
      } finally {
        busy = false;
        container.inert = false;
        const checkbox = container.querySelector('[data-default-folder]');
        if (checkbox) checkbox.checked = Boolean(current?.isDefaultFolder);
      }
    };
    const post = (action, data = {}) =>
      request('/api/folder-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Factory-Action': 'manual' },
        body: JSON.stringify({ ...location, action, revision: current?.revision, ...data }),
      });
    function render() {
      container.innerHTML =
        '<p class="inline-error" data-settings-error role="alert" hidden></p>' +
        (current.kind === 'plain'
          ? plainFolderSettings(current)
          : configuredFolderSettings(current, location.project, prefix, omitFields));
      window.factoryAgentOptions(container);
    }
    async function refresh() {
      if (!location) return;
      const ticket = ++sequence;
      const data = await request('/api/folder-settings?' + new URLSearchParams(location));
      if (ticket !== sequence) return;
      current = data;
      render();
      changed?.(data);
      return data;
    }
    async function repair() {
      if (current.repairable === false) {
        await post('open', { file: true });
        return;
      }
      const preview = await post('repair-preview');
      const changes = Object.entries(preview.changes || {});
      if (!changes.length) {
        if (preview.errors?.length) error(preview.errors.map((entry) => entry.message || entry).join('\n'));
        else notify?.('Your folder.md is up-to-date');
        return;
      }
      const description = changes.map(([key, value]) => `${key}: ${value}`).join('\n');
      const messages = (preview.errors || []).map((entry) => entry.message || entry).join('\n');
      if (
        !confirm(
          `Review folder.md changes:\n\n${description}${messages ? `\n\n${messages}` : ''}\n\nApply these changes? Existing fields are retained.`
        )
      )
        return;
      await post('repair', { revision: preview.revision, changes: preview.changes });
      await refresh();
      notify?.('Folder settings repaired.');
    }
    container.addEventListener('submit', (event) => {
      if (!event.target.matches('[data-settings-form]')) return;
      event.preventDefault();
      const changes = Object.fromEntries(new FormData(event.target));
      void perform(async () => {
        await post('save', { changes });
        await refresh();
        notify?.('Folder settings saved.');
      });
    });
    container.addEventListener('change', (event) => {
      if (!event.target.matches('[data-default-folder]')) return;
      const makeDefault = event.target.checked;
      void perform(async () => {
        await post('make-default', { makeDefault });
        await refresh();
        notify?.('Default issue folder saved.');
      });
    });
    container.addEventListener('click', (event) => {
      if (event.target.closest('[data-settings-repair]')) void perform(repair);
      if (event.target.closest('[data-settings-create]'))
        void perform(async () => {
          await post('create');
          await refresh();
          window.dispatchEvent(new CustomEvent('factory-issue-folder-created', { detail: current.folder?.name }));
        });
    });
    return {
      setLocation(next) {
        const key = JSON.stringify(next);
        if (key === JSON.stringify(location)) return;
        location = next;
        current = null;
        sequence++;
        container.textContent = 'Loading settings…';
        void refresh().catch((failure) => {
          container.textContent = failure.message;
        });
      },
      refresh,
      value: () => current,
    };
  };
})();
