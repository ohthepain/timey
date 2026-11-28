(() => {
  const panel = document.getElementById('diagnostics-panel');
  const trigger = document.getElementById('diagnostics-trigger');
  const view = document.getElementById('diagnostics-view');
  const refresh = document.getElementById('diagnostics-refresh');
  const reset = document.getElementById('diagnostics-reset');
  const total = document.getElementById('codex-call-total');
  let resetting = false;
  let generation = 0;
  const quota = document.getElementById('diagnostics-quota');
  const content = document.getElementById('diagnostics-content');
  const number = new Intl.NumberFormat();
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  let activity;
  let quotaRequest;
  let quotaGeneration = 0;
  let activityRequest;

  function node(tag, value = '', className = '') {
    const element = document.createElement(tag);
    element.textContent = value;
    element.className = className;
    return element;
  }

  function time(ms) {
    return ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : Math.round(ms) + ' ms';
  }

  async function get(url) {
    const response = await fetch(url);
    if (!response.ok) throw Error();
    return response.json();
  }

  function row(title, ...lines) {
    const item = node('li', '', 'diagnostics-row');
    item.append(node('strong', title), ...lines.filter(Boolean).map((line) => node('p', line)));
    return item;
  }

  function renderRows(rows, empty, prefix) {
    const list = node('ol', '', 'diagnostics-list');
    list.append(...rows);
    content.replaceChildren(node('p', prefix), rows.length ? list : node('p', empty));
  }

  function tokens(usage) {
    const fields = [
      ['inputTokens', 'input'],
      ['cachedInputTokens', 'cached input'],
      ['outputTokens', 'output'],
      ['reasoningOutputTokens', 'reasoning output'],
    ];
    const values = fields.filter(([key]) => Number.isFinite(usage?.[key]));
    return (
      values.map(([key, label]) => number.format(usage[key]) + ' ' + label).join(' · ') || 'Token usage unavailable'
    );
  }

  function scope(row) {
    return [row.project, row.issueId, row.step].filter(Boolean).join(' / ');
  }

  function timing(entry) {
    return [entry.status, time(entry.durationMs), date.format(entry.startedAt)].join(' · ');
  }

  function turnRow(entry) {
    const first = Number.isFinite(entry.firstOutputMs) ? time(entry.firstOutputMs) + ' to first output' : '';
    return row(
      scope(entry) || 'Codex turn',
      [entry.model, timing(entry), first].filter(Boolean).join(' · '),
      tokens(entry.usage),
      entry.dispatchRetries ? entry.dispatchRetries + ' dispatch retries (active writer)' : ''
    );
  }

  function rollup(turns) {
    const totals = {};
    let reported = 0;
    for (const { usage } of turns) {
      if (!usage || !Object.values(usage).some(Number.isFinite)) continue;
      reported++;
      for (const [key, count] of Object.entries(usage)) {
        if (Number.isFinite(count)) totals[key] = (totals[key] ?? 0) + count;
      }
    }
    const label = number.format(turns.length) + ' turns · ' + number.format(reported) + ' with token reports';
    return [label, tokens(totals)];
  }

  function group(rows, key) {
    return Array.from(Map.groupBy(rows, key), ([label, entries]) => ({ label, entries }));
  }

  function issueRows(turns) {
    return group(turns, (turn) => [turn.project, turn.issueId || 'No issue'].filter(Boolean).join(' / '))
      .map((group) => ({
        ...group,
        input: group.entries.reduce((total, turn) => total + (turn.usage?.inputTokens ?? 0), 0),
      }))
      .sort((a, b) => b.input - a.input)
      .map(({ label, entries }) => row(label, ...rollup(entries)));
  }

  function attemptRows(turns) {
    const blocks = group(
      turns.filter((turn) => turn.blockId),
      (turn) => JSON.stringify([turn.project, turn.issueId, turn.blockId])
    );
    return blocks
      .map(({ entries }) => ({ entries, attempts: new Set(entries.map(({ attemptId }) => attemptId)).size }))
      .filter(({ attempts }) => attempts > 1)
      .map(({ entries, attempts }) => {
        const identical = entries.length - new Set(entries.map(({ inputFingerprint }) => inputFingerprint)).size;
        return row(
          scope(entries[0]),
          attempts + ' attempts · ' + identical + ' repeated submissions',
          ...rollup(entries)
        );
      });
  }

  function repeatedInputs(turns) {
    const inputs = turns.flatMap((turn) => (turn.inputParts ?? []).map((part) => ({ turn, part })));
    return group(inputs, ({ turn, part }) =>
      JSON.stringify([turn.project, turn.issueId, turn.blockId ?? turn.threadId, part.hash])
    )
      .filter(({ entries }) => entries.length > 1)
      .map(({ entries }) => {
        const { turn, part } = entries[0];
        return row(
          part.kind + ' repeated',
          scope(turn) || 'Codex conversation',
          number.format(entries.length) + ' occurrences · ' + number.format(part.bytes) + ' bytes each'
        );
      });
  }

  function repeatedChecks(rows) {
    const executed = rows.filter(
      (entry) => entry.category === 'verification' && entry.candidate && !entry.phase && entry.status !== 'Reused'
    );
    return group(executed, (entry) => JSON.stringify([entry.project, entry.operation, entry.candidate]))
      .filter(({ entries }) => entries.length > 1)
      .map(({ entries }) =>
        row(
          entries[0].operation + ' rerun',
          scope(entries[0]),
          entries.length + ' runs with the same verification inputs'
        )
      );
  }

  function operationRow(entry) {
    return row(entry.operation, [scope(entry), entry.store].filter(Boolean).join(' · '), timing(entry));
  }

  function storeSummary(stores) {
    return Object.entries(stores || {}).map(([project, counts]) =>
      row(
        project,
        number.format(counts['Cached views'] ?? 0) +
          ' cached views · ' +
          number.format(counts['Joined refreshes'] ?? 0) +
          ' joined refreshes since server start'
      )
    );
  }

  function display() {
    if (!activity) return;
    if (activity.unavailable) return content.replaceChildren(node('p', 'Activity history is unavailable.'));
    const turns = activity.rows.filter((entry) => entry.category === 'codex');
    const retained = 'Up to ' + activity.retained + ' records per activity type.';
    switch (view.value) {
      case 'issues':
        return renderRows(issueRows(turns), 'No Codex turns recorded yet.', retained);
      case 'repeats':
        return renderRows(
          [...attemptRows(turns), ...repeatedInputs(turns), ...repeatedChecks(activity.rows)],
          'No repeated work found in this history.',
          'Repeated work can be necessary. Cached input is shown separately where reported.'
        );
      case 'stores':
        return renderRows(
          [
            ...storeSummary(activity.stores),
            ...activity.rows.filter((entry) => entry.category === 'stores').map(operationRow),
          ],
          'No shared-store activity recorded yet.',
          retained
        );
      case 'git':
        return renderRows(
          activity.rows.filter((entry) => ['git', 'verification'].includes(entry.category)).map(operationRow),
          'No Git or verification activity recorded yet.',
          retained
        );
      default:
        return renderRows(turns.map(turnRow), 'No Codex turns recorded yet.', retained);
    }
  }

  const quotaMessages = {
    disabled: 'OpenAI is disabled in Factory settings.',
    'api-key': 'Codex is using an API key. Check API organization and project limits in the OpenAI platform.',
    'no-chatgpt-account': 'Sign in to Codex with ChatGPT to see plan usage.',
    unavailable: 'Could not read Codex plan usage. Try refreshing.',
  };

  function showQuota(data) {
    const section = node('section', '', 'diagnostics-quota');
    section.append(node('h3', ['Codex plan usage', data.plan].filter(Boolean).join(' · ')));
    if (data.status !== 'available') {
      section.append(node('p', quotaMessages[data.status] || 'Plan usage is unavailable.'));
    } else {
      section.append(...data.limits.flatMap(({ windows, label }) => windows.map((limit) => quotaWindow(label, limit))));
      if (data.limits.length === 0) section.append(node('p', 'Codex did not report a usage window.'));
    }
    if (data.checkedAt) section.append(node('p', 'Checked ' + date.format(data.checkedAt)));
    quota.replaceChildren(section);
  }

  function quotaWindow(label, limit) {
    const windowName = limit.durationMinutes ? ' · ' + windowDuration(limit.durationMinutes) + ' window' : '';
    const description = label + windowName + ' · ' + number.format(limit.remainingPercent) + '% left';
    const reset = limit.resetsAt ? ' · resets ' + date.format(limit.resetsAt * 1000) : '';
    const meter = node('progress');
    meter.max = 100;
    meter.value = limit.remainingPercent;
    meter.setAttribute('aria-label', description);
    meter.classList.toggle('diagnostics-low', meter.value <= 15);
    const result = node('div');
    result.append(node('p', description + reset), meter);
    return result;
  }

  function windowDuration(minutes) {
    if (minutes % 1440 === 0) return minutes / 1440 + ' day';
    if (minutes % 60 === 0) return minutes / 60 + ' hour';
    return minutes + ' minute';
  }

  async function loadActivity() {
    if (activityRequest || resetting) return;
    const current = generation;
    activityRequest = true;
    try {
      const data = await get('/api/diagnostic-activity');
      if (current === generation) showActivity(data);
    } catch {
      if (current === generation) showActivity({ unavailable: true });
    } finally {
      activityRequest = false;
    }
    display();
  }

  async function loadQuota(force = false) {
    if (quotaRequest) return;
    const current = quotaGeneration;
    quotaRequest = true;
    refresh.disabled = true;
    if (!quota.childElementCount) quota.replaceChildren(node('p', 'Checking Codex plan usage…'));
    try {
      const data = await get('/api/codex-quota' + (force ? '?refresh=1' : '')).catch(() => ({
        status: 'unavailable',
      }));
      if (current === quotaGeneration) showQuota(data);
    } finally {
      quotaRequest = false;
      refresh.disabled = false;
    }
  }

  function showActivity(data) {
    activity = data;
    if (!data.unavailable) {
      total.textContent = number.format(data.codexTotal);
      trigger.setAttribute('aria-label', 'Codex API requests: ' + data.codexTotal + ' recorded turns');
    }
    reset.disabled = data.unavailable || data.codexTotal === 0;
    display();
  }

  function position() {
    const bounds = trigger.getBoundingClientRect();
    panel.style.setProperty('--diagnostics-top', bounds.bottom + 5 + 'px');
    panel.style.setProperty('--diagnostics-left', Math.min(bounds.left, Math.max(8, innerWidth - 428)) + 'px');
  }

  panel.addEventListener('beforetoggle', (event) => {
    if (event.newState === 'open') {
      position();
      void loadActivity();
      void loadQuota();
    }
  });
  window.addEventListener('factory-provider-settings-saved', (event) => {
    const codex = event.detail?.find(({ id }) => id === 'codex');
    if (codex?.active !== false) return;
    quotaGeneration++;
    showQuota({ status: 'disabled' });
  });
  window.addEventListener('resize', position);
  reset.addEventListener('click', async () => {
    if (resetting) return;
    if (!window.confirm('Reset Codex request history and count for this Timey installation?')) return;
    resetting = true;
    generation++;
    reset.disabled = true;
    try {
      const response = await fetch('/api/codex-activity-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-factory-action': 'manual' },
        body: '{}',
      });
      if (!response.ok) throw Error();
      showActivity(await response.json());
    } catch {
      content.replaceChildren(node('p', 'Could not reset Codex request history.'));
      reset.disabled = false;
    } finally {
      resetting = false;
    }
  });
  view.addEventListener('change', display);
  refresh.addEventListener('click', () => {
    void loadActivity();
    void loadQuota(true);
  });
  setInterval(() => {
    if (!document.hidden) void loadActivity();
  }, 4000);
  void loadActivity();
})();
