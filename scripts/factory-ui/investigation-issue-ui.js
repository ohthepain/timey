(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  window.createInvestigationIssueUI = ({ request, post, changed }) => {
    let issueId,
      current,
      options,
      selectedRun,
      initialized,
      loading = false,
      pending = false,
      runRequest;
    const settings = () => ({
      reusable: $('investigation-reusable').checked,
      branch: $('investigation-branch').value,
      prompt: $('investigation-prompt').value,
      instructions: $('investigation-instructions').value,
    });
    const action = (action, data = {}) =>
      post('project-home-action', { action, issueId, requestId: crypto.randomUUID(), ...data });
    function renderSettings() {
      if (initialized === issueId) return;
      initialized = issueId;
      $('investigation-reusable').checked = current.reusable;
      const branches = options.branches;
      $('investigation-branch').innerHTML = branches
        .map(({ ref, name }) => `<option value="${escape(ref)}">${escape(name)}</option>`)
        .join('');
      $('investigation-branch').value = current.configuration.branch || options.defaultBranch;
      $('investigation-prompt').value = current.configuration.prompt;
      $('investigation-instructions').value = current.configuration.instructions;
      $('investigation-destination').innerHTML =
        `<option value="">Project default (${escape(options.defaultFolder || 'unavailable')})</option>` +
        options.folders.map(({ name }) => `<option value="${escape(name)}">${escape(name)}</option>`).join('');
    }
    function legacyFollowups(run) {
      if (run.sessionId || run.status !== 'completed' || run.id !== current.runs[0]?.id) return '';
      return `<button class="small-button" data-investigation-followups="${escape(run.blockId)}" data-source-issue="${escape(issueId)}">Create follow-up issues</button>`;
    }
    function renderResult() {
      const run = current.runs.find(({ id }) => id === selectedRun) || current.runs[0];
      const panel = $('investigation-result-panel');
      const html = run
        ? `<h2>Results · ${escape(new Date(run.startedAt).toLocaleString())}</h2><p class="muted">${escape(run.status)} · Revision ${escape(run.revision || 'not recorded')}</p><pre class="home-result">${escape(run.output)}</pre><details><summary>Instructions and settings used</summary><pre class="home-result">${escape(run.prompt)}\n${escape(JSON.stringify(run.settings || {}, null, 2))}</pre></details>${renderEvidence(run)}${legacyFollowups(run)}<h3>Issues from this run</h3>${run.issues.length ? `<ul>${run.issues.map((issue) => `<li><a href="/?issue=${encodeURIComponent(issue.id)}">${escape(issue.title)}</a> · ${issue.relation === 'created' ? 'Created this run' : 'Already tracked'} · ${escape(issue.location === 'archive' ? 'archived' : issue.state)}</li>`).join('')}</ul>` : '<p class="muted">No issues created by this run.</p>'}${run.error ? `<p role="alert">${escape(run.error)}</p>` : ''}`
        : '<p class="muted">No investigation runs yet. Review the prompt and select Run investigation.</p>';
      window.timeyView.render(panel, html, 'investigation-result:' + issueId + ':' + run?.id);
    }
    function renderEvidence(run) {
      return `<details><summary>Evidence (${run.evidence.length})</summary>${run.evidence.map((file) => `<button class="small-button" type="button" data-open-file="${escape(file.path)}">${escape(file.label || 'Inspect evidence')}</button>`).join('')}</details>`;
    }
    function render() {
      renderSettings();
      const active = Boolean(current.active);
      const locked = active || pending || current.archived;
      for (const field of $('investigation-settings-form').elements) field.disabled = locked;
      const completed = current.runs.some(({ status }) => status === 'completed');
      $('investigation-run').disabled = locked || current.needsApproval || (completed && !current.reusable);
      $('investigation-run').textContent = completed && current.reusable ? 'Run again' : 'Run investigation';
      $('investigation-stop').hidden = !active;
      $('investigation-stop').disabled = pending;
      const last = current.runs[0];
      $('investigation-retry').hidden =
        active || !last?.sessionId || !['failed', 'stopped', 'interrupted'].includes(last.status);
      $('investigation-retry').disabled = pending || current.archived;
      renderStatus(active, completed);
      renderHistory(locked);
      renderResult();
    }
    function renderStatus(active, completed) {
      $('investigation-archive').disabled = active || pending;
      $('investigation-archive').textContent = current.archived ? 'Restore' : 'Archive';
      $('investigation-status').textContent =
        current.active?.phase ||
        (active
          ? 'Running investigation…'
          : current.archived
            ? 'Archived'
            : completed
              ? 'Latest investigation completed.'
              : 'Ready');
    }
    function renderHistory(locked) {
      $('investigation-runs-label').textContent = `Runs (${current.runs.length})`;
      const list = current.runs
        .map(
          (run) =>
            `<button class="home-run" type="button" data-investigation-run="${escape(run.id)}"${run.id === selectedRun ? ' aria-current="true"' : ''}><span>${escape(new Date(run.startedAt).toLocaleString())} · ${escape(run.status)}</span><small>${run.issues.filter(({ relation }) => relation === 'created').length} issues created</small></button>`
        )
        .join('');
      window.timeyView.render($('investigation-run-list'), list, 'investigation-runs:' + issueId);
      window.timeyView.render(
        $('investigation-discussions'),
        current.discussions
          .map((run) => `<article><pre class="home-result">${escape(run.output)}</pre></article>`)
          .join(''),
        'investigation-discussion:' + issueId
      );
      for (const field of $('investigation-discussion-form').elements) field.disabled = locked || current.needsApproval;
    }
    async function refresh() {
      if (!issueId || loading) return;
      loading = true;
      const id = issueId;
      try {
        const data = await request('/api/investigation?issue=' + encodeURIComponent(id));
        const config = options || (await request('/api/project-home'));
        if (id !== issueId) return;
        current = data;
        options = config;
        render();
      } catch (error) {
        if (id === issueId) $('investigation-error').textContent = error.message;
      } finally {
        loading = false;
      }
    }
    async function perform(operation) {
      if (pending || !current) return;
      pending = true;
      $('investigation-error').textContent = '';
      render();
      try {
        await operation();
        await changed();
        await refresh();
      } catch (error) {
        $('investigation-error').textContent = error.message;
      } finally {
        pending = false;
        render();
      }
    }
    const save = async () => {
      current = await action('investigation-save', { ...settings(), revision: current.revision });
    };
    $('investigation-settings-form').addEventListener('submit', (event) => {
      event.preventDefault();
      void perform(save);
    });
    $('investigation-run').addEventListener(
      'click',
      () =>
        void perform(async () => {
          runRequest ||= crypto.randomUUID();
          await save();
          await action('investigation-run', {
            ...settings(),
            requestId: runRequest,
            folder: $('investigation-destination').value || undefined,
          });
          runRequest = null;
          selectedRun = null;
          $('investigation-destination').value = '';
        })
    );
    $('investigation-stop').addEventListener(
      'click',
      () => void perform(() => action('investigation-stop', { id: current.active.id }))
    );
    $('investigation-retry').addEventListener(
      'click',
      () => void perform(() => action('investigation-retry', { id: current.runs[0].sessionId }))
    );
    $('investigation-archive').addEventListener(
      'click',
      () =>
        void perform(async () => {
          const result = await post('issue-storage-move', {
            action: current.archived ? 'restore' : 'archive',
            issueIds: [issueId],
          });
          const failed = result.results.find(({ status, error }) => status === 'failed' || error);
          if (failed) throw Error(failed.error);
        })
    );
    $('investigation-runs').addEventListener('click', (event) => {
      const button = event.target.closest('[data-investigation-run]');
      if (!button) return;
      selectedRun = button.dataset.investigationRun;
      renderResult();
    });
    $('investigation-discussion-form').addEventListener('submit', (event) => {
      event.preventDefault();
      void perform(async () => {
        await action('investigation-discuss', { ...settings(), message: $('investigation-message').value });
        $('investigation-message').value = '';
      });
    });
    setInterval(() => {
      if (issueId && !document.hidden && !pending) void refresh();
    }, 1500);
    return {
      show(id) {
        $('investigation-page').hidden = !id;
        if (id === issueId) return;
        issueId = id;
        current = null;
        selectedRun = null;
        initialized = null;
        options = null;
        runRequest = null;
        if (id) {
          $('investigation-result-panel').textContent = 'Loading investigation…';
          $('investigation-error').textContent = '';
          void refresh();
        }
      },
    };
  };
})();
