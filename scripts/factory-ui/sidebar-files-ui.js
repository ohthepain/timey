(() => {
  'use strict';

  const byId = (name) => document.getElementById('sidebar-file-' + name);
  const tree = byId('tree');
  const dialog = byId('dialog');
  const form = byId('form');
  const path = byId('path');
  const text = byId('text');
  const nodes = new Map();
  let current;

  async function request(resource, data) {
    const query = data && resource !== 'files-action' ? '?' + new URLSearchParams(data) : '';
    const response = await fetch(
      '/api/sidebar-' + resource + query,
      resource === 'files-action'
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Factory-Action': 'manual' },
            body: JSON.stringify(data),
          }
        : undefined
    );
    const result = await response.json();
    if (!response.ok || result.error) throw Error(result.error || 'The folder request failed.');
    return result;
  }

  const change = (data) => request('files-action', data);
  const id = ({ root, path }) => JSON.stringify([root, path]);
  const childPath = (parent, name) => (parent ? parent + '/' + name : name);
  const node = (tag, content = '', className = '') => {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = content;
    return element;
  };

  function action(label, handler, className = 'small-button') {
    const button = node('button', label, className);
    button.type = 'button';
    button.addEventListener('click', () => void handler());
    return button;
  }

  function status(message) {
    byId('status').hidden = !message;
    byId('status').textContent = message;
  }

  function error(message) {
    byId('error').hidden = !message;
    byId('error').textContent = message;
  }

  function show(operation) {
    current = operation;
    const { kind, name, value, file, base } = operation;
    byId('title').textContent = name;
    path.value = value || '';
    text.value = file?.text || '';
    text.readOnly = Boolean(file && !file.writable);
    byId('path-label').hidden = !['add', 'directory', 'create', 'copy'].includes(kind);
    byId('path-label').firstChild.textContent = kind === 'add' ? 'Folder path' : 'Name or relative path';
    byId('text-label').hidden = !file && kind !== 'create';
    byId('browse').hidden = kind !== 'add';
    byId('open').hidden = kind !== 'save';
    byId('install').hidden = kind !== 'save' || base?.root !== 'user' || !/^skills\/[\w-]+\/SKILL\.md$/.test(base.path);
    byId('copy').hidden = kind !== 'save' || !base?.root.startsWith('system-');
    byId('submit').hidden = Boolean(file && !file.writable);
    byId('submit').textContent =
      { add: 'Add Folder', directory: 'Create Folder', create: 'Create File', copy: 'Copy File' }[kind] || 'Save';
    error('');
    if (!dialog.open) dialog.showModal();
    if (!byId('path-label').hidden) path.focus();
    else text.focus();
  }

  async function openFile(base) {
    try {
      const file = await request('file', base);
      show({ kind: 'save', name: file.name, base, file });
      status('');
    } catch (failure) {
      status(failure.message);
    }
  }

  function renderFolder(root, base, name) {
    const details = node('details');
    details.classList.add('sidebar-file-directory');
    const summary = node('summary', name);
    const body = node('div');
    body.classList.add('sidebar-file-children');
    details.append(summary, body);
    const entry = { body, details, root, base };
    nodes.set(id(base), entry);
    details.addEventListener('toggle', () => {
      if (details.open) void loadDirectory(entry);
    });
    return details;
  }

  function directoryActions(entry, issueFolder) {
    const { root, base } = entry;
    const operations = node('div');
    operations.classList.add('sidebar-file-actions');
    if (!root.writable) {
      if (root.section === 'Added folders' && !base.path) {
        operations.append(
          action('Remove', async () => {
            try {
              await change({ action: 'remove', root: base.root });
              await refresh();
            } catch (failure) {
              status(failure.message);
            }
          })
        );
      }
      return operations;
    }
    operations.append(
      action('New Folder', () => show({ kind: 'directory', name: 'New folder', base })),
      action('New File', () => show({ kind: 'create', name: 'New Markdown file', base }))
    );
    if (issueFolder && !issueFolder.duplicate) operations.append(...issueFolderActions(issueFolder.name));
    else if (base.path) {
      operations.append(
        action(issueFolder?.duplicate ? 'Give copy a new ID' : 'Enable issue actions', async () => {
          try {
            await change({ action: issueFolder?.duplicate ? 'new-folder-id' : 'enable-issues', ...base });
            await loadDirectory(entry);
          } catch (failure) {
            status(failure.message);
          }
        })
      );
    }
    return operations;
  }

  function issueFolderActions(name) {
    const open = action('View assigned issues', () =>
      window.dispatchEvent(new CustomEvent('factory-open-issue-folder', { detail: name }))
    );
    open.dataset.folder = name;
    const capture = action('New issue', () => {
      document.getElementById('capture-dialog').dataset.folder = name;
      window.openFlowCapture();
    });
    capture.dataset.createFolderIssue = name;
    return [open, capture];
  }

  async function loadDirectory({ body, root, base, details }) {
    try {
      const { rows, issueFolder } = await request('directory', base);
      if (!details.isConnected || !details.open) return;
      const fragment = document.createDocumentFragment();
      const actions = directoryActions({ root, base, body, details }, issueFolder);
      if (actions.childElementCount) fragment.append(actions);
      for (const row of rows) {
        const target = { root: root.id, path: childPath(base.path, row.name) };
        const existing = nodes.get(id(target));
        fragment.append(
          row.directory
            ? existing?.details || renderFolder(root, target, row.name)
            : action(row.name, () => openFile(target), 'sidebar-file-link')
        );
      }
      if (!rows.length) fragment.append(node('p', 'No Markdown files.', 'sidebar-empty'));
      body.replaceChildren(fragment);
    } catch (failure) {
      if (details.isConnected) body.replaceChildren(node('p', failure.message, 'sidebar-empty'));
    }
  }

  async function refresh(openRoot) {
    const roots = await request('files');
    const fragment = document.createDocumentFragment();
    const sections = new Set();
    for (const root of roots) {
      if (root.section && !sections.has(root.section)) {
        sections.add(root.section);
        const label = node('p', root.section);
        label.classList.add('sidebar-file-section');
        fragment.append(label);
      }
      const base = { root: root.id, path: '' };
      const details = nodes.get(id(base))?.details || renderFolder(root, base, root.name);
      if (root.id === openRoot) details.open = true;
      fragment.append(details);
    }
    tree.replaceChildren(fragment);
  }

  window.addEventListener('factory-issue-folders-migrated', async () => {
    const user = nodes.get(id({ root: 'user', path: '' }));
    if (!user) return;
    user.details.open = true;
    await loadDirectory(user);
  });

  window.addEventListener('factory-issue-folder-created', async (event) => {
    try {
      const parts = event.detail.split('/');
      for (let count = 0; count <= parts.length; count++) {
        const entry = nodes.get(id({ root: 'user', path: parts.slice(0, count).join('/') }));
        if (!entry) break;
        entry.details.open = true;
        await loadDirectory(entry);
      }
    } catch (failure) {
      status(failure.message);
    }
  });

  document
    .getElementById('add-sidebar-folder')
    .addEventListener('click', () => show({ kind: 'add', name: 'Add folder' }));
  byId('close').addEventListener('click', () => dialog.close());
  byId('browse').addEventListener('click', async () => {
    byId('browse').disabled = true;
    try {
      const result = await change({ action: 'choose' });
      if (!result.cancelled) {
        await refresh(result.id);
        dialog.close();
      }
    } catch (failure) {
      error(failure.message);
    } finally {
      byId('browse').disabled = false;
    }
  });
  byId('open').addEventListener('click', () =>
    change({ action: 'open', ...current.base }).catch((failure) => error(failure.message))
  );
  byId('install').addEventListener('click', async () => {
    try {
      await change({ action: 'install-skill', ...current.base });
      dialog.close();
      status('Project skill installed.');
    } catch (failure) {
      error(failure.message);
    }
  });
  byId('copy').addEventListener('click', () =>
    show({
      kind: 'copy',
      name: 'Copy Markdown to user/',
      value:
        (current.base.root === 'system-flow' ? 'flow/' : 'skills/') + current.base.path.replace(/\.md$/i, '-copy.md'),
      base: current.base,
    })
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const { kind, base, file } = current;
    const input = { action: kind, ...base };
    if (kind === 'add') input.path = path.value.trim();
    if (['directory', 'create'].includes(kind)) input.path = childPath(base.path, path.value.trim());
    if (kind === 'copy') input.destination = path.value.trim();
    if (kind === 'save') input.revision = file.revision;
    if (['save', 'create'].includes(kind)) input.text = text.value;
    byId('submit').disabled = true;
    try {
      const result = await change(input);
      if (kind === 'add') await refresh(result.id);
      else if (kind !== 'save') {
        const entry = nodes.get(id(kind === 'copy' ? { root: 'user', path: '' } : base));
        if (entry?.details.open) await loadDirectory(entry);
      }
      dialog.close();
    } catch (failure) {
      error(failure.message);
    } finally {
      byId('submit').disabled = false;
    }
  });

  const sidebar = tree.closest('aside');
  sidebar.addEventListener('dragover', (event) => {
    if (![...event.dataTransfer.types].some((type) => type === 'Files' || type === 'text/uri-list')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  sidebar.addEventListener('drop', async (event) => {
    if (![...event.dataTransfer.types].some((type) => type === 'Files' || type === 'text/uri-list')) return;
    event.preventDefault();
    const urls = event.dataTransfer
      .getData('text/uri-list')
      .split(/\r?\n/)
      .filter((url) => url.startsWith('file://'));
    if (!urls.length) {
      show({ kind: 'add', name: 'Add dropped folder' });
      error('Choose the dropped folder or enter its full path to keep it in the sidebar.');
      return;
    }
    try {
      for (const url of urls) await refresh((await change({ action: 'add', path: url })).id);
    } catch (failure) {
      status(failure.message);
    }
  });

  refresh().catch((failure) => status(failure.message));
})();
