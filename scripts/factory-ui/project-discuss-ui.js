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
  window.timeyChatMarkdown = markdown;
  window.createProjectDiscussUI = (options) => {
    const { request, post, rootId, idPrefix, fixedConversation, draftKey } = {
      rootId: 'project-discuss',
      idPrefix: '',
      fixedConversation: false,
      draftKey: () => '',
      ...options,
    };
    const root = document.getElementById(rootId);
    const byId = (id) => root.querySelector('[id="' + idPrefix + id + '"]');
    root.innerHTML = document
      .getElementById('shared-discuss-template')
      .innerHTML.replaceAll('id="discuss-', 'id="' + idPrefix + 'discuss-');
    root.querySelector('.discuss-conversations').hidden = fixedConversation;
    const draft = byId('discuss-draft');
    const form = byId('discuss-form');
    const log = byId('discuss-messages');
    const view = window.timeyView;
    let openingScroll = null;
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
      log.addEventListener(
        event,
        () => {
          openingScroll = null;
        },
        { passive: true }
      );
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
      selectedId = fixedConversation ? null : new URL(location.href).searchParams.get('conversation'),
      loading = false,
      pending = false,
      editId = null,
      attachments = [],
      timer;
    const localDrafts = new Map();
    const session = () => data?.selected;
    let setup = null;
    async function discoverSkills() {
      const value = await request(
        '/api/project-discuss-skills?model=' + encodeURIComponent(byId('discuss-model').value)
      );
      setup = value.setup;
      clarificationSelect.discovered(value.skills || value);
      return value.skills || value;
    }
    const clarificationSelect = window.createSkillSelect(byId('discuss-clarification'), {
      onChange: () => void saveSettings(),
      onSetup: setupSkills,
      onAdd: () => void action('open-skill-extension'),
    });
    const skillComposer = window.createSkillComposer(form, draft, discoverSkills);
    const settings = () => ({
      model: byId('discuss-model').value,
      effort: byId('discuss-effort').value,
      clarificationSkill: byId('discuss-clarification').value,
      skills: skillComposer.skills(),
    });
    function error(message) {
      view.text(byId('discuss-error'), message || '');
      byId('discuss-error').hidden = !message;
    }
    function localKey(id) {
      return 'timey-discuss-draft:' + location.host + ':' + draftKey() + ':' + id;
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
      view.remember(log);
      view.remember(draft);
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
      if (selected && !entries.some((entry) => entry.value === selected))
        entries = [...entries, { value: selected, label: selected + ' · unavailable', disabled: true }];
      const html = entries
        .map(
          ({ value, label, disabled }) =>
            `<option value="${escape(value)}"${disabled ? ' disabled' : ''}>${escape(label)}</option>`
        )
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
    function messageMetadata(message) {
      const model = message.settings?.model;
      return (message.status || '') + (model ? ' · ' + model + ' · ' + capitalize(message.settings.effort) : '');
    }
    function messageText(message) {
      return message.text || message.body || '';
    }
    function retryButton(message) {
      const disabled = isChatBusy() ? ' disabled' : '';
      return `<button class="small-button" type="button" data-discuss-retry="${escape(message.replyTo || message.id)}"${disabled}>Retry</button>`;
    }
    function isChatBusy() {
      return running(session()?.status) || pending;
    }
    function messageEditAction(message, user) {
      if (user)
        return `<button class="discuss-icon-button" type="button" data-discuss-edit="${escape(message.id)}" aria-label="Edit message" title="Edit message"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 11-.7 3 3-.7L13 5.6 10.4 3z"/><path d="m9.7 3.7 2.6 2.6"/></svg></button>`;
      return message.localNoteId ? '' : retryButton(message);
    }
    function messageAttachments(message) {
      return `<div class="discuss-attachments">${(message.attachments || []).map((file) => attachmentHtml(file)).join('')}</div>`;
    }
    function messageHtml(message) {
      const user = message.role === 'user' || message.role === 'human';
      return window.chatMessageMarkup({
        id: message.id,
        user,
        meta: messageMetadata(message),
        content: markdown(messageText(message)),
        aiSource: messageText(message),
        aiKey: 'discuss-' + selectedId + '-' + message.id,
        tail: `${messageAttachments(message)}${eventsHtml(message.events)}<div class="discuss-message-actions"><button class="discuss-icon-button" type="button" data-discuss-copy="${escape(message.id)}" aria-label="Copy message" title="Copy message"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="9" rx="1"/><path d="M3 11V3h8"/></svg></button>${messageEditAction(message, user)}</div>`,
      });
    }
    function conversationTab(entry) {
      const selected = entry.id === selectedId;
      const title = entry.title || 'New conversation';
      return `<div class="discuss-conversation-tab" role="tab" tabindex="${selected ? '0' : '-1'}" aria-selected="${selected}" aria-controls="discuss-messages" data-discuss-conversation="${escape(entry.id)}" title="${escape(title)}"><span>${escape(title)}</span><button type="button" class="discuss-tab-close" data-discuss-close="${escape(entry.id)}" aria-label="Close ${escape(title)}" title="Close chat">×</button></div>`;
    }
    function renderConversationTabs() {
      view.render(
        byId('discuss-conversation-tabs'),
        (data?.conversations || []).map(conversationTab).join(''),
        'discuss-tabs'
      );
    }
    function emptyConversation() {
      return fixedConversation
        ? ''
        : '<div class="discuss-empty"><h2>What would you like to work on?</h2><p>Ask about the codebase, choose a skill with /, or request a project action.</p></div>';
    }
    function render() {
      const current = session();
      const scope = 'discuss:' + selectedId;
      view.track(draft, scope + ':draft');
      const selectedSettings = editId ? settings() : desiredSettings || current?.settings;
      renderConversationTabs();
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
      clarificationSelect.update(data?.clarificationSkills || [], selectedSettings?.clarificationSkill || 'none');
      byId('discuss-effort').closest('label').hidden =
        data?.models?.find(({ id }) => id === byId('discuss-model').value)?.supportsEffort === false;
      const html =
        (current?.messages || [])
          .map(
            (message) =>
              messageHtml(message) +
              (message.localNoteId
                ? `<div class="discuss-note-offer">${message.localNoteDeleted ? 'Original note deleted.' : `<button type="button" class="small-button" data-discuss-delete-note="${escape(message.localNoteId)}">Delete original note</button>`}</div>`
                : '')
          )
          .join('') || emptyConversation();
      restoreOpeningScroll(scope);
      view.render(log, html, scope);
      view.render(
        byId('discuss-queue'),
        (current?.queue || [])
          .filter((entry) => !['completed', 'removed', 'failed', 'interrupted'].includes(entry.status))
          .map(
            (entry) =>
              `<div class="discuss-queued"><span>${escape(entry.text)}</span><small>${escape(entry.settings?.model || '')} · ${escape(entry.settings?.effort || '')}</small><button type="button" class="small-button" data-discuss-queue-edit="${escape(entry.id)}">Edit queued</button><button type="button" class="small-button" data-discuss-queue-remove="${escape(entry.id)}">Remove</button><button type="button" class="small-button" data-discuss-steer="${escape(entry.id)}"${!running(current?.status) ? ' disabled' : ''}>Steer</button></div>`
          )
          .join(''),
        'discuss-queue:' + selectedId
      );
      renderApprovals(current?.approvals || []);
      renderAttachments();
      renderSuggestion();
      updateControls();
      scrollOpeningHistory();
    }
    function restoreOpeningScroll(scope) {
      if (view.read(scope)?.root?.follow === false) openingScroll = null;
    }
    function scrollOpeningHistory() {
      if (!openingScroll || !visible || !session()) return;
      const opening = {};
      openingScroll = opening;
      log.scrollTop = log.scrollHeight;
      const images = [...log.querySelectorAll('img')].filter((image) => !image.complete);
      Promise.all(images.map(waitForImage)).then(() => {
        if (openingScroll !== opening) return;
        log.scrollTop = log.scrollHeight;
        openingScroll = null;
      });
    }
    function waitForImage(image) {
      return new Promise((resolve) => {
        const settled = () => {
          image.removeEventListener('load', settled);
          image.removeEventListener('error', settled);
          resolve();
        };
        image.addEventListener('load', settled);
        image.addEventListener('error', settled);
      });
    }
    function renderAttachments() {
      view.render(
        byId('discuss-draft-attachments'),
        attachments.map((file) => attachmentHtml(file, true)).join(''),
        'discuss-attachments:' + selectedId
      );
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
      const key = JSON.stringify([selectedId, approvals]);
      if (holder.dataset.basis === key) return;
      holder.dataset.basis = key;
      view.render(
        holder,
        approvals
          .map((approval) => {
            const params = approval.params || approval;
            const questions = params.questions || [];
            const id = approval.requestId || approval.id;
            if (questions.length)
              return `<form class="discuss-approval" data-view-key="${escape(id)}" data-discuss-answer="${escape(id)}"><h3>Your input is needed</h3>${questions.map((question) => `<label>${escape(question.question || question.header)}<input data-discuss-question="${escape(question.id)}" required></label>`).join('')}<button class="primary-button" type="submit">Answer</button></form>`;
            const options = approval.options || [
              { id: 'allow', label: 'Allow once' },
              { id: 'decline', label: 'Decline' },
            ];
            return `<section class="discuss-approval" data-view-key="${escape(id)}"><h3>Permission requested</h3><pre>${escape(params.reason || params.command || JSON.stringify(params))}</pre>${options.map((option) => `<button type="button" class="small-button" data-discuss-approval="${escape(id)}" data-decision="${escape(option.id)}">${escape(option.label)}</button>`).join('')}</section>`;
          })
          .join(''),
        'discuss-approvals:' + selectedId
      );
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
      if (fixedConversation) return;
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
    for (const id of ['discuss-model', 'discuss-effort'])
      byId(id).addEventListener('change', () => void saveSettings());
    async function setupSkills() {
      try {
        await discoverSkills();
        if (!setup?.needed || (!selectedId && !(await create()))) return;
        await action('send', {
          clientId: crypto.randomUUID(),
          text:
            setup.prompt +
            '\nAdditional skill sources from the chat grilling Markdown: ' +
            JSON.stringify(
              (data?.clarificationSkills || [])
                .filter((entry) => entry.source)
                .map(({ name, source }) => ({ name, source }))
            ),
          settings: { ...settings(), clarificationSkill: 'none', skills: [] },
          attachments: [],
        });
      } catch (failure) {
        error(failure.message);
      }
    }
    byId('discuss-refresh-skills').addEventListener('click', () => {
      void discoverSkills().catch((failure) => error(failure.message));
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
      if (button.dataset.discussDeleteNote) {
        await action('delete-note', { noteId: button.dataset.discussDeleteNote });
        void window.localNotesUI?.refresh();
        return;
      }
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
      if (button.dataset.discussRetry) {
        const native = /^(anthropic|google):/.test(session()?.threadId || '');
        if (
          native &&
          !confirm(
            'Inspect completed file changes and command results before retrying. Confirm that you reviewed the partial work and the original agent has stopped. The original session will be continued.'
          )
        )
          return;
        void action('retry', {
          messageId: button.dataset.discussRetry,
          clientId: crypto.randomUUID(),
          confirmedAgentRecovery: native,
        });
      }
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
    const dictation = window.createChatDictation({
      button: byId('discuss-mic'),
      draft,
      status: byId('discuss-voice-status'),
      getConversationId: () => selectedId,
      changed: changedDraft,
      submit: () => form.requestSubmit(),
    });
    const polling = setInterval(() => {
      if (visible && !document.hidden) void refresh();
    }, 1500);
    return {
      async setVisible(value) {
        const was = visible;
        visible = value;
        if (value && !was) {
          root.hidden = false;
          openingScroll = {};
          await refresh(true);
          void discoverSkills().catch((failure) => error(failure.message));
        }
        if (!value && was) {
          openingScroll = null;
          remember();
          void saveDraft();
        }
        root.hidden = !value;
      },
      refresh,
      draft() {
        return draft.value;
      },
      setDraft(text) {
        draft.value = text || '';
        changedDraft();
      },
      destroy() {
        visible = false;
        clearInterval(polling);
        clearTimeout(timer);
        dictation.stop();
      },
    };
  };
})();
