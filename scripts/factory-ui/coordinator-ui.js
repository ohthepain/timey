// The coordinator view only posts explicit controls; rendering and polling are read-only.
const coordinatorUI = (() => {
  let draft = window.timeyView.read('coordinator-draft', ''),
    selected = '',
    request,
    refresh,
    currentData,
    pendingResponses = 0;
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
    mountDiscussion(data.coordinator ?? {});
    update(data);
    return true;
  }
  function mountDiscussion(state) {
    if (!state.threads) {
      document.getElementById('app').innerHTML =
        '<div class="issue-navigation-row"><a href="#/queue">← Issue queue</a></div><p role="status">Loading coordinator…</p>';
      return;
    }
    if (document.getElementById('coordinator-output')) return;
    document.getElementById('app').innerHTML =
      `<section data-view-id="coordinator"><div class="issue-navigation-row"><a href="#/queue">← Issue queue</a></div><h1>Coordinator</h1><p id="coordinator-status" role="status"></p><p id="coordinator-active"></p><p>Messages guide discussion. Use the issue’s existing controls for answers, approvals and acceptance.</p><div class="actions"><button id="coordinator-stop">Stop</button><button id="coordinator-continue">Continue</button><button id="coordinator-fresh">Start fresh</button></div><p id="coordinator-workers"></p><ul id="coordinator-waiting"></ul><label><input type="checkbox" id="coordinator-show-history"> Show archived conversations</label><label>Conversation <select id="coordinator-history" aria-label="Coordinator history"></select></label><div id="coordinator-messages" role="log" aria-label="Coordinator conversation" style="max-height:45vh;overflow:auto"></div><pre id="coordinator-output" aria-label="Coordinator live output" style="max-height:45vh;overflow:auto;white-space:pre-wrap"></pre><div id="coordinator-activity"></div><div><button id="coordinator-follow">Follow latest</button></div><label>Message<textarea id="coordinator-message" data-draft-key="coordinator-message" maxlength="12000"></textarea></label><div class="actions"><button id="coordinator-send">Send</button><button id="coordinator-steer">Steer</button></div><p id="coordinator-feedback" role="status"></p></section>`;
    const input = document.getElementById('coordinator-message');
    input.value = draft;
    window.timeyView.track(input, 'coordinator-editor');
    input.oninput = () => {
      draft = input.value;
      window.timeyView.write('coordinator-draft', draft);
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
  }
  async function submit(action) {
    const feedback = document.getElementById('coordinator-feedback');
    const responding = ['send', 'steer', 'continue'].includes(action);
    if (responding) pendingResponses++;
    update(currentData);
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
        window.timeyView.write('coordinator-draft', '');
        document.getElementById('coordinator-message').value = '';
      }
      if (action === 'fresh') selected = '';
      feedback.textContent = result.disposition || 'Saved.';
      await refresh();
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      if (responding) pendingResponses--;
      update(currentData);
    }
  }
  function update(data) {
    currentData = data;
    const state = { threads: [], workers: [], waiting: [], ...data.coordinator };
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
    const showHistory = document.getElementById('coordinator-show-history');
    showHistory.onchange = () => {
      selected = '';
      updateHistory(data, state);
    };
    const visible = showHistory.checked ? state.threads : state.threads.slice(-1);
    const history = document.getElementById('coordinator-history');
    if (!visible.some((t) => t.id === selected)) selected = visible.at(-1)?.id || '';
    const options = visible
      .map(
        (t, n) =>
          `<option value="${esc(t.id)}" ${selected === t.id ? 'selected' : ''}>${esc(t.title || 'Coordinator')}${t.id === state.threads.at(-1)?.id ? ' · current' : ' · ' + esc(new Date(t.created).toLocaleString())}</option>`
      )
      .join('');
    if (history.innerHTML !== options) history.innerHTML = options;
    const thread = state.threads.find((t) => t.id === selected);
    renderMessages(data, thread);
    renderProgress(state, thread);
  }
  function coordinatorMessage(data, message) {
    const chat = window.timeyChatProgress;
    const { progress, text, role, issueId, runId } = message;
    const related = issueId ? ' · ' + issueLink(data, issueId) : '';
    const generated = role === 'user' ? '' : ` data-ai-text data-ai-source="${esc(text)}"`;
    return `<article>${chat.milestones(progress, runId)}<strong>${esc(role)}</strong>${related}<pre${generated}>${esc(text)}</pre>${chat.commands(progress?.commands, runId + '-reply')}</article>`;
  }
  function renderMessages(data, thread) {
    const log = document.getElementById('coordinator-messages');
    const opening = log.dataset.thread !== selected;
    window.timeyView.render(
      log,
      (thread?.messages || []).map((message) => coordinatorMessage(data, message)).join(''),
      'coordinator-messages:' + selected
    );
    log.dataset.thread = selected;
    if (opening) log.scrollTop = log.scrollHeight;
  }

  function selectedCurrentThread(threads) {
    return selected === threads.at(-1)?.id;
  }
  function workingInThread(state) {
    return selectedCurrentThread(state.threads) && Boolean(!state.paused && (state.active || pendingResponses));
  }
  function renderProgress(state, thread) {
    updateOutput(thread);
    const progress = thread?.progress;
    const chat = window.timeyChatProgress;
    window.timeyView.render(
      document.getElementById('coordinator-activity'),
      chat.milestones(progress, 'coordinator-live') + chat.live(progress, workingInThread(state)),
      'coordinator-activity:' + selected
    );
  }
  function legacyText(thread) {
    return (thread?.output || [])
      .map((entry) => (entry.command ? entry.command + '\n' + entry.text : entry.text))
      .join('\n\n');
  }
  function hasSemanticProgress(thread) {
    return Boolean(thread?.progress || thread?.messages.some((message) => message.progress));
  }
  function legacyOutput(thread) {
    const output = document.getElementById('coordinator-output');
    output.hidden = hasSemanticProgress(thread);
    document.getElementById('coordinator-follow').hidden = output.hidden;
    return output.hidden ? null : output;
  }
  function updateOutput(thread) {
    const output = legacyOutput(thread);
    if (!output) return;
    const follow =
      output.dataset.thread !== selected || output.scrollHeight - output.scrollTop - output.clientHeight < 2;
    window.timeyView.text(output, legacyText(thread));
    output.dataset.thread = selected;
    if (follow) output.scrollTop = output.scrollHeight;
  }
  return { mount, update, onPage };
})();
