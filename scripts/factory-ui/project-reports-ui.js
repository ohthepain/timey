(() => {
  'use strict';
  const escape = window.timeyEscapeHTML;
  const template = (id, values) =>
    document.getElementById(id).innerHTML.replace(/{{(\w+)}}/g, (_match, key) => values[key]);
  function createdIssuesMarkup(issues) {
    if (!issues.length) return '';
    const links = issues
      .map(({ id, title }) => `<li><a href="/?issue=${encodeURIComponent(id)}">${escape(title)}</a></li>`)
      .join('');
    return `<section aria-label="Created issues"><h2>Created issues</h2><ul>${links}</ul></section>`;
  }
  function htmlReport(report) {
    const doc = new DOMParser().parseFromString(report.content, 'text/html');
    const policy = doc.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = `default-src 'none'; style-src 'unsafe-inline'; img-src ${location.origin}/api/report-evidence; base-uri 'none'; form-action 'none'`;
    doc.head.prepend(policy);
    const evidence = new Map(report.evidence.map((item, index) => [item.original, { ...item, index }]));
    for (const link of doc.querySelectorAll('a[href], img[src]')) {
      const attribute = link.tagName === 'A' ? 'href' : 'src';
      const path = link.getAttribute(attribute);
      if (path.startsWith('#')) continue;
      const item = evidence.get(path);
      if (item?.status === 'verified') {
        link.setAttribute(
          attribute,
          `${location.origin}/api/report-evidence?report=${encodeURIComponent(report.id)}&item=${item.index}`
        );
      } else if (item || !/^[a-z][a-z0-9+.-]*:/i.test(path)) {
        link.replaceWith(
          doc.createTextNode(
            `${link.textContent || link.getAttribute('alt') || 'Evidence'} [evidence ${item?.status || 'unavailable'}]`
          )
        );
        continue;
      }
      if (link.tagName === 'A') {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
    }
    return `<iframe class="report-document" title="${escape(report.title)}" sandbox="allow-same-origin allow-popups" srcdoc="${escape('<!DOCTYPE html>\n' + doc.documentElement.outerHTML)}"></iframe>`;
  }
  window.createProjectReportsUI = ({ request, post }) => {
    const root = document.getElementById('project-reports');
    let visible = false,
      selected = null,
      chat = null,
      generation = 0;
    const states = new Map();
    const savedKey = (id) => 'timey-report-reader:' + location.host + ':' + id;
    function state(id) {
      if (!states.has(id)) {
        let saved;
        try {
          saved = JSON.parse(localStorage.getItem(savedKey(id)));
        } catch {
          /* Browser state is optional. */
        }
        states.set(id, { scroll: 0, discuss: false, split: 60, draft: '', ...saved });
      }
      return states.get(id);
    }
    function remember() {
      if (!selected) return;
      const value = state(selected.id);
      value.scroll = root.querySelector('.report-reading').scrollTop;
      if (chat) value.draft = chat.draft();
      try {
        localStorage.setItem(savedKey(selected.id), JSON.stringify(value));
      } catch {
        /* Keep the in-memory state. */
      }
    }
    function url(id) {
      if (!visible) return;
      const next = new URL(location.href);
      if (id) next.searchParams.set('report', id);
      else next.searchParams.delete('report');
      history.replaceState(history.state, '', next);
    }
    function error(failure) {
      const node = root.querySelector('[data-report-error]');
      if (node) node.textContent = failure.message;
    }
    function missingLocalEvidence(path) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(path)) return null;
      return { status: 'unavailable' };
    }
    function retainedLinks(report) {
      const evidence = new Map(report.evidence.map((item, index) => [item.original, { ...item, index }]));
      return report.content.replace(/(!?\[[^\]]*\])\(([^)]+)\)/g, (match, label, path) => {
        const item = evidence.get(path) ?? missingLocalEvidence(path);
        if (!item) return match;
        if (item.status !== 'verified') return label.replace(/^!?\[|\]$/g, '') + ' [evidence ' + item.status + ']';
        return label + '(/api/report-evidence?report=' + encodeURIComponent(report.id) + '&item=' + item.index + ')';
      });
    }
    function closeChat() {
      remember();
      chat?.destroy();
      chat = null;
    }
    async function list() {
      const current = ++generation;
      closeChat();
      selected = null;
      url(null);
      const result = await request('/api/investigation-reports');
      if (current !== generation) return;
      root.innerHTML = template('report-library-template', {
        controls: result.reports.length ? '' : 'hidden',
        items:
          result.reports
            .map((report) =>
              template('report-library-item-template', {
                id: escape(report.id),
                title: escape(report.title),
                publishedAt: escape(new Date(report.publishedAt).toLocaleString()),
              })
            )
            .join('') || '<p class="muted">No reports have been published yet.</p>',
      });
    }
    async function open(id) {
      const current = ++generation;
      closeChat();
      const result = await request('/api/investigation-reports?report=' + encodeURIComponent(id));
      if (current !== generation) return;
      selected = result.report;
      const report = selected;
      const saved = state(id);
      url(id);
      const runs = reportRuns(result.reports, id);
      renderReport(report, saved, runs, result.createdIssues);
      const reading = root.querySelector('.report-reading');
      reading.scrollTop = saved.scroll;
      reading.addEventListener('scroll', remember, { passive: true });
      root
        .querySelector('[data-report-run]')
        .addEventListener('change', (event) => void open(event.target.value).catch(error));
      bindDivider(saved);
      if (saved.discuss) await showDiscussion(true);
      else layoutDiscussion(false);
    }
    function renderReport(report, saved, runs, createdIssues) {
      const run = runs.get(report.source.attemptId);
      root.innerHTML = template('report-reader-template', {
        investigationHref: '/?issue=' + encodeURIComponent(report.source.issueId),
        runs: [...runs.entries()]
          .map(
            ([runId, entry]) =>
              `<option value="${escape(entry.id)}"${runId === report.source.attemptId ? ' selected' : ''}>Run ${entry.number} · ${escape(new Date(entry.date).toLocaleString())}</option>`
          )
          .join(''),
        discussLabel: saved.discuss ? 'Hide discussion' : 'Discuss',
        publishedAt: escape(new Date(report.publishedAt).toLocaleString()),
        runNumber: run.number,
        title: escape(report.title),
        revision: escape(report.source.revision),
        content: /^\s*<!doctype html\b/i.test(report.content)
          ? htmlReport(report)
          : window.timeyChatMarkdown(retainedLinks(report)),
        createdIssues: createdIssuesMarkup(createdIssues),
        evidence:
          report.evidence.map((item, index) => evidenceMarkup(item, index, report.id)).join('') ||
          '<p class="muted">No separate evidence files were saved.</p>',
      });
      const frame = root.querySelector('.report-document');
      if (frame) {
        root.querySelector('.report-reading').classList.add('report-reading-html');
        frame.addEventListener('load', () => {
          frame.contentWindow.scrollTo(0, saved.htmlScroll || 0);
          frame.contentWindow.addEventListener(
            'scroll',
            () => {
              saved.htmlScroll = frame.contentWindow.scrollY;
              remember();
            },
            { passive: true }
          );
        });
      }
    }
    function evidenceMarkup(item, index, id) {
      const path = '/api/report-evidence?report=' + encodeURIComponent(id) + '&item=' + index;
      const link =
        item.status === 'verified'
          ? `<a target="_blank" rel="noopener" href="${path}">Open retained copy</a>
             <button type="button" class="small-button" data-report-copy-evidence>Copy link</button>
             <span role="status" data-report-copy-status></span>`
          : escape(item.reason || '');
      return `<p><strong>${escape(item.name)}</strong> <span data-evidence-status="${escape(item.status)}">${escape(item.status)}</span> ${link}</p>`;
    }
    async function copyEvidenceLink(button) {
      const row = button.parentElement;
      const status = row.querySelector('[data-report-copy-status]');
      status.textContent = '';
      await navigator.clipboard.writeText(row.querySelector('a').href);
      status.textContent = 'Link copied.';
    }
    function reportRuns(reports, id) {
      const runs = new Map();
      for (const entry of [...reports].sort((a, b) =>
        String(a.source.startedAt).localeCompare(String(b.source.startedAt))
      )) {
        const run = runs.get(entry.source.attemptId);
        if (!run)
          runs.set(entry.source.attemptId, { id: entry.id, date: entry.source.startedAt, number: runs.size + 1 });
        if (entry.id === id) runs.get(entry.source.attemptId).id = id;
      }
      return runs;
    }
    function bindDivider(saved) {
      const divider = root.querySelector('.report-divider');
      function resize(value) {
        const workspace = root.querySelector('.report-workspace');
        const maximum = Math.max(20, Math.min(80, ((workspace.clientHeight - 250) / workspace.clientHeight) * 100));
        saved.split = Math.max(20, Math.min(maximum, value));
        workspace.style.setProperty('--report-split', saved.split + '%');
        divider.setAttribute('aria-valuenow', String(Math.round(saved.split)));
        remember();
      }
      divider.addEventListener('keydown', (event) => {
        const values = { ArrowUp: saved.split - 5, ArrowDown: saved.split + 5, Home: 20, End: 80 };
        if (!(event.key in values)) return;
        event.preventDefault();
        resize(values[event.key]);
      });
      divider.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        divider.setPointerCapture(event.pointerId);
        const move = (pointer) => {
          const box = root.querySelector('.report-workspace').getBoundingClientRect();
          resize(((pointer.clientY - box.top) / box.height) * 100);
        };
        const end = () => {
          divider.removeEventListener('pointermove', move);
          divider.removeEventListener('pointerup', end);
          divider.removeEventListener('pointercancel', end);
        };
        divider.addEventListener('pointermove', move);
        divider.addEventListener('pointerup', end);
        divider.addEventListener('pointercancel', end);
      });
      resize(saved.split);
    }
    function layoutDiscussion(shown) {
      const workspace = root.querySelector('.report-workspace');
      if (!workspace) return;
      workspace.dataset.discuss = String(shown);
      root.querySelector('.report-divider').hidden = !shown;
      root.querySelector('.report-discussion-panel').hidden = !shown;
      root.querySelector('[data-report-discuss]').textContent = shown ? 'Hide discussion' : 'Discuss';
    }
    function updateChat(shown) {
      if (chat) chat.setVisible(shown && visible);
    }
    async function showDiscussion(shown) {
      const report = selected;
      if (!report) return;
      const saved = state(report.id);
      saved.discuss = shown;
      layoutDiscussion(shown);
      if (shown && !chat) {
        await createDiscussion(report, saved);
      } else updateChat(shown);
      remember();
    }
    async function createDiscussion(report, saved) {
      const draft = saved.draft;
      const view = await post('report-discuss-action', { action: 'create', reportId: report.id });
      if (selected?.id !== report.id) return;
      chat = window.createProjectDiscussUI({
        rootId: 'report-discussion',
        idPrefix: 'report-',
        fixedConversation: true,
        draftKey: () => report.id,
        request: (path) =>
          path.startsWith('/api/project-discuss?') || path === '/api/project-discuss'
            ? request('/api/report-discuss?report=' + encodeURIComponent(report.id))
            : request(path),
        post: (_path, input) =>
          post('report-discuss-action', { ...input, conversationId: view.selected.id, reportId: report.id }),
      });
      await chat.setVisible(true);
      chat.setDraft(draft);
    }
    const reportCheckboxes = () => [...root.querySelectorAll('[data-report-select]')];
    function syncReportSelection() {
      const all = root.querySelector('[data-report-select-all]');
      const rows = reportCheckboxes();
      const checked = rows.filter((row) => row.checked).length;
      all.checked = checked === rows.length && checked > 0;
      all.indeterminate = checked > 0 && !all.checked;
      root.querySelector('[data-report-delete]').disabled = checked === 0;
    }
    root.addEventListener('change', ({ target }) => {
      if (target.hasAttribute('data-report-select-all')) {
        for (const row of reportCheckboxes()) row.checked = target.checked;
      } else if (!target.hasAttribute('data-report-select')) return;
      syncReportSelection();
    });
    function reportsToDelete() {
      return selected
        ? [selected.id]
        : [...root.querySelectorAll('[data-report-select]:checked')].map((row) => row.dataset.reportSelect);
    }
    function confirmDelete(count) {
      return confirm(count === 1 ? 'Permanently delete this report?' : `Permanently delete these ${count} reports?`);
    }
    async function deleteReports(button) {
      const ids = reportsToDelete();
      if (!ids.length || !confirmDelete(ids.length)) return;
      const current = generation;
      button.disabled = true;
      try {
        await post('investigation-report-delete', { ids });
        if (current === generation) await list();
      } finally {
        button.disabled = false;
      }
    }
    const clickActions = [
      ['data-report-delete', deleteReports],
      ['data-report-open', (button) => open(button.dataset.reportOpen)],
      ['data-report-all', () => list()],
      ['data-report-discuss', () => showDiscussion(!state(selected.id).discuss)],
      ['data-report-copy-evidence', copyEvidenceLink],
    ];
    root.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      for (const [attribute, action] of clickActions) {
        if (button.hasAttribute(attribute)) void Promise.resolve(action(button)).catch(error);
      }
    });
    window.addEventListener('beforeunload', remember);
    async function loadReader(id) {
      try {
        if (id) await open(id);
        else await list();
      } catch (failure) {
        root.innerHTML = '<p data-report-error role="alert"></p>';
        error(failure);
      }
    }
    function enter() {
      const id = new URL(location.href).searchParams.get('report');
      if (id && selected?.id === id) updateChat(state(id).discuss);
      else void loadReader(id);
    }
    return {
      setVisible(value) {
        const was = visible;
        visible = value;
        root.hidden = !value;
        if (!value) {
          remember();
          if (chat) chat.setVisible(false);
          return;
        }
        if (!was) enter();
      },
    };
  };
})();
