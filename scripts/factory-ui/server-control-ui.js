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
      '<span data-server-count role="status"></span> <button type="button" data-server-restart>Restart server</button> <label class="actions-switch"><input type="checkbox" role="switch" data-server-toggle> <span>No new actions</span></label> <small data-server-message role="status"></small>';
    document.querySelector('header').append(element);
    return element;
  }
  function show(value, request) {
    state = value;
    const element = panel();
    if (['draining', 'restarting'].includes(state.phase)) {
      expecting = true;
      previousPid = state.pid;
    }
    element.querySelector('[data-server-count]').textContent = counts(state);
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
