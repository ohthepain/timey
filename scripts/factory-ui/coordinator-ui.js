// The coordinator view only posts explicit controls; rendering and polling are read-only.
const coordinatorUI = (() => {
  let draft = '',
    selected = '',
    request,
    refresh,
    currentData;
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  const onPage = () => location.hash.split('?')[0] === '#/coordinator';
  function issueLink(data, id) {
    if (!id) return 'Queue';
    const title = data.issues.find((i) => i.id === id)?.title || id;
    return `<a href="#/issue/${encodeURIComponent(id)}">${esc(title)}</a>`;
  }
  function mount(data, api, reload) {
    request = api;
    refresh = reload;
    if (!onPage()) return false;
    if (document.getElementById('coordinator-output')) {
      update(data);
      return true;
    }
    document.getElementById('app').innerHTML =
      `<section data-view-id="coordinator"><h1>Coordinator</h1><p id="coordinator-status" role="status"></p><p id="coordinator-active"></p><p>Messages guide discussion. Use the issue’s existing controls for answers, approvals and acceptance.</p><div class="actions"><button id="coordinator-stop">Stop</button><button id="coordinator-continue">Continue</button><button id="coordinator-fresh">Start fresh</button></div><p id="coordinator-workers"></p><ul id="coordinator-waiting"></ul><label>Conversation <select id="coordinator-history" aria-label="Coordinator history"></select></label><div id="coordinator-messages"></div><pre id="coordinator-output" aria-label="Coordinator live output" style="max-height:45vh;overflow:auto;white-space:pre-wrap"></pre><div><button id="coordinator-follow">Follow latest</button></div><label>Message<textarea id="coordinator-message" data-draft-key="coordinator-message" maxlength="12000"></textarea></label><div class="actions"><button id="coordinator-send">Send</button><button id="coordinator-steer">Steer</button></div><p id="coordinator-feedback" role="status"></p></section>`;
    const input = document.getElementById('coordinator-message');
    input.value = draft;
    input.oninput = () => {
      draft = input.value;
    };
    document.getElementById('coordinator-history').onchange = (event) => {
      selected = event.target.value;
      update(currentData);
    };
    document.getElementById('coordinator-follow').onclick = () => {
      const output = document.getElementById('coordinator-output');
      output.scrollTop = output.scrollHeight;
    };
    for (const action of ['stop', 'continue', 'fresh', 'send', 'steer'])
      document.getElementById('coordinator-' + action).onclick = () => submit(action);
    update(data);
    return true;
  }
  async function submit(action) {
    const feedback = document.getElementById('coordinator-feedback');
    try {
      const value = ['send', 'steer'].includes(action)
        ? {
            id: crypto.randomUUID(),
            mode: action,
            text: draft,
            turnId: document.getElementById('coordinator-steer').dataset.turnId,
          }
        : {};
      const result = await request('coordinator-' + (action === 'steer' ? 'send' : action), value);
      if (['send', 'steer'].includes(action)) {
        draft = '';
        document.getElementById('coordinator-message').value = '';
      }
      if (action === 'fresh') selected = '';
      feedback.textContent = result.disposition || 'Saved.';
      await refresh();
    } catch (error) {
      feedback.textContent = error.message;
    }
  }
  function update(data) {
    currentData = data;
    const state = data.coordinator || { threads: [], workers: [], waiting: [] };
    updateStrip(data, state);
    if (!onPage() || !document.getElementById('coordinator-status')) return;
    updateControls(data, state);
    updateHistory(data, state);
  }
  function updateStrip(data, state) {
    const strip = document.getElementById('coordinator-strip');
    const issueId = location.hash.startsWith('#/issue/')
      ? decodeURIComponent(location.hash.split('/')[2].split('?')[0])
      : null;
    const visible = state.active && (!issueId || state.active.issueId === issueId) && !onPage();
    strip.hidden = !visible;
    strip.innerHTML = visible
      ? `${issueLink(data, state.active.issueId)} · ${esc(state.active.operation)} · <a href="#/coordinator">View coordinator</a>`
      : '';
  }
  function updateControls(data, state) {
    document.getElementById('coordinator-status').textContent = state.paused
      ? state.reason || 'Coordination is paused.'
      : state.active
        ? state.active.operation
        : 'Idle';
    document.getElementById('coordinator-active').innerHTML = state.active ? issueLink(data, state.active.issueId) : '';
    document.getElementById('coordinator-stop').disabled = state.paused;
    document.getElementById('coordinator-continue').disabled = !state.paused;
    document.getElementById('coordinator-fresh').disabled = Boolean(
      state.active || state.interrupted || state.waiting.length
    );
    const steer = document.getElementById('coordinator-steer');
    steer.disabled = !state.active?.turnId || state.paused;
    steer.dataset.turnId = state.active?.turnId || '';
    document.getElementById('coordinator-workers').textContent = state.workers.length
      ? `${state.workers.length} ${state.workers.length === 1 ? 'worker is' : 'workers are'} still running. Stop does not stop them.`
      : 'No workers are running.';
    document.getElementById('coordinator-waiting').innerHTML = state.waiting
      .map((entry) => `<li>${issueLink(data, entry.issueId)}: ${esc(entry.reason)}</li>`)
      .join('');
  }
  function updateHistory(data, state) {
    const history = document.getElementById('coordinator-history');
    if (!state.threads.some((t) => t.id === selected)) selected = state.threads.at(-1)?.id || '';
    const options = state.threads
      .map(
        (t, n) =>
          `<option value="${esc(t.id)}" ${selected === t.id ? 'selected' : ''}>Conversation ${n + 1}${n === state.threads.length - 1 ? ' · current' : ''}</option>`
      )
      .join('');
    if (history.innerHTML !== options) history.innerHTML = options;
    const thread = state.threads.find((t) => t.id === selected);
    document.getElementById('coordinator-messages').innerHTML = (thread?.messages || [])
      .map(
        (m) =>
          `<article><strong>${esc(m.role)}</strong>${m.issueId ? ' · ' + issueLink(data, m.issueId) : ''}<pre>${esc(m.text)}</pre></article>`
      )
      .join('');
    updateOutput(thread);
  }
  function updateOutput(thread) {
    const output = document.getElementById('coordinator-output');
    const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 30;
    const text = (thread?.output || [])
      .map((entry) => (entry.command ? entry.command + '\n' + entry.text : entry.text))
      .join('\n\n');
    if (output.textContent !== text) output.textContent = text;
    if (follow) output.scrollTop = output.scrollHeight;
  }
  return { mount, update, onPage };
})();
