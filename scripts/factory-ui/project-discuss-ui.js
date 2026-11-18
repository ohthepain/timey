(() => {
  'use strict';
  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  const capitalize = (value) => String(value ?? '').replace(/^./, (character) => character.toUpperCase());
  const byId = (id) => document.getElementById(id);
  const running = (status) => ['running', 'starting', 'stopping', 'dispatching'].includes(status);
  function safeLink(value) {
    try {
      const url = new URL(value, location.href);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch {
      return '';
    }
  }
  function inline(value) {
    return escape(value)
      .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, href) => {
        const url = safeLink(href.replaceAll('&amp;', '&'));
        return url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
      })
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }
  function markdown(value) {
    if (window.markdownit) {
      const renderer = window.markdownit({ html: false, linkify: true, breaks: true });
      renderer.renderer.rules.fence = (tokens, index) =>
        `<div class="discuss-code"><button type="button" class="small-button" data-discuss-copy-code>Copy code</button><pre><code>${escape(tokens[index].content)}</code></pre></div>`;
      return renderer.render(String(value || ''));
    }
    return String(value || '')
      .split(/(```[\s\S]*?```)/g)
      .map((part) => {
        if (part.startsWith('```')) {
          const code = part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
          return `<div class="discuss-code"><button type="button" class="small-button" data-discuss-copy-code>Copy code</button><pre><code>${escape(code)}</code></pre></div>`;
        }
        return part
          .split(/\n\s*\n/)
          .filter(Boolean)
          .map((paragraph) => {
            if (/^#{1,6} /.test(paragraph)) return `<h3>${inline(paragraph.replace(/^#+ /, ''))}</h3>`;
            if (/^[-*] /.test(paragraph))
              return `<ul>${paragraph
                .split('\n')
                .map((line) => `<li>${inline(line.replace(/^[-*] /, ''))}</li>`)
                .join('')}</ul>`;
            return `<p>${inline(paragraph).replaceAll('\n', '<br>')}</p>`;
          })
          .join('');
      })
      .join('');
  }
  window.createProjectDiscussUI = ({ request, post }) => {
    const root = byId('project-discuss');
    root.innerHTML = `<div class="discuss-conversations"><div id="discuss-conversation-tabs" role="tablist" aria-label="Project conversations"></div><button id="discuss-new" class="small-button" type="button">New chat</button></div>
      <p id="discuss-error" class="inline-error" role="alert" hidden></p><div id="discuss-messages" class="discuss-messages" role="log" aria-label="Project conversation messages"></div>
      <div id="discuss-approvals" class="discuss-approvals"></div><div id="discuss-queue" class="discuss-queue" aria-label="Queued messages"></div>
      <form id="discuss-form" class="discuss-composer"><p id="discuss-editing" class="muted" hidden></p><div id="discuss-draft-attachments" class="discuss-attachments"></div><div class="discuss-draft-wrap"><textarea id="discuss-draft" aria-label="Message project" rows="3" maxlength="64000" placeholder="Ask about your project, or type / to choose a skill…"></textarea><span id="discuss-suggestion" class="discuss-suggestion" aria-hidden="true"></span></div><div class="discuss-composer-actions"><div><div class="discuss-toolbar"><label><span class="visually-hidden">Clarification skill</span><select id="discuss-clarification" aria-label="Clarification skill"></select></label><label><span class="visually-hidden">Model</span><select id="discuss-model" aria-label="Discuss model"></select></label><label><span class="visually-hidden">Effort</span><select id="discuss-effort" aria-label="Discuss effort"></select></label><button id="discuss-refresh-skills" class="small-button" type="button">Refresh skills</button><label class="discuss-icon-control" title="Attach files"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 8.5 4.1-4.1a2.1 2.1 0 0 1 3 3l-5.7 5.7a3.3 3.3 0 0 1-4.7-4.7l5.5-5.5"/></svg><span class="visually-hidden">Attach files</span><input id="discuss-files" type="file" multiple hidden></label><button id="discuss-mic" class="discuss-icon-control" type="button" aria-label="Start dictation" title="Dictate"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="6" y="2" width="4" height="8" rx="2"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2m-2 0h4"/></svg></button></div><span id="discuss-voice-status" class="muted" role="status"></span></div><div><button id="discuss-cancel-edit" class="small-button" type="button" hidden>Cancel edit</button><button id="discuss-resume" class="small-button" type="button" hidden>Resume</button><button id="discuss-send" class="discuss-send-button" type="submit" aria-label="Send message" title="Send message"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16V4M5 9l5-5 5 5"/></svg></button></div></div></form><p id="discuss-status" class="visually-hidden" role="status"></p>`;
    const draft = byId('discuss-draft');
    const form = byId('discuss-form');
    const composerObserver = new ResizeObserver(() => {
      root.style.setProperty('--discuss-composer-height', `${form.getBoundingClientRect().height}px`);
    });
    composerObserver.observe(form);
    let draftSave = Promise.resolve();
    let settingsSave = Promise.resolve();
    let actionSave = Promise.resolve();
    let settingsVersion = 0;
    let desiredSettings = null;
    let pendingActions = 0;
    let creating = false;
    let draftRevision = 0;
    let visible = false,
      data = null,
      selectedId = new URL(location.href).searchParams.get('conversation'),
      loading = false,
      pending = false,
      editId = null,
      attachments = [],
      timer,
      recognition = null;
    const localDrafts = new Map();
    const session = () => data?.selected;
    const skillComposer = window.createSkillComposer(form, draft, async () => {
      const value = await request('/api/project-discuss-skills');
      return value.skills || value;
    });
    const settings = () => ({
      model: byId('discuss-model').value,
      effort: byId('discuss-effort').value,
      clarificationSkill: byId('discuss-clarification').value,
      skills: skillComposer.skills(),
    });
    function error(message) {
      byId('discuss-error').textContent = message || '';
      byId('discuss-error').hidden = !message;
    }
    function localKey(id) {
      return 'timey-discuss-draft:' + location.host + ':' + id;
    }
    function readLocal(id) {
      if (localDrafts.has(id)) return localDrafts.get(id);
      try {
        return JSON.parse(localStorage.getItem(localKey(id)));
      } catch {
        return null;
      }
    }
    function remember() {
      if (!selectedId) return;
      const value = { text: draft.value, attachments, skills: skillComposer.skills() };
      localDrafts.set(selectedId, value);
      try {
        localStorage.setItem(localKey(selectedId), JSON.stringify(value));
      } catch {
        /* A full browser store must not lose the in-memory draft. */
      }
    }
    async function saveDraft() {
      const id = selectedId;
      if (!id || editId || creating) return;
      const snapshot = { text: draft.value, attachments: [...attachments] };
      const snapshotSettings = { skills: skillComposer.skills() };
      const basis = JSON.stringify(snapshot);
      remember();
      try {
        const previous = draftSave;
        draftSave = (async () => {
          await previous.catch(() => {});
          await post('project-discuss-action', { action: 'settings', conversationId: id, settings: snapshotSettings });
          return post('project-discuss-action', { action: 'draft', conversationId: id, draft: snapshot });
        })();
        const result = await draftSave;
        if (id === selectedId && basis === JSON.stringify({ text: draft.value, attachments })) {
          attachments = result.selected?.draft?.attachments || attachments;
          remember();
          renderAttachments();
        }
      } catch (failure) {
        if (id === selectedId) error('Draft is kept in this browser. ' + failure.message);
      }
    }
    function changedDraft() {
      draftRevision++;
      remember();
      renderSuggestion();
      clearTimeout(timer);
      timer = setTimeout(() => void saveDraft(), 450);
    }
    function apply(value, restore = false) {
      const oldId = selectedId;
      data = value;
      selectedId = value.selected?.id || selectedId;
      if (desiredSettings && value.selected?.id === selectedId)
        desiredSettings = { ...value.selected.settings, ...desiredSettings };
      if (restore || oldId !== selectedId) {
        if (oldId !== selectedId) desiredSettings = null;
        const saved = readLocal(selectedId) || value.selected?.draft || {};
        draft.value = saved.text || '';
        attachments = saved.attachments || [];
        skillComposer.restore(saved.skills || value.selected?.settings?.skills || []);
        editId = null;
      }
      render();
    }
    async function refresh(restore = false) {
      if (loading || pending || !visible) return;
      loading = true;
      const requested = selectedId;
      try {
        const query = selectedId ? '?conversation=' + encodeURIComponent(selectedId) : '';
        const result = await request('/api/project-discuss' + query);
        if (selectedId !== requested) return;
        apply(result, restore);
        error('');
      } catch (failure) {
        error(failure.message);
      } finally {
        loading = false;
      }
    }
    async function saveSettings() {
      desiredSettings = settings();
      const snapshot = { ...desiredSettings, skills: [...desiredSettings.skills] };
      const version = ++settingsVersion;
      const id = selectedId;
      if (!id || editId || creating) return;
      const previous = settingsSave;
      settingsSave = (async () => {
        await previous.catch(() => {});
        const result = await post('project-discuss-action', {
          action: 'settings',
          conversationId: id,
          settings: snapshot,
        });
        if (id !== selectedId) return;
        apply(result);
      })();
      try {
        await settingsSave;
      } catch (failure) {
        error(failure.message);
      }
    }
    async function action(name, fields = {}) {
      const requested = selectedId;
      const previous = actionSave;
      pendingActions++;
      pending = true;
      updateControls();
      error('');
      actionSave = (async () => {
        await previous.catch(() => {});
        const result = await post('project-discuss-action', { action: name, conversationId: requested, ...fields });
        if (selectedId === requested) apply(result);
        return result;
      })();
      try {
        return await actionSave;
      } catch (failure) {
        error(failure.message);
        return null;
      } finally {
        pendingActions--;
        pending = pendingActions > 0;
        updateControls();
      }
    }
    function choices(id, entries, selected) {
      const node = byId(id);
      const html = entries
        .map(({ value, label }) => `<option value="${escape(value)}">${escape(label)}</option>`)
        .join('');
      if (node.innerHTML !== html) node.innerHTML = html;
      if (entries.some((entry) => entry.value === selected)) node.value = selected;
    }
    function attachmentHtml(file, remove = false) {
      const url = safeLink(file.url || '');
      const imageUrl = file.url
        ? url
        : /^image\/(png|jpeg|gif|webp)$/.test(file.mime) && file.data
          ? 'data:' + file.mime + ';base64,' + file.data
          : '';
      const image = imageUrl ? `<img src="${escape(imageUrl)}" alt="${escape(file.name)}">` : '';
      return `<span class="discuss-attachment">${image}${file.url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(file.name)}</a>` : escape(file.name)}${remove ? `<button type="button" data-discuss-remove-file="${escape(file.id || file.name)}" aria-label="Remove ${escape(file.name)}">×</button>` : ''}</span>`;
    }
    function eventsHtml(events) {
      if (!events?.length) return '';
      return `<details class="discuss-tool-activity"><summary>Tool activity (${events.length})</summary>${events.map((event) => `<pre>${escape(event.text || event.message || event.summary || JSON.stringify(event))}</pre>`).join('')}</details>`;
    }
    function messageHtml(message) {
      const user = message.role === 'user' || message.role === 'human';
      const model = message.settings?.model;
      return `<article class="discuss-message ${user ? 'user' : 'assistant'}" data-discuss-message="${escape(message.id)}"><div class="discuss-message-heading"><strong>${user ? 'You' : 'Assistant'}</strong><span class="muted">${escape(message.status || '')}${model ? ' · ' + escape(model) + ' · ' + escape(capitalize(message.settings.effort)) : ''}</span></div><div class="discuss-message-body">${markdown(message.text || message.body || '')}</div><div class="discuss-attachments">${(message.attachments || []).map((file) => attachmentHtml(file)).join('')}</div>${eventsHtml(message.events)}<div class="discuss-message-actions"><button class="discuss-icon-button" type="button" data-discuss-copy="${escape(message.id)}" aria-label="Copy message" title="Copy message"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="9" rx="1"/><path d="M3 11V3h8"/></svg></button>${user ? `<button class="discuss-icon-button" type="button" data-discuss-edit="${escape(message.id)}" aria-label="Edit message" title="Edit message"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 11-.7 3 3-.7L13 5.6 10.4 3z"/><path d="m9.7 3.7 2.6 2.6"/></svg></button>` : `<button class="small-button" type="button" data-discuss-retry="${escape(message.replyTo || message.id)}"${running(session()?.status) || pending ? ' disabled' : ''}>Retry</button>`}</div></article>`;
    }
    function render() {
      const current = session();
      const selectedSettings = editId ? settings() : desiredSettings || current?.settings;
      byId('discuss-conversation-tabs').innerHTML = (data?.conversations || [])
        .map(
          (entry) =>
            `<div class="discuss-conversation-tab" role="tab" tabindex="${entry.id === current?.id ? '0' : '-1'}" aria-selected="${entry.id === current?.id}" aria-controls="discuss-messages" data-discuss-conversation="${escape(entry.id)}" title="${escape(entry.title || 'New conversation')}"><span>${escape(entry.title || 'New conversation')}</span><button type="button" class="discuss-tab-close" data-discuss-close="${escape(entry.id)}" aria-label="Close ${escape(entry.title || 'chat')}" title="Close chat">×</button></div>`
        )
        .join('');
      choices(
        'discuss-model',
        (data?.models || []).map((entry) => ({ value: entry.id, label: entry.name || entry.id })),
        selectedSettings?.model || data?.defaults?.model
      );
      choices(
        'discuss-effort',
        (data?.efforts || []).map((entry) => ({
          value: typeof entry === 'string' ? entry : entry.id,
          label: capitalize(typeof entry === 'string' ? entry : entry.name),
        })),
        selectedSettings?.effort || data?.defaults?.effort
      );
      choices(
        'discuss-clarification',
        (data?.clarificationSkills || []).map((entry) => ({ value: entry.name, label: entry.label || entry.name })),
        selectedSettings?.clarificationSkill || 'grilling'
      );
      const log = byId('discuss-messages');
      const html =
        (current?.messages || []).map(messageHtml).join('') ||
        '<div class="discuss-empty"><h2>What would you like to work on?</h2><p>Ask about the codebase, choose a skill with /, or request a project action.</p></div>';
      if (log.innerHTML !== html) {
        log.innerHTML = html;
      }
      byId('discuss-queue').innerHTML = (current?.queue || [])
        .filter((entry) => !['completed', 'removed', 'failed', 'interrupted'].includes(entry.status))
        .map(
          (entry) =>
            `<div class="discuss-queued"><span>${escape(entry.text)}</span><small>${escape(entry.settings?.model || '')} · ${escape(entry.settings?.effort || '')}</small><button type="button" class="small-button" data-discuss-queue-edit="${escape(entry.id)}">Edit queued</button><button type="button" class="small-button" data-discuss-queue-remove="${escape(entry.id)}">Remove</button><button type="button" class="small-button" data-discuss-steer="${escape(entry.id)}"${!running(current?.status) ? ' disabled' : ''}>Steer</button></div>`
        )
        .join('');
      renderApprovals(current?.approvals || []);
      renderAttachments();
      renderSuggestion();
      updateControls();
    }
    function renderAttachments() {
      byId('discuss-draft-attachments').innerHTML = attachments.map((file) => attachmentHtml(file, true)).join('');
    }
    function renderSuggestion() {
      const suggestion =
        [...(session()?.messages || [])].reverse().find((message) => message.suggestion)?.suggestion || '';
      const node = byId('discuss-suggestion');
      node.textContent = !draft.value && !editId ? suggestion : '';
      node.hidden = Boolean(draft.value || editId || !suggestion);
    }
    function updateControls() {
      const active = running(session()?.status);
      draft.disabled = creating;
      byId('discuss-files').disabled = creating;
      for (const id of ['discuss-model', 'discuss-effort', 'discuss-clarification']) byId(id).disabled = creating;
      byId('discuss-new').disabled = pending || creating;
      for (const tab of byId('discuss-conversation-tabs').querySelectorAll('button'))
        tab.disabled = pending || creating;
      byId('discuss-resume').hidden = !['paused', 'interrupted', 'stopped'].includes(session()?.status);
      byId('discuss-resume').disabled = pending;
      const send = byId('discuss-send');
      send.disabled = pending || creating;
      send.setAttribute('aria-label', active ? 'Stop response' : 'Send message');
      send.title = active ? 'Stop response' : 'Send message';
      send.innerHTML = active
        ? '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="5" width="10" height="10" rx="2"/></svg>'
        : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16V4M5 9l5-5 5 5"/></svg>';
      byId('discuss-cancel-edit').hidden = !editId;
      byId('discuss-editing').hidden = !editId;
      byId('discuss-editing').textContent = editId
        ? 'Editing a queued message. The current response keeps running.'
        : '';
      byId('discuss-status').textContent = active ? 'Response running' : '';
    }
    function renderApprovals(approvals) {
      const holder = byId('discuss-approvals');
      const key = JSON.stringify(approvals);
      if (holder.dataset.basis === key) return;
      holder.dataset.basis = key;
      holder.innerHTML = approvals
        .map((approval) => {
          const params = approval.params || approval;
          const questions = params.questions || [];
          const id = approval.requestId || approval.id;
          if (questions.length)
            return `<form class="discuss-approval" data-discuss-answer="${escape(id)}"><h3>Your input is needed</h3>${questions.map((question) => `<label>${escape(question.question || question.header)}<input data-discuss-question="${escape(question.id)}" required></label>`).join('')}<button class="primary-button" type="submit">Answer</button></form>`;
          const options = approval.options || [
            { id: 'allow', label: 'Allow once' },
            { id: 'decline', label: 'Decline' },
          ];
          return `<section class="discuss-approval"><h3>Permission requested</h3><pre>${escape(params.reason || params.command || JSON.stringify(params))}</pre>${options.map((option) => `<button type="button" class="small-button" data-discuss-approval="${escape(id)}" data-decision="${escape(option.id)}">${escape(option.label)}</button>`).join('')}</section>`;
        })
        .join('');
    }
    async function create() {
      if (creating) return null;
      remember();
      clearTimeout(timer);
      creating = true;
      updateControls();
      const value = await action('create', {
        requestId: crypto.randomUUID(),
        ...(desiredSettings ? { settings: desiredSettings } : {}),
      });
      if (value) {
        selectedId = value.selected.id;
        draft.value = '';
        attachments = [];
        skillComposer.reset();
        remember();
        updateUrl();
        render();
      }
      creating = false;
      updateControls();
      if (value) draft.focus();
      return value;
    }
    function updateUrl() {
      const url = new URL(location.href);
      if (selectedId) url.searchParams.set('conversation', selectedId);
      else url.searchParams.delete('conversation');
      history.replaceState(null, '', url);
    }
    async function submit(event) {
      event?.preventDefault();
      if (!draft.value.trim() && !attachments.length && !skillComposer.skills().length) return;
      clearTimeout(timer);
      const sentSettings = settings();
      const submitted = { text: draft.value, attachments: [...attachments], editId, revision: draftRevision };
      await Promise.all([draftSave.catch(() => {}), settingsSave.catch(() => {})]);
      if (!selectedId) {
        const value = { text: draft.value, attachments: [...attachments], settings: settings() };
        if (!(await create())) return;
        draft.value = value.text;
        attachments = value.attachments;
        skillComposer.restore(value.settings.skills);
      }
      const result = await action(submitted.editId ? 'edit-queued' : 'send', {
        ...(submitted.editId ? { messageId: submitted.editId } : { clientId: crypto.randomUUID() }),
        text: submitted.text,
        settings: sentSettings,
        attachments: submitted.attachments,
      });
      if (result) {
        if (draftRevision === submitted.revision && draft.value === submitted.text) {
          draft.value = '';
          attachments = [];
          editId = null;
        }
        remember();
        renderAttachments();
        renderSuggestion();
        updateControls();
        void saveDraft();
      }
    }
    form.addEventListener('submit', (event) => void submit(event));
    draft.addEventListener('input', changedDraft);
    draft.addEventListener('blur', () => void saveDraft());
    draft.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.isComposing || skillComposer.isOpen()) return;
      if (event.key === 'Tab' && !event.shiftKey && !draft.value && byId('discuss-suggestion').textContent) {
        event.preventDefault();
        draft.value = byId('discuss-suggestion').textContent;
        changedDraft();
      } else if (event.key === 'Enter' && !event.shiftKey && draft.value.trim()) {
        event.preventDefault();
        void submit();
      }
    });
    byId('discuss-new').addEventListener('click', () => void create());
    byId('discuss-conversation-tabs').addEventListener('click', async (event) => {
      const close = event.target.closest('[data-discuss-close]');
      if (close) {
        event.stopPropagation();
        const id = close.dataset.discussClose;
        const wasSelected = id === selectedId;
        remember();
        const result = await action('close', { conversationId: id, returnTo: selectedId });
        if (result) {
          selectedId = result.selected?.id || null;
          if (wasSelected) desiredSettings = null;
          editId = null;
          updateUrl();
          apply(result, true);
        }
        return;
      }
      const tab = event.target.closest('[data-discuss-conversation]');
      if (!tab || tab.dataset.discussConversation === selectedId || pending) return;
      remember();
      await saveDraft();
      selectedId = tab.dataset.discussConversation || null;
      desiredSettings = null;
      editId = null;
      updateUrl();
      await refresh(true);
    });
    for (const id of ['discuss-model', 'discuss-effort', 'discuss-clarification'])
      byId(id).addEventListener('change', () => void saveSettings());
    byId('discuss-refresh-skills').addEventListener('click', () => {
      skillComposer.refresh();
      byId('discuss-status').textContent = 'Skill discovery will refresh when you type /.';
    });
    byId('discuss-send').addEventListener('click', (event) => {
      if (!running(session()?.status)) return;
      event.preventDefault();
      void action('stop');
    });
    byId('discuss-resume').addEventListener('click', () => void action('resume'));
    byId('discuss-cancel-edit').addEventListener('click', () => {
      editId = null;
      draft.value = '';
      attachments = [];
      remember();
      render();
    });
    root.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const messages = session()?.messages || [];
      if (button.hasAttribute('data-discuss-copy-code')) {
        await navigator.clipboard.writeText(button.parentElement.querySelector('code').textContent);
        button.textContent = 'Copied';
      }
      if (button.dataset.discussCopy) {
        const message = messages.find((entry) => entry.id === button.dataset.discussCopy);
        await navigator.clipboard.writeText(message?.text || '');
        button.setAttribute('aria-label', 'Copied');
        button.title = 'Copied';
        setTimeout(() => {
          if (!button.isConnected) return;
          button.setAttribute('aria-label', 'Copy message');
          button.title = 'Copy message';
        }, 1200);
      }
      if (button.dataset.discussEdit) {
        const message = messages.find((entry) => entry.id === button.dataset.discussEdit);
        if (message) {
          editId = null;
          draft.value = message.text || '';
          attachments = [...(message.attachments || [])];
          skillComposer.restore(message.settings?.skills || []);
          changedDraft();
          renderAttachments();
          draft.focus();
        }
      }
      if (button.dataset.discussRetry)
        void action('retry', { messageId: button.dataset.discussRetry, clientId: crypto.randomUUID() });
      if (button.dataset.discussQueueRemove)
        void action('remove-queued', { messageId: button.dataset.discussQueueRemove });
      if (button.dataset.discussSteer) void action('steer', { messageId: button.dataset.discussSteer });
      if (button.dataset.discussQueueEdit) {
        const message = session()?.queue.find((entry) => entry.id === button.dataset.discussQueueEdit);
        if (message) {
          editId = message.id;
          draft.value = message.text || '';
          attachments = [...(message.attachments || [])];
          skillComposer.restore(message.settings?.skills || []);
          for (const [key, id] of [
            ['model', 'discuss-model'],
            ['effort', 'discuss-effort'],
            ['clarificationSkill', 'discuss-clarification'],
          ])
            if (message.settings?.[key]) byId(id).value = message.settings[key];
          renderAttachments();
          updateControls();
          draft.focus();
        }
      }
      if (button.dataset.discussRemoveFile) {
        attachments = attachments.filter((file) => (file.id || file.name) !== button.dataset.discussRemoveFile);
        renderAttachments();
        changedDraft();
      }
      if (button.dataset.discussApproval)
        void action('answer', {
          requestId: button.dataset.discussApproval,
          response: { decision: button.dataset.decision },
        });
    });
    root.addEventListener('submit', (event) => {
      const answer = event.target.closest('[data-discuss-answer]');
      if (!answer) return;
      event.preventDefault();
      const answers = Object.fromEntries(
        [...answer.querySelectorAll('[data-discuss-question]')].map((field) => [
          field.dataset.discussQuestion,
          field.value,
        ])
      );
      void action('answer', { requestId: answer.dataset.discussAnswer, response: { answers } });
    });
    byId('discuss-files').addEventListener('change', async (event) => {
      try {
        for (const file of event.target.files) {
          if (file.size > 10 * 1024 * 1024) throw Error('Choose files smaller than 10 MB.');
          const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = () => reject(Error('The selected file could not be read.'));
            reader.readAsDataURL(file);
          });
          attachments.push({ name: file.name, mime: file.type || 'application/octet-stream', data });
        }
        event.target.value = '';
        renderAttachments();
        changedDraft();
      } catch (failure) {
        error(failure.message);
      }
    });
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    byId('discuss-mic').addEventListener('click', () => {
      const status = byId('discuss-voice-status');
      if (!SpeechRecognition) {
        status.textContent = 'Dictation is unavailable in this browser. You can keep typing.';
        return;
      }
      if (recognition) {
        recognition.stop();
        return;
      }
      const original = draft.value;
      recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        const text = [...event.results].map((result) => result[0].transcript).join(' ');
        draft.value = original + (original && text ? ' ' : '') + text;
        changedDraft();
      };
      recognition.onerror = (event) => {
        status.textContent = 'Dictation failed: ' + event.error + '. Your draft is preserved; retry or type.';
      };
      recognition.onend = () => {
        recognition = null;
        byId('discuss-mic').innerHTML =
          '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="6" y="2" width="4" height="8" rx="2"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2m-2 0h4"/></svg>';
        byId('discuss-mic').setAttribute('aria-label', 'Start dictation');
        byId('discuss-mic').title = 'Dictate';
        if (status.textContent === 'Listening…')
          status.textContent = 'Dictation finished. Edit the text before sending.';
      };
      try {
        recognition.start();
        status.textContent = 'Listening…';
        byId('discuss-mic').innerHTML =
          '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1"/></svg>';
        byId('discuss-mic').setAttribute('aria-label', 'Stop dictation');
        byId('discuss-mic').title = 'Stop dictation';
      } catch (failure) {
        recognition = null;
        status.textContent = 'Dictation could not start. Your draft is preserved. ' + failure.message;
      }
    });
    setInterval(() => {
      if (visible && !document.hidden) void refresh();
    }, 1500);
    return {
      setVisible(value) {
        const was = visible;
        visible = value;
        root.hidden = !value;
        if (value && !was) void refresh(true);
        if (!value && was) {
          remember();
          void saveDraft();
        }
      },
      refresh,
    };
  };
})();
