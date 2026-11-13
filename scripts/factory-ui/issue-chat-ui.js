window.createSkillComposer = function createSkillComposer(form, draft, load) {
  const selector = document.createElement('div');
  selector.className = 'skill-selector';
  selector.setAttribute('role', 'listbox');
  selector.hidden = true;
  const chips = document.createElement('div');
  chips.className = 'skill-chips';
  chips.hidden = true;
  form.insertBefore(selector, draft);
  form.insertBefore(chips, draft);
  let options = [],
    selected = [],
    loaded = null,
    query = '',
    start = 0,
    active = 0,
    allowed = true,
    busy = false,
    generation = 0;
  const matches = () =>
    options.filter(
      (skill) =>
        !selected.some((item) => item.name === skill.name) &&
        `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
    );
  function render() {
    chips.replaceChildren();
    for (const skill of selected) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'skill-chip';
      chip.setAttribute('aria-label', `Remove ${skill.name} skill`);
      const icon = document.createElement('span');
      icon.textContent = skill.icon || '✦';
      const label = document.createElement('span');
      label.textContent = skill.name;
      const remove = document.createElement('span');
      remove.className = 'skill-chip-remove';
      remove.setAttribute('aria-hidden', 'true');
      remove.textContent = '×';
      chip.append(icon, label, remove);
      chip.addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        selected = selected.filter((item) => item.name !== skill.name);
        render();
        draft.focus();
      });
      chips.append(chip);
    }
    chips.hidden = selected.length === 0;
  }
  function close() {
    generation++;
    selector.hidden = true;
    selector.replaceChildren();
  }
  function show() {
    if (!allowed || !matches().length) {
      close();
      return;
    }
    const found = matches();
    active = Math.min(active, found.length - 1);
    selector.replaceChildren();
    found.forEach((skill, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'skill-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === active));
      const icon = document.createElement('span');
      icon.className = 'skill-option-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = skill.icon || '✦';
      const details = document.createElement('span');
      details.className = 'skill-option-details';
      const name = document.createElement('strong');
      name.textContent = skill.name;
      const description = document.createElement('span');
      description.textContent = skill.description;
      const source = document.createElement('small');
      source.textContent = skill.source;
      details.append(name, description);
      option.append(icon, details, source);
      option.addEventListener('click', (event) => {
        if (event.isTrusted) choose(skill);
      });
      selector.append(option);
    });
    selector.hidden = false;
  }
  function choose(skill) {
    if (selected.length >= 8 || selected.some((item) => item.name === skill.name)) return;
    selected.push(skill);
    draft.setRangeText('', start, draft.selectionStart, 'end');
    render();
    close();
    draft.focus();
  }
  async function querySkills(value, slashStart) {
    const request = ++generation;
    query = value;
    start = slashStart;
    if (!loaded) {
      if (!busy) {
        busy = true;
        loaded = Promise.resolve()
          .then(load)
          .then((result) => (options = result.skills || result));
      }
      try {
        await loaded;
      } catch (error) {
        if (request !== generation) return;
        loaded = null;
        selector.replaceChildren();
        const message = document.createElement('p');
        message.textContent = `Skills could not load: ${error.message}`;
        selector.append(message);
        selector.hidden = false;
        return;
      } finally {
        busy = false;
      }
    }
    if (request !== generation) return;
    active = 0;
    show();
  }
  draft.addEventListener('input', () => {
    const before = draft.value.slice(0, draft.selectionStart);
    const match = /(?:^|\s)\/([^\s/]*)$/.exec(before);
    if (!match) return close();
    const slash = before.lastIndexOf('/');
    void querySkills(match[1], slash);
  });
  draft.addEventListener('keydown', (event) => {
    if (event.key === 'Backspace' && !draft.value && selected.length && allowed) {
      event.preventDefault();
      selected.pop();
      render();
      return;
    }
    if (selector.hidden) return;
    const count = matches().length;
    if (event.key === 'ArrowDown' && count) {
      event.preventDefault();
      active = (active + 1) % count;
      show();
    } else if (event.key === 'ArrowUp' && count) {
      event.preventDefault();
      active = (active + count - 1) % count;
      show();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && count) {
      event.preventDefault();
      choose(matches()[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  return {
    skills: () => selected.map((skill) => skill.name),
    reset: () => {
      selected = [];
      render();
      close();
    },
    allow: (value) => {
      allowed = Boolean(value);
      if (!allowed) close();
    },
    canSubmit: (text) => Boolean(text.trim() || (allowed && selected.length)),
    restore: (names) => {
      selected = names.map((name) => options.find((item) => item.name === name) || { name });
      render();
      close();
    },
    render,
  };
};

/* The issue conversation is saved by the server. This view retains only unsent drafts. */
const issueChatUI = (() => {
  let current = null,
    panel = null,
    latest = null,
    api = null,
    after = null,
    openEvidence = null;
  let log, draft, mode, status, pending, toggle, body, historyButton, stop;
  let skillComposer,
    queueList,
    pause,
    cancelEdit,
    sendButton,
    editing = null,
    previousDraft = null;
  const skillDrafts = new Map();
  let sending = new Set(),
    requestKey = null,
    requestId = null;
  const stopping = new Set(),
    stopErrors = new Map();
  let viewBeforeRender = null,
    focusedBeforeRender = null,
    renderedMessages = '',
    historyComplete = false;
  const drafts = new Map(),
    messages = new Map();
  const node = (tag, text) => {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    return element;
  };
  function mount(id, data, request, refresh, inputHtml = '', openFile) {
    const slot = document.getElementById('issue-chat-slot');
    if (!slot || !id) {
      remember();
      current = null;
      panel = null;
      return;
    }
    api = request;
    after = refresh;
    openEvidence = openFile;
    latest = data;
    selectIssue(id);
    slot.replaceWith(panel);
    update(selectedConversation(data, id), inputHtml);
    restoreChatFocus();
    if (viewBeforeRender) {
      draft.setSelectionRange(...viewBeforeRender.caret);
      draft.scrollTop = viewBeforeRender.draftTop;
      draft.scrollLeft = viewBeforeRender.draftLeft;
      restoreSelection(viewBeforeRender.selection);
    }
    viewBeforeRender = null;
  }
  function selectIssue(id) {
    if (id === current) return;
    remember();
    current = id;
    editing = null;
    previousDraft = null;
    viewBeforeRender = null;
    messages.clear();
    renderedMessages = '';
    historyComplete = false;
    panel = build(id);
    requestKey = null;
    requestId = null;
  }
  function restoreChatFocus() {
    if (focusedBeforeRender?.isConnected) focusedBeforeRender.focus({ preventScroll: true });
    focusedBeforeRender = null;
  }
  function remember() {
    if (current && draft) {
      drafts.set(current, draft.value);
      skillDrafts.set(current, skillComposer.skills());
    }
  }
  function build(id) {
    const section = node('section');
    section.className = 'discussion issue-conversation';
    section.dataset.temporary = 'true';
    toggle = node('button', 'Chat');
    toggle.className = 'discussion-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'true');
    body = node('div');
    body.id = 'issue-conversation-body';
    toggle.onclick = () => {
      body.hidden = !body.hidden;
      toggle.setAttribute('aria-expanded', String(!body.hidden));
    };
    historyButton = node('button', 'Earlier messages');
    historyButton.type = 'button';
    historyButton.onclick = older;
    log = node('div');
    log.className = 'discussion-output';
    log.setAttribute('role', 'log');
    log.setAttribute('aria-label', 'Issue conversation');
    pending = node('section');
    pending.className = 'conversation-request';
    queueList = node('section');
    queueList.className = 'issue-prompt-queue';
    queueList.setAttribute('aria-label', 'Queued prompts');
    const form = node('form');
    form.className = 'discussion-compose';
    draft = node('textarea');
    draft.id = 'issue-chat-input-' + id;
    draft.setAttribute('aria-label', 'Chat input');
    draft.placeholder = 'Message this issue…';
    draft.rows = 3;
    draft.maxLength = 12000;
    draft.value = drafts.get(id) || '';
    draft.oninput = () => {
      drafts.set(id, draft.value);
      requestId = null;
    };
    const send = node('button');
    sendButton = send;
    send.type = 'submit';
    send.className = 'discussion-send';
    send.setAttribute('aria-label', 'Send message');
    send.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    form.onsubmit = (event) => {
      event.preventDefault();
      if (event.isTrusted) void submit();
    };
    draft.onkeydown = (event) => {
      if (event.isTrusted && sendKey(event)) {
        event.preventDefault();
        void submit();
      }
    };
    stop = node('button', 'Stop');
    stop.type = 'button';
    stop.setAttribute('aria-label', 'Stop response');
    stop.onclick = (event) => {
      if (event.isTrusted) void stopResponse();
    };
    pause = node('button', 'Pause');
    pause.type = 'button';
    pause.onclick = () => void queueControl({ operation: pause.dataset.operation });
    cancelEdit = node('button', 'Cancel edit');
    cancelEdit.type = 'button';
    cancelEdit.hidden = true;
    cancelEdit.onclick = finishEdit;
    const actions = node('div');
    actions.className = 'issue-composer-actions';
    actions.append(pause, stop, cancelEdit, send);
    form.append(draft, actions);
    skillComposer = createSkillComposer(form, draft, () =>
      api('issue-chat-skills?issue=' + encodeURIComponent(current))
    );
    skillComposer.restore(skillDrafts.get(id) || []);
    mode = node('select');
    mode.setAttribute('aria-label', 'Send as');
    for (const [value, label] of [
      ['comment', 'Discuss or ask about history'],
      ['work', 'Work in issue checkout'],
      ['feedback', 'Request revision'],
      ['answer', 'Reply and continue'],
    ]) {
      const option = node('option', label);
      option.value = value;
      mode.append(option);
    }
    mode.onchange = () => {
      requestId = null;
      skillComposer.allow(mode.value !== 'answer');
    };
    status = node('p');
    status.className = 'discussion-status';
    status.setAttribute('role', 'status');
    const notice = node(
      'small',
      'Send queues behind active work. Pause holds later prompts; Stop interrupts the current turn and holds the queue. Work edits the issue checkout. Merge and acceptance use their own controls.'
    );
    body.append(historyButton, log, pending, queueList, mode, form, status, notice);
    section.append(toggle, body);
    return section;
  }
  function update(conversation = {}, inputHtml) {
    const reading = viewBeforeRender?.reading || {
      top: log.scrollTop,
      follow: log.scrollHeight - log.scrollTop - log.clientHeight < 40,
    };
    mergeMessages(conversation);
    renderHistory();
    historyButton.hidden = historyComplete || !conversation.hasMore;
    renderPending(inputHtml);
    const issue = latest.issues.find((entry) => entry.id === current);
    syncReplyMode(issue.lifecycle);
    renderQueue(conversation);
    renderStop(conversation);
    if (!sending.has(current)) status.textContent = responseStatus(conversation);
    log.scrollTop = reading.follow ? log.scrollHeight : reading.top;
  }
  function renderStop(conversation) {
    const queue = conversation.queue || {};
    stop.hidden = !stopAvailable(conversation, queue);
    stop.disabled = stopping.has(current);
    stop.textContent = stop.disabled ? 'Stopping…' : 'Stop';
    bindStop(conversation, queue);
  }
  function stopAvailable(conversation, queue) {
    return Boolean(conversation.responseId || queue.activeTurn?.canStop || cancellableOperation(queue.operation));
  }
  function cancellableOperation(operation) {
    return operation?.cancellable === true;
  }
  function bindStop(conversation, queue) {
    stop.dataset.responseId = conversation.responseId || '';
    stop.dataset.turnId = queue.activeTurn ? queue.activeTurn.turnId : '';
    stop.dataset.operationId = queue.operation ? queue.operation.id : '';
  }
  function selectedConversation(data, id) {
    const page = data.conversation;
    return page?.issueId === id ? page : {};
  }
  function mergeMessages(conversation) {
    for (const entry of conversation.messages || []) messages.set(entry.id, entry);
  }
  function renderHistory() {
    const signature = JSON.stringify([...messages.values()]);
    if (signature === renderedMessages) return;
    renderedMessages = signature;
    log.replaceChildren();
    for (const entry of sortedMessages()) log.append(messageNode(entry));
    if (!messages.size) log.append(node('p', 'Messages and lifecycle results will appear here.'));
  }
  function sortedMessages() {
    return [...messages.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
  }
  function messageNode(entry) {
    const item = node('article');
    item.dataset.messageId = entry.id;
    const date = entry.at ? new Date(entry.at).toLocaleString() : 'Date not recorded';
    item.append(node('strong', entry.role || entry.actor), node('small', ' · ' + date));
    const text = node('p', entry.body);
    text.style.whiteSpace = 'pre-wrap';
    if (entry.skills?.length) {
      const tokens = node('div');
      tokens.className = 'message-skills';
      for (const name of entry.skills) {
        const token = node('span', '✦ ' + name);
        token.className = 'skill-chip';
        tokens.append(token);
      }
      item.append(tokens);
    }
    item.append(text);
    appendSources(item, entry.source);
    if (entry.status) item.append(node('small', entry.status));
    return item;
  }
  function appendSources(item, source) {
    if (!source) return;
    const links = node('div');
    links.className = 'conversation-evidence';
    for (const evidence of source.evidence || []) links.append(evidenceButton(evidence));
    appendGitHubEvidence(links, source.url);
    item.append(links);
  }
  function evidenceButton(evidence) {
    const button = node('button', evidence.label || evidence.path);
    button.type = 'button';
    button.onclick = () => {
      Promise.resolve(openEvidence?.(evidence.path)).catch((error) => {
        status.textContent = error.message;
      });
    };
    return button;
  }
  function appendGitHubEvidence(links, url = '') {
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url)) return;
    const link = node('a', 'GitHub evidence');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    links.append(link);
  }
  function renderQueue(conversation) {
    const queue = conversation.queue || { entries: [], paused: false };
    pause.dataset.operation = queue.paused ? 'resume' : 'pause';
    pause.textContent = pauseLabel(queue);
    queueList.replaceChildren();
    renderQueueEntries(queue.entries || [], queue);
  }
  function renderQueueEntries(entries, queue) {
    if (queue.operation) queueList.append(node('p', operationStatus(queue.operation)));
    for (const entry of entries) queueList.append(queuedPrompt(entry, queue));
    queueList.hidden = entries.length === 0 && !queue.operation;
  }
  function pauseLabel(queue) {
    if (queue.paused) return 'Resume';
    if (queue.operation?.kind === 'merge') return 'Pause after this operation';
    return 'Pause';
  }
  function queuedPrompt(entry, queue) {
    const item = node('article');
    item.dataset.promptId = entry.id;
    item.append(node('strong', entry.status === 'waiting' ? 'Queued' : entry.status), node('p', entry.text));
    appendQueuedSkills(item, entry.skills);
    if (entry.status !== 'waiting') return item;
    appendPromptControls(item, entry, queue.activeTurn || {});
    return item;
  }
  function appendQueuedSkills(item, skills = []) {
    if (skills.length) item.append(node('small', 'Skills: ' + skills.join(', ')));
  }
  function appendPromptControls(item, entry, activeTurn) {
    const edit = node('button', 'Edit');
    edit.type = 'button';
    edit.onclick = () => editPrompt(entry);
    const remove = node('button', 'Remove');
    remove.type = 'button';
    remove.onclick = () => void queueControl({ operation: 'remove', id: entry.id, revision: entry.revision });
    const steer = node('button', 'Steer');
    steer.type = 'button';
    steer.disabled = !activeTurn.canSteer;
    steer.title = steer.disabled ? 'No confirmed steerable turn is available.' : 'Send to this exact active turn';
    const turnId = activeTurn.turnId;
    steer.onclick = () => void queueControl({ operation: 'steer', id: entry.id, revision: entry.revision, turnId });
    item.append(edit, remove, steer);
  }
  function editPrompt(entry) {
    if (!editing) previousDraft = { text: draft.value, mode: mode.value, skills: skillComposer.skills() };
    editing = { id: entry.id, revision: entry.revision };
    draft.value = entry.text;
    mode.value = entry.mode;
    mode.disabled = true;
    skillComposer.restore(entry.skills || []);
    cancelEdit.hidden = false;
    sendButton.textContent = 'Save edit';
    sendButton.setAttribute('aria-label', 'Save queued prompt');
    draft.focus();
  }
  function finishEdit() {
    if (!editing) return;
    draft.value = previousDraft.text;
    mode.value = previousDraft.mode;
    mode.disabled = false;
    skillComposer.restore(previousDraft.skills);
    editing = null;
    previousDraft = null;
    cancelEdit.hidden = true;
    sendButton.textContent = 'Send';
    sendButton.setAttribute('aria-label', 'Send message');
    requestId = null;
  }
  async function queueControl(input) {
    const issueId = current;
    status.textContent = 'Updating the issue queue…';
    try {
      await api('issue-chat-control', { issueId, ...input });
      await after();
    } catch (error) {
      if (current === issueId) status.textContent = error.message;
    }
  }
  function showChat() {
    body.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
  }
  function renderPending(html) {
    if (pending.innerHTML === html) return;
    pending.innerHTML = html;
    if (html) showChat();
  }
  function inputType(record) {
    return record?.input?.type;
  }
  function requestIdentity(record) {
    return record?.input ? record.updated + ':' + record.input.type : '';
  }
  function syncReplyMode(record) {
    const key = requestIdentity(record);
    if (key === requestKey) return;
    requestKey = key;
    const reply = ['questions', 'scope', 'worker', 'human'].includes(inputType(record));
    mode.querySelector('[value=answer]').disabled = !reply;
    setReplyMode(reply);
    if (key) showChat();
  }
  function setReplyMode(reply) {
    if (!editing) mode.value = reply ? 'answer' : 'comment';
  }
  function sendKey(event) {
    return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
  }
  function queueStatus(queue) {
    if (queue.native) return queue.native.reason;
    if (queue.paused) return 'Paused. Your queued prompts are saved until Resume.';
    if (queue.operation) return operationStatus(queue.operation);
    return '';
  }
  function operationStatus(operation) {
    if (operation.status === 'uncertain')
      return (
        'Factory ' + operation.kind + ' has an uncertain outcome. Its owner must reconcile it before work continues.'
      );
    return 'Factory is running ' + operation.kind + '. New prompts will wait.';
  }
  function chatStatus(conversation) {
    return queueStatus(conversation.queue || {}) || turnStatus(conversation);
  }
  function turnStatus(conversation) {
    if (conversation.connected) return 'The issue assistant is responding. You can keep leaving comments.';
    if (['responding', 'attention'].includes(conversation.status))
      return 'The previous response stopped. Your messages are saved; send another message to reconnect.';
    return '';
  }
  function responseStatus(conversation) {
    const error = stopErrors.get(current);
    if (error && error.messageId === conversation.responseId) return error.text;
    stopErrors.delete(current);
    return chatStatus(conversation);
  }
  async function stopResponse() {
    const issueId = current,
      messageId = stop.dataset.responseId;
    if (stopping.has(issueId)) return;
    if (selectedConversation(latest, issueId).queue) {
      await queueControl({
        operation: 'stop',
        id: messageId,
        turnId: stop.dataset.turnId,
        operationId: stop.dataset.operationId,
      });
      return;
    }
    await stopLegacyResponse(issueId, messageId);
  }
  async function stopLegacyResponse(issueId, messageId) {
    if (!messageId) return;
    stopping.add(issueId);
    stopErrors.delete(issueId);
    stop.disabled = true;
    status.textContent = 'Stopping the current response…';
    try {
      await api('issue-chat-stop', { issueId, messageId });
      await after();
    } catch (error) {
      stopErrors.set(issueId, { messageId, text: error.message });
    } finally {
      stopping.delete(issueId);
      finishStop(issueId);
    }
  }
  function finishStop(issueId) {
    if (current !== issueId) return;
    stop.disabled = false;
    status.textContent = responseStatus(selectedConversation(latest, issueId));
  }
  async function submit() {
    if (sending.has(current) || !skillComposer.canSubmit(draft.value)) return;
    const input = composeMessage();
    sending.add(input.issueId);
    status.textContent = 'Saving your message…';
    try {
      const result = await saveComposedMessage(input);
      acceptedMessage(input, result);
      await after();
    } catch (error) {
      messageError(input, error);
    } finally {
      sending.delete(input.issueId);
    }
  }
  function saveComposedMessage(input) {
    if (editing)
      return api('issue-chat-control', { ...input, operation: 'edit', id: editing.id, revision: editing.revision });
    return api('issue-chat-send', input);
  }
  function composeMessage() {
    const record = latest.issues.find((entry) => entry.id === current).lifecycle;
    requestId ||= crypto.randomUUID();
    return {
      issueId: current,
      id: requestId,
      text: draft.value,
      mode: mode.value,
      skills: mode.value === 'answer' ? [] : skillComposer.skills(),
      updated: record?.updated,
      decision: inputType(record) === 'human' ? 'approve' : 'answer',
    };
  }
  function acceptedMessage(input, result) {
    drafts.set(input.issueId, '');
    skillDrafts.delete(input.issueId);
    if (current !== input.issueId) return;
    if (editing) {
      finishEdit();
      return;
    }
    skillComposer.reset();
    draft.value = '';
    requestId = null;
    status.textContent = result.disposition || 'Saved.';
  }
  function messageError(input, error) {
    if (current === input.issueId) status.textContent = error.message + ' Your text is still here.';
  }
  async function older() {
    historyButton.disabled = true;
    try {
      const cursor = [...messages.values()].sort(
        (a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id)
      )[0]?.id;
      const page = await api(
        'issue-chat?issue=' + encodeURIComponent(current) + '&before=' + encodeURIComponent(cursor || '')
      );
      historyComplete = !page.hasMore;
      update(page, pending.innerHTML);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      historyButton.disabled = false;
    }
  }
  function captureSelection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !log.contains(selection.anchorNode) || !log.contains(selection.focusNode))
      return null;
    const offset = (node, end) => {
      const range = document.createRange();
      range.selectNodeContents(log);
      range.setEnd(node, end);
      return range.toString().length;
    };
    return [offset(selection.anchorNode, selection.anchorOffset), offset(selection.focusNode, selection.focusOffset)];
  }
  function restoreSelection(saved) {
    if (!saved) return;
    const point = (offset) => {
      const walker = document.createTreeWalker(log, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (offset <= node.length) return [node, offset];
        offset -= node.length;
      }
      return [log, log.childNodes.length];
    };
    window.getSelection().setBaseAndExtent(...point(saved[0]), ...point(saved[1]));
  }
  function beforeRender() {
    focusedBeforeRender = panel?.contains(document.activeElement) ? document.activeElement : null;
    viewBeforeRender = panel?.isConnected
      ? {
          reading: { top: log.scrollTop, follow: log.scrollHeight - log.scrollTop - log.clientHeight < 40 },
          draftTop: draft.scrollTop,
          draftLeft: draft.scrollLeft,
          caret: [draft.selectionStart, draft.selectionEnd, draft.selectionDirection],
          selection: captureSelection(),
        }
      : null;
  }
  return { mount, beforeRender };
})();
