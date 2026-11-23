(() => {
  const button = document.getElementById('github-calls-button');
  const panel = document.getElementById('github-calls');
  const total = document.getElementById('github-call-total');
  const failed = document.getElementById('github-call-failed');
  const list = document.getElementById('github-calls-list');
  const message = document.getElementById('github-calls-message');
  const reset = document.getElementById('github-calls-reset');
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  let loading;
  let resetting = false;
  let previousCalls;

  function element(tag, value, className) {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  }

  function callRow(call, expanded) {
    const row = element('li', '');
    row.dataset.callId = call.id;
    row.append(element('strong', call.operation));
    const time = new Date(call.startedAt);
    const duration = call.durationMs == null ? '' : ' · ' + formatDuration(call.durationMs);
    row.append(element('p', [call.repository, date.format(time)].filter(Boolean).join(' · ') + duration));
    const result = element('span', call.result, call.error ? 'github-call-failed' : undefined);
    if (!call.error) {
      row.append(result);
      return row;
    }
    const details = element('details', '');
    details.open = expanded;
    const summary = element('summary', '');
    summary.append(result);
    details.append(summary, element('p', call.error));
    row.append(details);
    return row;
  }

  function formatDuration(ms) {
    if (ms >= 1000) return (ms / 1000).toFixed(2) + ' s';
    return Math.max(0, Math.round(ms)) + ' ms';
  }

  function render(data) {
    if (data.unavailable) return unavailable();
    total.textContent = data.total.toLocaleString();
    failed.textContent = '(' + data.failed.toLocaleString() + ')';
    failed.hidden = data.failed === 0;
    button.setAttribute('aria-label', `GitHub API calls: ${data.total} total, ${data.failed} failed`);
    reset.disabled = data.total === 0;
    renderCalls(data.calls);
  }

  function renderCalls(calls) {
    message.textContent = calls.length ? '' : 'No GitHub API calls yet.';
    message.hidden = calls.length > 0;
    const serialized = JSON.stringify(calls);
    if (previousCalls === serialized) return;
    previousCalls = serialized;
    const expanded = new Set(
      Array.from(list.querySelectorAll('details[open]'), (details) => details.closest('li').dataset.callId)
    );
    const focus = document.activeElement.closest('#github-calls-list li')?.dataset.callId;
    list.replaceChildren(...calls.map((call) => callRow(call, expanded.has(String(call.id)))));
    restoreFocus(focus);
  }

  function restoreFocus(callId) {
    if (callId) list.querySelector(`[data-call-id="${callId}"] summary`)?.focus({ preventScroll: true });
  }

  async function request(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) throw Error();
    return response.json();
  }

  function unavailable() {
    reset.disabled = true;
    message.textContent = 'GitHub call history is unavailable.';
    message.hidden = false;
  }

  function load() {
    if (loading || resetting) return;
    const controller = new AbortController();
    loading = controller;
    void request('/api/github-calls', { signal: controller.signal })
      .then(
        (data) => renderCurrent(controller, () => render(data)),
        () => renderCurrent(controller, unavailable)
      )
      .finally(() => {
        loading = undefined;
      });
  }

  function renderCurrent(controller, callback) {
    if (!controller.signal.aborted) callback();
  }

  reset.addEventListener('click', () => {
    if (resetting) return;
    if (window.confirm('Reset GitHub API call history and counts for this Timey installation?')) void resetHistory();
  });

  async function resetHistory() {
    resetting = true;
    loading?.abort();
    reset.disabled = true;
    try {
      const data = await request('/api/github-calls-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-factory-action': 'manual' },
        body: '{}',
      });
      render(data);
      button.focus();
    } catch {
      message.textContent = 'Could not reset GitHub call history.';
      message.hidden = false;
    } finally {
      resetting = false;
    }
  }

  function position() {
    const bounds = button.getBoundingClientRect();
    panel.style.setProperty('--github-calls-top', bounds.bottom + 5 + 'px');
    panel.style.setProperty('--github-calls-left', Math.min(bounds.left, Math.max(8, innerWidth - 428)) + 'px');
  }

  panel.addEventListener('beforetoggle', (event) => {
    if (event.newState === 'open') {
      position();
      void load();
    }
  });
  window.addEventListener('resize', position);
  setInterval(() => {
    if (!document.hidden) void load();
  }, 2000);
  void load();
})();
