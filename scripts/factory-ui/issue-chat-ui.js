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
    render,
  };
};

/* The issue conversation is saved by the server. This view retains only unsent drafts. */
const issueChatUI = (() => {
  let current = null,
    panel = null,
    latest = null,
    api = null,
    after = null;
  let log, draft, mode, status, pending, toggle, body, historyButton, stop;
  let skillComposer;
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
  function mount(id, data, request, refresh, inputHtml = '') {
    const slot = document.getElementById('issue-chat-slot');
    if (!slot || !id) {
      remember();
      current = null;
      panel = null;
      return;
    }
    api = request;
    after = refresh;
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
    if (current && draft) drafts.set(current, draft.value);
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
    form.append(draft, send);
    skillComposer = createSkillComposer(form, draft, () =>
      api('issue-chat-skills?issue=' + encodeURIComponent(current))
    );
    mode = node('select');
    mode.setAttribute('aria-label', 'Send as');
    for (const [value, label] of [
      ['comment', 'Comment'],
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
      'One owning chat per issue. Comments are saved; Reply and continue resumes the selected strategy. Sol review is optional.'
    );
    body.append(historyButton, log, pending, form, stop, mode, status, notice);
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
    stop.hidden = !conversation.responseId;
    stop.disabled = stopping.has(current);
    stop.textContent = stop.disabled ? 'Stopping…' : 'Stop';
    stop.dataset.responseId = conversation.responseId || '';
    if (!sending.has(current)) status.textContent = responseStatus(conversation);
    log.scrollTop = reading.follow ? log.scrollHeight : reading.top;
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
    if (entry.status) item.append(node('small', entry.status));
    return item;
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
    mode.value = reply ? 'answer' : 'comment';
    if (key) showChat();
  }
  function sendKey(event) {
    return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
  }
  function chatStatus(conversation) {
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
    if (!messageId || stopping.has(issueId)) return;
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
      if (current === issueId) {
        stop.disabled = false;
        status.textContent = responseStatus(selectedConversation(latest, issueId));
      }
    }
  }
  async function submit() {
    if (sending.has(current) || !skillComposer.canSubmit(draft.value)) return;
    const input = composeMessage();
    sending.add(input.issueId);
    status.textContent = 'Saving your message…';
    try {
      const result = await api('issue-chat-send', input);
      acceptedMessage(input, result);
      await after();
    } catch (error) {
      messageError(input, error);
    } finally {
      sending.delete(input.issueId);
    }
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
    skillComposer.reset();
    if (current !== input.issueId) return;
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
