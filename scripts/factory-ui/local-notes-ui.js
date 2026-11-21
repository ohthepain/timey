(() => {
  'use strict';
  const root = document.getElementById('local-notes');
  if (!root) return;
  const disclosure = document.getElementById('local-notes-toggle');
  const body = document.getElementById('local-notes-body');
  disclosure.addEventListener('click', () => {
    body.hidden = !body.hidden;
    disclosure.setAttribute('aria-expanded', String(!body.hidden));
    disclosure.setAttribute('aria-label', (body.hidden ? 'Expand ' : 'Collapse ') + 'Local notes');
  });
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  const list = document.getElementById('local-note-list');
  const field = document.getElementById('local-note-text');
  const status = document.getElementById('local-note-status');
  const editor = document.getElementById('local-note-editor');
  const editText = document.getElementById('local-note-edit-text');
  const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  let current = { notes: [], basis: '', issueNumbers: {} };
  let busy = false;
  let editing = null;
  let captureId = null;
  const draftKey = 'timey-local-note-draft:' + location.host;
  try {
    field.value = sessionStorage.getItem(draftKey) || '';
  } catch {}

  async function request(path, input) {
    const response = await fetch(
      '/api/' + path,
      input
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Factory-Action': 'manual' },
            body: JSON.stringify(input),
          }
        : { cache: 'no-store' }
    );
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Could not save local notes.');
    return result;
  }
  function issueLinkLabel(issueId) {
    const number = current.issueNumbers[issueId];
    return number == null ? 'Open issue' : `Open issue #${number}`;
  }
  function render(value) {
    if (current.basis === value.basis && JSON.stringify(current.issueNumbers) === JSON.stringify(value.issueNumbers))
      return;
    current = value;
    const expanded = new Set([...list.querySelectorAll('details[open]')].map((node) => node.dataset.note));
    list.innerHTML = current.notes
      .map(
        (note, index) => `<li class="local-note${note.done ? ' is-done' : ''}" data-note-id="${note.id}">
      <div class="local-note-row"><input type="checkbox" data-note-complete="${note.id}" aria-label="Complete note: ${escape(note.text)}"${note.done ? ' checked' : ''}><button type="button" class="local-note-title" data-note-edit="${note.id}">${escape([...sentences.segment(note.text)][0].segment.trim())}</button></div>
      <details data-note="${note.id}"${expanded.has(note.id) ? ' open' : ''}><summary>Actions</summary><div class="local-note-actions">
      <button type="button" class="small-button" data-note-action="discuss" data-note="${note.id}">Discuss</button>
      <button type="button" class="small-button" data-note-action="issue" data-note="${note.id}">Turn into issue</button>
      <button type="button" class="small-button" data-note-action="up" data-note="${note.id}" aria-label="Move note up"${index === 0 ? ' disabled' : ''}>↑</button>
      <button type="button" class="small-button" data-note-action="down" data-note="${note.id}" aria-label="Move note down"${index === current.notes.length - 1 ? ' disabled' : ''}>↓</button>
      <button type="button" class="small-button" data-note-action="delete" data-note="${note.id}">Delete</button></div></details>
      ${note.issueId ? `<a class="local-note-issue" href="/?issue=${encodeURIComponent(note.issueId)}">${escape(issueLinkLabel(note.issueId))}</a>` : ''}</li>`
      )
      .join('');
  }
  async function refresh() {
    if (busy || document.hidden) return;
    try {
      render(await request('local-notes'));
    } catch (error) {
      status.textContent = error.message;
    }
  }
  async function change(input) {
    if (busy) throw Error('Wait for the note to finish saving.');
    busy = true;
    root.setAttribute('aria-busy', 'true');
    status.textContent = '';
    try {
      const result = await request('local-notes-action', {
        ...(input.action === 'create' ? {} : { basis: current.basis }),
        ...input,
      });
      render(result);
      return result;
    } finally {
      busy = false;
      root.removeAttribute('aria-busy');
    }
  }
  function openEditor(note) {
    editing = note
      ? { action: 'edit', id: note.id, basis: current.basis }
      : { action: 'create', id: crypto.randomUUID() };
    editText.value = note?.text || '';
    document.getElementById('local-note-editor-heading').textContent = note ? 'Edit note' : 'Quick note';
    document.getElementById('local-note-edit-error').textContent = '';
    editor.showModal();
    editText.focus();
  }
  function openDiscuss(result) {
    const url = new URL('/', location.href);
    url.searchParams.set('projectTab', 'discuss');
    url.searchParams.set('conversation', result.conversationId);
    location.assign(url);
  }
  async function saveCapture(event) {
    event.preventDefault();
    if (!field.value.trim() || busy) return;
    captureId ||= crypto.randomUUID();
    const capturedText = field.value;
    try {
      await change({ action: 'create', id: captureId, text: capturedText });
      if (field.value === capturedText) {
        field.value = '';
        try {
          sessionStorage.removeItem(draftKey);
        } catch {}
      }
      captureId = null;
      status.textContent = 'Note saved.';
      field.focus();
    } catch (error) {
      status.textContent = error.message;
    }
  }
  document.getElementById('local-note-form').addEventListener('submit', saveCapture);
  field.addEventListener('input', () => {
    captureId = null;
    try {
      sessionStorage.setItem(draftKey, field.value);
    } catch {}
  });
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      document.getElementById('local-note-form').requestSubmit();
    }
  });
  document.getElementById('local-note-edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    try {
      await change({ ...editing, text: editText.value });
      editor.close();
      status.textContent = 'Note saved.';
    } catch (error) {
      document.getElementById('local-note-edit-error').textContent = error.message;
    }
  });
  document.getElementById('local-note-edit-cancel').onclick = () => editor.close();
  document.getElementById('local-note-quick').onclick = () => openEditor();
  document.addEventListener('keydown', (event) => {
    if (window.FactoryHotkeys.matches(event, 'newNote') && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      openEditor();
    }
  });
  list.addEventListener('change', async (event) => {
    const id = event.target.dataset.noteComplete;
    if (!id) return;
    try {
      await change({ action: 'complete', id, done: event.target.checked });
    } catch (error) {
      event.target.checked = !event.target.checked;
      status.textContent = error.message;
    }
  });
  list.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button || busy) return;
    const note = current.notes.find((entry) => entry.id === (button.dataset.note || button.dataset.noteEdit));
    if (!note) return;
    if (button.dataset.noteEdit) return openEditor(note);
    const action = button.dataset.noteAction;
    try {
      if (action === 'issue') return window.openFlowCaptureFromNote(note);
      if (action === 'discuss') return openDiscuss(await change({ action, id: note.id }));
      if (action === 'up' || action === 'down') await change({ action: 'move', id: note.id, direction: action });
      else await change({ action, id: note.id });
    } catch (error) {
      status.textContent = error.message;
    }
  });
  window.localNotesUI = {
    refresh,
    async issueCreated(note, issueId) {
      status.replaceChildren();
      const link = document.createElement('a');
      link.href = '/?issue=' + encodeURIComponent(issueId);
      link.textContent = 'Issue created. Open issue';
      status.append(link);
      const value = await request('local-notes');
      const result = await request('local-notes-action', { action: 'link', id: note.id, issueId, basis: value.basis });
      render(result);
      openDiscuss(result);
    },
  };
  void refresh();
  setInterval(() => void refresh(), 3000);
})();
