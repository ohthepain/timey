/* The issue conversation is saved by the server. This view retains only unsent drafts. */
const issueChatUI = (() => {
  let current = null,
    panel = null,
    latest = null,
    api = null,
    after = null;
  let log, draft, mode, status, pending, toggle, body, historyButton, stop;
  let sending = new Set(),
    requestKey = null,
    requestId = null;
  const stopping = new Set(),
    stopErrors = new Map();
  let focusedBeforeRender = null,
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
    const slot = document.getElementById('discussion-slot');
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
  }
  function selectIssue(id) {
    if (id === current) return;
    remember();
    current = id;
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
    };
    status = node('p');
    status.className = 'discussion-status';
    status.setAttribute('role', 'status');
    const notice = node(
      'small',
      'Saved on this issue. Roles share its history; implementation and independent review keep separate execution contexts.'
    );
    body.append(historyButton, log, pending, form, stop, mode, status, notice);
    section.append(toggle, body);
    return section;
  }
  function update(conversation = {}, inputHtml) {
    const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
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
    if (!sending.has(current)) status.textContent = stopErrors.get(current) || chatStatus(conversation);
    if (follow) log.scrollTop = log.scrollHeight;
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
      stopErrors.set(issueId, error.message);
    } finally {
      stopping.delete(issueId);
      if (current === issueId) {
        stop.disabled = false;
        status.textContent = stopErrors.get(issueId) || 'Stop requested. Waiting for the response to finish.';
      }
    }
  }
  async function submit() {
    if (sending.has(current) || !draft.value.trim()) return;
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
      updated: record?.updated,
      decision: inputType(record) === 'human' ? 'approve' : 'answer',
    };
  }
  function acceptedMessage(input, result) {
    drafts.set(input.issueId, '');
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
  function beforeRender() {
    focusedBeforeRender = panel?.contains(document.activeElement) ? document.activeElement : null;
  }
  return { mount, beforeRender };
})();
