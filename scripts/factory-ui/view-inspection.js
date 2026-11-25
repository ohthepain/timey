(() => {
  const $ = (id) => document.getElementById(id);
  const toggle = $('view-inspect');
  const app = $('app');
  const tooltip = $('view-source-tooltip');
  const menu = $('view-source-menu');
  const dialog = $('view-source-dialog');
  const form = $('view-source-form');
  const field = $('view-source-label');
  const save = $('view-source-save');
  const sources = new Map();
  const targets = [...app.querySelectorAll('[data-ui-source]')];
  let enabled = false;
  let picked;
  let draft;
  let loading = false;
  let refreshPending = false;
  let saving = false;
  let editable = false;
  let described;
  let holding;
  let previousDescription;
  let sourceRequest = 0;

  async function request(options) {
    const response = await fetch('/api/ui-sources', options);
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Unable to read UI sources.');
    return result;
  }

  function apply(result) {
    sources.clear();
    for (const entry of result.entries) sources.set(entry.id, entry);
    for (const target of targets) {
      const entry = sources.get(target.dataset.uiSource);
      const label = target.querySelector('[data-ui-label]');
      if (entry && label.textContent !== entry.label) label.textContent = entry.label;
    }
    const status = $('view-source-status');
    status.hidden = result.errors.length === 0;
    const diagnostic = result.errors.join('\n');
    if (status.textContent !== diagnostic) status.textContent = diagnostic;
    if (described) tooltip.textContent = explain(sourceFor(described), described);
    document.dispatchEvent(new CustomEvent('factory-ui-sources', { detail: result.entries }));
  }

  async function refresh() {
    if (document.hidden) return;
    if (loading || saving) {
      refreshPending = true;
      return;
    }
    refreshPending = false;
    loading = true;
    const revision = ++sourceRequest;
    try {
      const result = await request();
      if (revision === sourceRequest) {
        editable = result.editable;
        apply(result);
      }
    } catch (error) {
      if (revision !== sourceRequest) return;
      const status = $('view-source-status');
      status.textContent = error.message;
      status.hidden = false;
    } finally {
      loading = false;
      if (refreshPending) void refresh();
    }
  }

  function sourceFor(target) {
    return sources.get(target?.closest('[data-ui-source]')?.dataset.uiSource);
  }

  function explain(entry, target) {
    if (!entry) return 'Runtime-managed element. There is no Markdown override for this element.';
    const span = ({ path, line }) => path + ':' + line;
    const override = entry.override ? 'Override ' + span(entry.override) : 'Inherited · ' + entry.overridePath;
    const origin = entry.document
      ? 'Card title and status come from the saved block.'
      : target?.closest('[data-ui-value]')?.dataset.uiValue;
    return [
      entry.bundled ? 'Bundled ' + span(entry.bundled) : 'Project block',
      override,
      entry.extension
        ? 'User extension ' + entry.extension
        : entry.extensionPath && 'Optional user extension ' + entry.extensionPath,
      'Section ' + entry.section,
      origin,
    ]
      .filter(Boolean)
      .join('\n');
  }

  function targetAt(target) {
    const element = target.closest(
      '[data-ui-source], [data-ui-value], button, a, input, select, textarea, label, summary, [role], h1, h2, h3, p'
    );
    return element?.closest('.flow-heading-actions') ? null : element;
  }

  function position(popover, target, x, y) {
    const rect = target.getBoundingClientRect();
    popover.hidden = false;
    const left = x ?? rect.left;
    const top = y ?? rect.bottom;
    popover.style.left = Math.max(8, Math.min(left, innerWidth - popover.offsetWidth - 8)) + 'px';
    popover.style.top = Math.max(8, Math.min(top + 5, innerHeight - popover.offsetHeight - 8)) + 'px';
  }

  function hideTooltip() {
    if (described) {
      if (previousDescription === null) described.removeAttribute('aria-describedby');
      else described.setAttribute('aria-describedby', previousDescription);
    }
    described = undefined;
    tooltip.hidden = true;
  }

  function describe(target) {
    if (described === target && !tooltip.hidden) return;
    hideTooltip();
    if (!enabled || !target || target === toggle || !menu.hidden) return;
    described = target;
    previousDescription = target.getAttribute('aria-describedby');
    target.setAttribute('aria-describedby', [previousDescription, tooltip.id].filter(Boolean).join(' '));
    tooltip.textContent = explain(sourceFor(target), target);
    position(tooltip, target);
  }

  function closeMenu(restore = false) {
    menu.hidden = true;
    if (restore && picked?.isConnected) picked.focus();
  }

  function openMenu(target, x, y) {
    hideTooltip();
    picked = target;
    const entry = sourceFor(target);
    $('view-source-copy').hidden = !entry;
    $('view-source-edit').hidden = !entry || !editable || Boolean(entry.document);
    $('view-source-edit').textContent = entry?.override ? 'Edit override' : 'Create override';
    position(menu, target, x, y);
    $('view-source-open').focus();
  }

  function showSource(entry, edit) {
    draft = edit ? entry : null;
    $('view-source-title').textContent = edit ? 'Edit project override' : 'UI source';
    $('view-source-location').textContent = explain(entry, picked);
    $('view-source-error').hidden = true;
    $('view-source-field').hidden = !edit;
    field.disabled = !edit;
    field.value = entry?.label ?? '';
    save.hidden = !edit;
    closeMenu();
    dialog.showModal();
    if (edit) field.focus();
  }

  function onPick(event) {
    const target = targetAt(event.target);
    if (!enabled || !target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openMenu(target, event.clientX || undefined, event.clientY || undefined);
  }

  toggle.addEventListener('click', () => {
    enabled = !enabled;
    toggle.setAttribute('aria-pressed', String(enabled));
    closeMenu();
    hideTooltip();
  });
  app.addEventListener('pointerover', (event) => describe(targetAt(event.target)));
  app.addEventListener('pointerout', (event) => {
    if (described && !described.contains(event.relatedTarget)) hideTooltip();
  });
  app.addEventListener('focusin', (event) => describe(targetAt(event.target)));
  app.addEventListener('focusout', hideTooltip);
  app.addEventListener('contextmenu', onPick, true);
  app.addEventListener('click', onPick, true);
  app.addEventListener('pointerdown', (event) => {
    const target = targetAt(event.target);
    if (!enabled || event.pointerType !== 'touch' || !target) return;
    holding = setTimeout(() => openMenu(target), 550);
  });
  for (const name of ['pointerup', 'pointercancel', 'pointermove']) {
    app.addEventListener(name, () => clearTimeout(holding));
  }
  document.addEventListener(
    'keydown',
    (event) => {
      if (!enabled || document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') {
        closeMenu(true);
        hideTooltip();
      }
      const target = app.contains(event.target) && targetAt(event.target);
      if (target && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
        event.preventDefault();
        openMenu(target);
      }
      if (event.key.toLowerCase() === 'n' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.stopImmediatePropagation();
      }
    },
    true
  );
  document.addEventListener('pointerdown', (event) => {
    if (!menu.contains(event.target)) closeMenu();
  });

  $('view-source-open').addEventListener('click', () => showSource(sourceFor(picked), false));
  $('view-source-copy').addEventListener('click', async () => {
    const entry = sourceFor(picked);
    if (!entry) return;
    const { path, line } = entry.override ?? entry.bundled;
    try {
      await navigator.clipboard.writeText(path + ':' + line);
      closeMenu(true);
    } catch {
      showSource(entry, false);
    }
  });
  $('view-source-edit').addEventListener('click', () => {
    const entry = sourceFor(picked);
    if (entry && editable) showSource(entry, true);
  });
  dialog.addEventListener('close', () => {
    if (picked?.isConnected) picked.focus();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!draft || saving) return;
    save.disabled = true;
    saving = true;
    sourceRequest += 1;
    const errorBox = $('view-source-error');
    errorBox.hidden = true;
    try {
      const result = await request({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-factory-action': 'manual' },
        body: JSON.stringify({ id: draft.id, revision: draft.editRevision, label: field.value }),
      });
      apply(result);
      if (result.errors.length) throw Error('Override saved. Reload pending. ' + result.errors.join(' '));
      dialog.close();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      refreshPending = true;
    } finally {
      saving = false;
      if (refreshPending) void refresh();
      save.disabled = false;
    }
  });

  $('view-index-open').addEventListener('click', () => {
    const content = $('view-index-content');
    content.replaceChildren();
    const groups = Map.groupBy(sources.values(), (entry) => entry.screen);
    for (const [screen, entries] of groups) {
      const heading = document.createElement('h3');
      heading.textContent = screen;
      const list = document.createElement('ul');
      for (const entry of entries) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.className = 'small-button';
        button.textContent = entry.name + ' · ' + entry.label;
        button.addEventListener('click', () => {
          $('view-index').close();
          picked = targets.find((target) => target.dataset.uiSource === entry.id);
          showSource(entry, false);
        });
        item.append(button);
        list.append(item);
      }
      content.append(heading, list);
    }
    if (!groups.size) content.textContent = 'No Markdown views available.';
    $('view-index').showModal();
  });

  window.addEventListener('factory-sources-changed', () => void refresh());
  document.addEventListener('visibilitychange', () => void refresh());
  void refresh();
})();
