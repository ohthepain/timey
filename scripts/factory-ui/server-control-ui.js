const serverControlUI = (() => {
  let reconnectingSince = 0;
  let state = null,
    expecting = false,
    previousPid = null,
    busy = false,
    requestedPause = null;
  function panel() {
    let element = document.getElementById('server-controls');
    if (element && !element.querySelector('[data-server-restart]')) {
      element.remove();
      element = null;
    }
    if (element) return element;
    element = document.createElement('span');
    element.id = 'server-controls';
    element.innerHTML =
      '<button type="button" data-server-count aria-haspopup="dialog" aria-expanded="false"></button> <button type="button" data-server-restart>Restart server</button> <label class="actions-switch"><input type="checkbox" role="switch" data-server-toggle> <span>No new actions</span></label> <small data-server-message role="status"></small>';
    document.querySelector('header').append(element);
    actionsDialog();
    return element;
  }
  function actionsDialog() {
    let dialog = document.getElementById('server-actions-dialog');
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'server-actions-dialog';
    dialog.setAttribute('aria-labelledby', 'server-actions-title');
    dialog.innerHTML =
      '<h2 id="server-actions-title">Action list</h2><p data-actions-empty></p><div data-server-action-list></div><button type="button" data-actions-close>Close</button>';
    document.querySelector('header').append(dialog);
    dialog.querySelector('[data-actions-close]').onclick = () => {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    };
    dialog.addEventListener('close', () =>
      panel().querySelector('[data-server-count]').setAttribute('aria-expanded', 'false')
    );
    return dialog;
  }
  function show(value, request) {
    state = value;
    const element = panel();
    if (['draining', 'restarting'].includes(state.phase)) {
      expecting = true;
      previousPid = state.pid;
    }
    const count = element.querySelector('[data-server-count]');
    count.textContent = counts(state);
    count.onclick = () => {
      const dialog = actionsDialog();
      if (!dialog.open) {
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      }
      count.setAttribute('aria-expanded', 'true');
      dialog.querySelector('[data-actions-empty]').textContent = 'Loading current actions…';
      void request('server-actions')
        .then((items) => renderActions(Array.isArray(items) ? items : [], request))
        .catch((error) => {
          dialog.querySelector('[data-actions-empty]').textContent = error.message;
        });
    };
    const toggle = element.querySelector('[data-server-toggle]');
    toggle.checked = requestedPause ?? state.phase !== 'idle';
    toggle.disabled = toggleUnavailable();
    element.querySelector('[data-server-message]').textContent = message(state);
    toggle.onchange = () => {
      requestedPause = toggle.checked;
      void change(toggle.checked ? 'server-pause' : 'server-cancel-restart', request);
    };
    const restart = element.querySelector('[data-server-restart]');
    restart.hidden = !state.supported;
    restart.disabled = restartUnavailable();
    restart.onclick = () => void change('server-restart', request);
  }
  function renderActions(items, request) {
    const dialog = actionsDialog();
    const list = dialog.querySelector('[data-server-action-list]');
    const empty = dialog.querySelector('[data-actions-empty]');
    const drafts = new Map(
      [...list.querySelectorAll('[data-steer-text]')].map((field) => [field.dataset.steerText, field.value])
    );
    list.replaceChildren();
    empty.textContent = items.length
      ? 'Current work stays on its issue. Stop cancels the current action; Pause lets it finish and prevents later work on that issue.'
      : 'No issue-linked actions are running.';
    for (const item of items) list.append(actionCard(item, request, drafts));
  }
  function actionCard(item, request, drafts) {
    const card = document.createElement('article');
    card.className = 'server-action-card';
    card.append(textNode('h3', actionTitle(item)));
    const state = textNode('p', actionStatus(item));
    state.className = 'muted';
    card.append(state, textNode('p', actionDetails(item)), actionLinks(item));
    card.append(actionControls(item, request, drafts));
    return card;
  }
  function actionTitle(item) {
    return item.title || item.kind || 'Action';
  }
  function actionStatus(item) {
    return `${item.status || 'running'} · ${item.kind || 'action'}`;
  }
  function actionDetails(item) {
    return item.details || item.summary || 'Action is running.';
  }
  function textNode(tag, text) {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  }
  function actionLinks(item) {
    const links = document.createElement('p');
    links.className = 'server-action-links';
    if (!item.issues?.length) {
      links.textContent = 'No linked issue';
      return links;
    }
    for (const issue of item.issues) {
      const link = document.createElement('a');
      link.href = `#/issue/${encodeURIComponent(issue.id)}`;
      link.textContent = `Issue: ${issue.title}`;
      links.append(link, document.createTextNode(' '));
    }
    const output = document.createElement('a');
    output.href = `#/issue/${encodeURIComponent(item.issues[0].id)}?run=${encodeURIComponent(item.id)}`;
    output.textContent = 'Action output';
    links.append(output);
    return links;
  }
  function actionControls(item, request, drafts) {
    const controls = document.createElement('div');
    controls.className = 'server-action-controls';
    const definitions = [
      ['stop', 'Stop', item.canStop, 'This action has no interruptible response.'],
      ['restart', 'Restart', item.canRestart, item.restartReason],
      ['skip', 'Skip', item.canSkip, item.skipReason],
      ['pause', 'Pause issue', item.canPause, 'No future issue work can be paused.'],
    ];
    for (const [operation, label, enabled, reason] of definitions)
      controls.append(actionButton(item, operation, label, enabled, reason, request));
    const steer = document.createElement('textarea');
    steer.dataset.steerText = item.id;
    steer.setAttribute('aria-label', `Steer ${item.title || 'action'}`);
    steer.placeholder = 'Message for the current action';
    steer.value = drafts.get(item.id) || '';
    steer.disabled = !item.canSteer;
    controls.append(steer, actionButton(item, 'steer', 'Steer', item.canSteer, '', request, steer));
    const feedback = document.createElement('small');
    feedback.setAttribute('role', 'status');
    feedback.dataset.actionFeedback = item.id;
    controls.append(feedback);
    return controls;
  }
  function actionButton(item, operation, label, enabled, reason, request, field = null) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.disabled = !enabled;
    if (!enabled) button.title = reason || `${label} is unavailable while this action is running.`;
    button.onclick = () => void operate(item, operation, field?.value || '', request, button);
    return button;
  }
  async function operate(item, operation, text, request, button) {
    const dialog = actionsDialog();
    const feedback = actionFeedback(dialog, item.id);
    button.disabled = true;
    setActionFeedback(feedback, operation === 'steer' ? 'Sending…' : `${operation} requested…`);
    try {
      await request('server-action', { runId: item.id, operation, text });
      setActionFeedback(feedback, operation === 'steer' ? 'Message sent.' : `${operation} request saved.`);
    } catch (error) {
      setActionFeedback(feedback, error.message);
    } finally {
      button.disabled = false;
    }
  }
  function actionFeedback(dialog, id) {
    return [...dialog.querySelectorAll('[data-action-feedback]')].find(
      (element) => element.dataset.actionFeedback === id
    );
  }
  function setActionFeedback(feedback, message) {
    if (feedback) feedback.textContent = message;
  }
  function toggleUnavailable() {
    return busy || state.phase === 'restarting' || !state.pauseSupported;
  }
  function restartUnavailable() {
    return busy || !state.supported || ['draining', 'restarting'].includes(state.phase);
  }
  function pausedMessage(value) {
    return value.actions ? 'Finishing current actions. New work is paused.' : 'No actions running. New work is paused.';
  }
  function message(value) {
    if (value.phase === 'idle') return value.error || '';
    if (value.phase === 'paused') return pausedMessage(value);
    return drainMessage(value);
  }
  function drainMessage(value) {
    if (value.error) return value.error + ' Turn off No new actions before trying again.';
    if (value.chats) return 'Save or end the open temporary chats before restart.';
    if (value.approvals) return 'Answer the pending permissions so current work can finish.';
    return waitMessage(value);
  }
  function waitMessage(value) {
    return value.actions || value.locks.length
      ? 'New work is paused. Finishing current actions.'
      : 'Restarting the installed UI…';
  }
  async function change(path, request) {
    if (busy) return;
    busy = true;
    let problem = null;
    show(state, request);
    try {
      const result = await request(path, {});
      if (path === 'server-cancel-restart') expecting = false;
      show(result, request);
    } catch (error) {
      problem = error.message;
    } finally {
      busy = false;
      requestedPause = null;
      show(state, request);
      showProblem(problem);
    }
  }
  function showProblem(problem) {
    if (problem) panel().querySelector('[data-server-message]').textContent = problem;
  }
  function counts(value) {
    const action = value.actions === 1 ? 'action' : 'actions';
    const chat = value.chats === 1 ? 'chat' : 'chats';
    return `${value.actions} ${action} running · ${value.chats} open ${chat}`;
  }
  async function reconnect(request) {
    if (!expecting) return false;
    beginReconnect();
    try {
      const page = await fetch('/', { cache: 'no-store' });
      if (!page.ok) throw Error('The restarted page is unavailable.');
      const current = await request('server-status');
      if (current.pid !== previousPid) {
        expecting = false;
        reconnectingSince = 0;
        show(current, request);
        panel().querySelector('[data-server-message]').textContent = 'Server restarted. Saved progress restored.';
      }
    } catch {
      /* Retry through the normal polling cycle. */
    }
    return true;
  }
  function beginReconnect() {
    reconnectingSince ||= Date.now();
    panel().querySelector('[data-server-message]').textContent = reconnectMessage();
  }
  function reconnectMessage() {
    return Date.now() - reconnectingSince > 30000
      ? 'The server has not returned yet. Check .issues/factory-ui/server-restart.log in the project.'
      : 'Restarting. Your saved work is kept.';
  }
  return { show, reconnect };
})();
