(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const escape = window.timeyEscapeHTML;
  const view = window.timeyView;
  const strategy = () => $('night-strategy').value;
  const label = (issue) => (issue.issueNumber ? '#' + issue.issueNumber + ' ' : '') + issue.title;
  const button = (action, text, disabled = false) =>
    `<button type="button" class="small-button" data-night-action="${action}"${disabled ? ' disabled' : ''}>${text}</button>`;

  window.createProjectNightUI = ({ request, post, changed, index }) => {
    const order = $('night-order');
    const masterForm = $('night-master');
    const selected = $('night-runs');
    let runId = view.read('night-run', '');
    let issueIds = [];
    let snapshot;
    let group;
    let chat;
    let mounting;
    let visible = false;
    let pending = false;
    let dirty = false;
    const picked = new Set();

    const flowAction = (action, fields) => post('flow-action', { action, ...fields });

    function error(message = '') {
      $('night-error').textContent = message;
      $('night-error').hidden = !message;
    }

    function closeGroup() {
      group = null;
      masterForm.hidden = true;
    }

    function resetEdits() {
      picked.clear();
      closeGroup();
      $('night-reasoning').replaceChildren();
    }

    function savedOrder(run) {
      return [...(run.issueIds || run.issues.map(({ id }) => id))];
    }

    function restore(run) {
      snapshot = run;
      issueIds = run ? savedOrder(run) : [];
      $('night-strategy').value = run?.strategy || 'same-blast-radius';
      dirty = false;
      resetEdits();
    }

    function runOptions(runs) {
      const current = [
        '<option value="">New draft</option>',
        ...runs.map(
          ({ id, updatedAt, status }) =>
            `<option value="${escape(id)}">${escape(new Date(updatedAt).toLocaleString())} · ${escape(status)}</option>`
        ),
      ].join('');
      view.render(selected, current);
      selected.value = runId;
    }

    function issueOptions(issues) {
      const select = $('night-issue');
      const current = select.value;
      const markup = issues
        .filter(({ id, masterId, status }) => !issueIds.includes(id) && !masterId && status !== 'closed')
        .map(
          (issue) =>
            `<option value="${escape(issue.id)}">${escape(label(issue) + ' · ' + (issue.folder || 'No folder'))}</option>`
        )
        .join('');
      view.render(select, markup || '<option value="">No issues available</option>');
      if ([...select.options].some(({ value }) => value === current)) select.value = current;
      $('night-add').disabled = pending || !select.value;
    }

    function issueStatus(issue, { issueLink, statusIcon }) {
      return `${statusIcon(issue.humanInput ? 'needs-input' : issue.status)} ${issueLink(issue)} <small>${escape(issue.humanInput ? 'Needs your input' : issue.status)}</small>`;
    }

    function findIssue(issues, id) {
      return issues.find((item) => item.id === id) || { id, title: id, status: 'unavailable' };
    }

    function rowResult(id) {
      return snapshot?.issues?.find((item) => item.id === id);
    }

    function row(id, position, data, editable) {
      const issue = findIssue(data.issues, id);
      const result = rowResult(id);
      const children = orderedChildren(issue, data);
      return rowMarkup(issue, result, children, data, editable ? rowControls(issue, position) : '');
    }

    function rowControls(issue, position) {
      return `<div class="folder-controls">
        ${button('up', 'Move up', pending || position === 0)}
        ${button('down', 'Move down', pending || position === issueIds.length - 1)}
        ${button('remove', 'Remove', pending)}
        ${groupSelection(issue)}
      </div>`;
    }

    function groupSelection({ id, groupEligible }) {
      if (!groupEligible) return '';
      return `<label><input type="checkbox" data-night-pick ${picked.has(id) ? 'checked' : ''}> Select for master</label>`;
    }

    function orderedChildren(issue, data) {
      const order = issue.subIssueOrder || [];
      return data.issues
        .filter(({ masterId }) => masterId === issue.id)
        .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    }

    function rowMarkup(issue, result, children, data, controls) {
      return `<li data-view-key="${escape(issue.id)}" data-night-id="${escape(issue.id)}">
        <div>${issueStatus(issue, data)}${issue.folder ? ' · ' + escape(issue.folder) : ''}</div>
        ${result ? `<p>${escape([result.status, result.block, result.summary].filter(Boolean).join(' · '))}</p>` : ''}
        ${controls}
        ${
          children.length
            ? `<ul aria-label="Sub-issues">${children
                .map((child) => '<li>' + issueStatus(child, data) + '</li>')
                .join('')}</ul>`
            : ''
        }
      </li>`;
    }

    function render() {
      if (!visible) return;
      const data = index();
      const runs = data.projectNightRuns || [];
      syncRun(runs.find(({ id }) => id === runId));
      const editable = !snapshot || snapshot.status === 'draft';
      runOptions(runs);
      issueOptions(data.issues);
      view.render(
        order,
        issueIds.map((id, position) => row(id, position, data, editable)).join(''),
        'night-order:' + runId
      );
      renderPlanControls(editable, data.newActionsPaused);
      renderRunControls();
    }

    function syncRun(current) {
      if (!current || pending) return;
      if (current.status !== 'draft') return syncStartedRun(current);
      syncDraft(current);
    }

    function syncDraft(current) {
      if (!dirty && current.revision !== snapshot?.revision) restore(current);
    }

    function syncStartedRun(current) {
      if (snapshot?.status === 'draft' || !snapshot) restore(current);
      else snapshot = current;
    }

    function runStatus() {
      return dirty ? 'Unsaved changes' : snapshot?.status || '';
    }

    function renderPlanControls(editable, paused) {
      $('night-edit').hidden = !editable;
      $('night-save').hidden = !editable;
      $('night-save').disabled = pending;
      $('night-start').hidden = !editable;
      $('night-start').disabled = [pending, dirty, !snapshot, !issueIds.length, paused].some(Boolean);
      $('night-suggest').disabled = pending || issueIds.length < 2;
      $('night-group').disabled = pending || picked.size < 2;
      $('night-strategy').disabled = pending;
      $('night-issue').disabled = pending;
      masterForm.querySelector('button[type="submit"]').disabled = pending;
    }

    function renderRunControls() {
      $('night-stop').hidden = snapshot?.status !== 'running';
      $('night-stop').disabled = pending;
      $('night-discuss-tab').disabled = [pending, dirty, !snapshot].some(Boolean);
      $('night-new').disabled = pending;
      selected.disabled = pending;
      $('night-status').textContent = runStatus();
    }

    async function perform(task) {
      if (pending) return;
      pending = true;
      error();
      render();
      try {
        await task();
      } catch (failure) {
        error(failure.message);
      } finally {
        pending = false;
        render();
      }
    }

    function edit(ids) {
      issueIds = ids;
      dirty = true;
      closeGroup();
      render();
    }

    function planTab() {
      $('night-plan').hidden = false;
      $('night-discuss').hidden = true;
      $('night-plan-tab').setAttribute('aria-selected', 'true');
      $('night-discuss-tab').setAttribute('aria-selected', 'false');
      void chat?.setVisible(false);
    }

    function open(id) {
      planTab();
      chat?.destroy();
      chat = null;
      mounting = null;
      runId = id;
      view.write('night-run', id);
      restore(index().projectNightRuns?.find((run) => run.id === id));
      error();
      render();
    }

    $('night-new').onclick = () => open('');
    selected.onchange = () => open(selected.value);
    $('night-plan-tab').onclick = planTab;
    $('night-discuss-tab').onclick = () =>
      void perform(async () => {
        if (!chat) {
          const id = runId;
          const token = (mounting = {});
          const result = await post('night-discuss-action', { action: 'create', runId: id });
          if (mounting !== token) return;
          chat = window.createProjectDiscussUI({
            rootId: 'night-conversation',
            idPrefix: 'night-',
            fixedConversation: true,
            draftKey: () => id,
            request: (path) =>
              path.startsWith('/api/project-discuss?') || path === '/api/project-discuss'
                ? request('/api/night-discuss?run=' + encodeURIComponent(id))
                : request(path),
            post: (_path, input) =>
              post('night-discuss-action', { ...input, runId: id, conversationId: result.selected.id }),
          });
        }
        if (!visible) return;
        $('night-plan').hidden = true;
        $('night-discuss').hidden = false;
        $('night-plan-tab').setAttribute('aria-selected', 'false');
        $('night-discuss-tab').setAttribute('aria-selected', 'true');
        await chat.setVisible(true);
      });

    $('night-add').onclick = () => edit([...issueIds, $('night-issue').value]);
    $('night-strategy').onchange = () => {
      resetEdits();
      edit(issueIds);
    };
    order.onchange = (event) => {
      if (!event.target.matches('[data-night-pick]')) return;
      const id = event.target.closest('[data-night-id]').dataset.nightId;
      if (event.target.checked) picked.add(id);
      else picked.delete(id);
      closeGroup();
      render();
    };
    order.onclick = (event) => {
      const action = event.target.closest('[data-night-action]')?.dataset.nightAction;
      if (!action) return;
      const id = event.target.closest('[data-night-id]').dataset.nightId;
      const position = issueIds.indexOf(id);
      const next = issueIds.filter((item) => item !== id);
      if (action === 'remove') picked.delete(id);
      else next.splice(position + (action === 'up' ? -1 : 1), 0, id);
      edit(next);
    };

    $('night-save').onclick = () =>
      void perform(async () => {
        const saved = await flowAction('project-night-save', {
          runId,
          revision: snapshot?.revision,
          issueIds,
          strategy: strategy(),
        });
        runId = saved.id;
        view.write('night-run', runId);
        snapshot = saved;
        dirty = false;
        await changed();
      });
    $('night-start').onclick = () =>
      void perform(async () => {
        snapshot = await flowAction('project-night-start', { runId, revision: snapshot.revision });
        await changed();
      });
    $('night-stop').onclick = () =>
      void perform(async () => {
        snapshot = await flowAction('project-night-stop', { runId });
        await changed();
      });
    $('night-suggest').onclick = () =>
      void perform(async () => {
        const method = strategy();
        const suggestions = await flowAction('project-night-suggest', { issueIds, strategy: method });
        const reasoning = $('night-reasoning');
        if (method === 'same-blast-radius') {
          picked.clear();
          for (const { id } of suggestions) picked.add(id);
        }
        const issues = index().issues;
        view.render(
          reasoning,
          suggestions.length
            ? '<ul>' +
                suggestions
                  .map(
                    ({ id, reason }) =>
                      '<li><strong>' +
                      escape(label(issues.find((issue) => issue.id === id) || { title: id })) +
                      '</strong> ' +
                      escape(reason) +
                      '</li>'
                  )
                  .join('') +
                '</ul>'
            : '<p>No matches in this plan.</p>'
        );
      });
    $('night-group').onclick = () =>
      void perform(async () => {
        const ids = issueIds.filter((id) => picked.has(id));
        const preview = await flowAction('project-night-group', { issueIds: ids });
        group = { ids, previewId: preview.id, requestId: crypto.randomUUID() };
        $('night-master-wording').value = preview.wording;
        masterForm.hidden = false;
        $('night-master-wording').focus();
      });
    $('night-cancel-group').onclick = closeGroup;
    masterForm.onsubmit = (event) => {
      event.preventDefault();
      void perform(async () => {
        const { ids, ...input } = group;
        const result = await flowAction('folder-group-create', { ...input, wording: $('night-master-wording').value });
        const insert = issueIds.indexOf(ids[0]);
        const next = issueIds.filter((id) => !ids.includes(id));
        next.splice(insert, 0, result.issue.id);
        picked.clear();
        edit(next);
        await changed();
      });
    };

    return {
      setVisible(value) {
        if (!value && visible) planTab();
        visible = value;
        $('project-night').hidden = !value;
        render();
      },
    };
  };
})();
