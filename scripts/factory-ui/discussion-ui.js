/* Temporary DOM only; never browser storage or the factory's saved activity. */
const discussionUI = (() => {
  let panel = null,
    issueId = null,
    session = null,
    generation = 0;
  let expiry = null,
    idleTimer = null,
    focused = null,
    sendRequest = null,
    pending = false;
  let removeSelection = () => {};
  const button = (label, action) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    node.addEventListener('click', (event) => {
      if (event.isTrusted) action();
    });
    return node;
  };
  function end() {
    generation++;
    clearTimeout(expiry);
    clearTimeout(idleTimer);
    removeSelection();
    focused = null;
    if (session) sendRequest('discussion-end', { issueId, session }).catch(() => {});
    if (panel?.isConnected) {
      const slot = document.createElement('div');
      slot.id = 'discussion-slot';
      panel.replaceWith(slot);
    }
    panel = null;
    session = null;
    issueId = null;
    pending = false;
  }
  function mount(id, request) {
    const target = document.getElementById('discussion-slot');
    if (id !== issueId) end();
    if (!target) {
      end();
      return;
    }
    sendRequest = request;
    issueId = id;
    if (!panel) panel = build();
    target.replaceWith(panel);
    restoreFocus();
  }
  function restoreFocus() {
    if (focused && panel.contains(focused)) focused.focus({ preventScroll: true });
  }
  function isSendKey(event) {
    return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
  }
  function selectedConversation(selection, log) {
    if (!selection || selection.isCollapsed) return false;
    return log.contains(selection.anchorNode) && log.contains(selection.focusNode);
  }
  function build() {
    const node = document.createElement('section');
    node.className = 'discussion';
    node.dataset.temporary = 'true';
    node.addEventListener('focusin', (event) => {
      focused = event.target;
    });
    const toggle = button('Chat', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
      if (open) draft.focus();
    });
    toggle.className = 'discussion-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'discussion-body');
    const body = document.createElement('div');
    body.id = 'discussion-body';
    body.hidden = true;
    const log = document.createElement('div');
    log.className = 'discussion-output';
    log.setAttribute('role', 'log');
    log.setAttribute('aria-label', 'Chat output');
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Your conversation will appear here.';
    log.append(empty);
    const form = document.createElement('form');
    form.className = 'discussion-compose';
    const draft = document.createElement('textarea');
    draft.setAttribute('aria-label', 'Chat input');
    draft.placeholder = 'Message about this issue…';
    draft.rows = 2;
    draft.maxLength = 8000;
    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'discussion-send';
    send.setAttribute('aria-label', 'Send message');
    send.title = 'Send message';
    send.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    const submit = () =>
      run(async () => {
        const text = draft.value.trim();
        if (!text) return;
        draft.value = '';
        add('You', text);
        const result = await call('turn', { text });
        add('Codex', result.text);
        draft.focus();
      });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (event.isTrusted) submit();
    });
    draft.addEventListener('keydown', (event) => {
      if (event.isTrusted && isSendKey(event)) {
        event.preventDefault();
        submit();
      }
    });
    form.append(draft, send);
    const status = document.createElement('p');
    status.className = 'discussion-status';
    status.setAttribute('role', 'status');
    const preview = document.createElement('div');
    preview.className = 'discussion-preview';
    let selected = '';
    const record = button('Record selected text…', () => review('record', selected));
    record.hidden = true;
    const onSelection = () => {
      const selection = window.getSelection();
      if (selectedConversation(selection, log)) {
        selected = selection.toString().slice(0, 8000);
        record.hidden = !selected.trim();
      }
    };
    document.addEventListener('selectionchange', onSelection);
    removeSelection = () => document.removeEventListener('selectionchange', onSelection);
    const details = document.createElement('details');
    details.className = 'discussion-info';
    const summary = document.createElement('summary');
    summary.textContent = 'Temporary chat · Enter to send, Shift+Enter for a new line';
    const notice = document.createElement('p');
    notice.textContent =
      'This factory does not save or restore the conversation. Select conversation text to record agreed output with a separate confirmation. Messages go to your configured model provider under your account’s data policies. Chat ends on navigation, reload, 15 minutes of inactivity or after one hour. Typed instructions never authorize workflow changes.';
    const idForMount = issueId,
      requestForMount = sendRequest;
    const reset = button('End chat and clear text', () => {
      end();
      mount(idForMount, requestForMount);
    });
    const grill = button('Start grilling…', () => review('grill', ''));
    details.append(summary, notice, grill, reset);
    function add(who, text) {
      empty.remove();
      const entry = document.createElement('p');
      const speaker = document.createElement('strong');
      speaker.textContent = who;
      entry.append(speaker, document.createTextNode(text));
      log.append(entry);
      log.scrollTop = log.scrollHeight;
    }
    async function call(operation, input) {
      const current = generation,
        currentIssue = issueId;
      if (!session) {
        const opened = await sendRequest('discussion-open', { issueId: currentIssue });
        if (current !== generation) {
          sendRequest('discussion-end', { issueId: currentIssue, session: opened.session }).catch(() => {});
          throw Error('Chat ended.');
        }
        session = opened.session;
        expiry = setTimeout(
          () => {
            end();
            mount(currentIssue, sendRequest);
          },
          60 * 60 * 1000
        );
      }
      const result = await sendRequest('discussion-' + operation, { issueId, session, ...input });
      if (current !== generation) throw Error('Chat ended.');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => {
          end();
          mount(currentIssue, sendRequest);
        },
        15 * 60 * 1000
      );
      return result;
    }
    async function run(work, message = 'Codex is responding…') {
      if (pending) return;
      pending = true;
      const current = generation;
      send.disabled = grill.disabled = record.disabled = true;
      status.textContent = message;
      try {
        await work();
        updateStatus(current, '');
      } catch {
        updateStatus(
          current,
          'Chat could not complete. Open Temporary chat and end it to start again. Your message has not been saved to the issue.'
        );
      } finally {
        settle(current);
      }
    }
    function updateStatus(current, text) {
      if (current === generation) status.textContent = text;
    }
    function settle(current) {
      if (current !== generation) return;
      pending = false;
      send.disabled = grill.disabled = record.disabled = false;
    }
    function review(kind, text) {
      run(async () => {
        const intent = await call('prepare', { kind, text });
        preview.replaceChildren();
        const effect = document.createElement('p');
        effect.textContent = intent.effect + ' Issue: ' + intent.issueId;
        const output = document.createElement('pre');
        output.textContent = intent.text;
        const confirm = button(kind === 'record' ? 'Record this text on the issue' : 'Start temporary grilling', () =>
          run(async () => {
            confirm.disabled = true;
            const result = await call('commit', { token: intent.token, clicked: true });
            preview.replaceChildren();
            if (result.text) add('Codex', result.text);
            if (result.recorded) {
              record.hidden = true;
              add(
                'Factory',
                'Selected text recorded. No workflow change or acceptance. Start a new chat to use the updated issue context.'
              );
            }
          })
        );
        preview.append(
          effect,
          output,
          confirm,
          button('Cancel', () => preview.replaceChildren())
        );
        confirm.focus();
      }, 'Preparing the selected action…');
    }
    body.append(log, form, status, record, preview, details);
    node.append(toggle, body);
    return node;
  }
  window.addEventListener('pagehide', end);
  window.addEventListener('offline', end);
  window.addEventListener('hashchange', end);
  return { mount, end };
})();
