const serverControlUI = (() => {
  let reconnectingSince = 0;
  let state = null,
    expecting = false,
    previousPid = null,
    busy = false;
  function panel() {
    let element = document.getElementById('server-controls');
    if (element) return element;
    element = document.createElement('span');
    element.id = 'server-controls';
    element.innerHTML =
      '<span data-server-count role="status"></span> <button data-server-restart>Restart when safe</button> <button data-server-cancel hidden>Cancel restart</button> <small data-server-message role="status"></small>';
    document.querySelector('header').append(element);
    return element;
  }
  function show(value, request) {
    state = value;
    const element = panel(),
      draining = state.phase !== 'idle';
    if (draining) {
      expecting = true;
      previousPid = state.pid;
    }
    element.querySelector('[data-server-count]').textContent = counts(state);
    const restart = element.querySelector('[data-server-restart]'),
      cancel = element.querySelector('[data-server-cancel]');
    restart.disabled = unavailable();
    restart.textContent = draining ? 'Waiting to restart…' : 'Restart when safe';
    cancel.hidden = !draining;
    cancel.disabled = busy || state.phase === 'restarting';
    element.querySelector('[data-server-message]').textContent = message(state);
    restart.onclick = () => change('server-restart', request);
    cancel.onclick = () => change('server-cancel-restart', request);
  }
  function unavailable() {
    return busy || state.phase !== 'idle' || !state.supported;
  }
  function message(value) {
    if (value.phase === 'idle') return value.error || '';
    return drainMessage(value);
  }
  function drainMessage(value) {
    if (value.error) return value.error + ' Cancel restart before trying again.';
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
      await fetch('/', { cache: 'no-store' });
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
