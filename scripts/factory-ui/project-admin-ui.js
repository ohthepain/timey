(() => {
  'use strict';
  const $ = (id) => document.getElementById(`admin-prune-${id}`);
  const endpoint = 'project-worktree-cleanup';

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function checkbox(text, checked) {
    const input = element('input');
    input.type = 'checkbox';
    input.checked = checked;
    const label = element('label', '', 'home-activate');
    label.append(input, document.createTextNode(text));
    return { label, input };
  }

  function previewOperation(field, updateSelection) {
    const operation = { pending: false, run };

    async function run(action) {
      if (operation.pending) return;
      operation.pending = true;
      field('error').textContent = '';
      for (const id of ['close', 'refresh', 'back', 'apply']) field(id).disabled = true;
      try {
        await action();
      } catch (error) {
        field('status').textContent = '';
        field('error').textContent = error.message;
      } finally {
        operation.pending = false;
        for (const id of ['close', 'refresh', 'back', 'apply']) field(id).disabled = false;
        updateSelection();
      }
    }

    return operation;
  }

  function branchCleanupUI({ request, post }) {
    const field = (id) => document.getElementById(`admin-branches-${id}`);
    let mode;
    let comparison;
    let preview;
    let choices = [];
    let reviewed = [];
    const operation = previewOperation(field, updateSelection);
    const { run } = operation;
    let stage = null;
    const endpoint = () => `project-${mode}-branch-cleanup`;

    function selectedNames() {
      return choices.filter(({ input }) => input.checked).map(({ name }) => name);
    }

    function updateSelection() {
      const count = selectedNames().length;
      field('all').checked = count > 0 && count === choices.length;
      field('all').indeterminate = count > 0 && count < choices.length;
      field('all').disabled = !choices.length || preview?.readOnly === true;
      field('review-button').disabled = !count || operation.pending || preview?.readOnly === true;
    }

    function setStage(value) {
      stage = value;
      field('preview').hidden = stage !== 'preview';
      field('review-button').hidden = stage !== 'preview';
      field('review').hidden = stage !== 'review';
      field('back').hidden = stage !== 'review';
      field('apply').hidden = stage !== 'review';
      field('results').hidden = stage !== 'results';
    }

    function renderPreview(result) {
      const eligible = result.entries.filter(({ reason }) => !reason);
      choices = eligible.map(({ name }) => {
        const choice = checkbox(name, false);
        choice.input.dataset.branch = name;
        return { name, ...choice };
      });
      for (const { input } of choices) input.disabled = result.readOnly;
      field('eligible').replaceChildren(...choices.map(({ label }) => label));
      const kept = result.entries.filter(({ reason }) => reason);
      field('kept').hidden = !kept.length;
      field('kept').open = false;
      field('kept-title').textContent = `Branches kept (${kept.length})`;
      field('kept-list').replaceChildren(...kept.map(({ name, reason }) => element('li', `${name} · ${reason}`)));
      field('comparison').hidden = mode !== 'local';
      if (mode === 'local') {
        field('target').replaceChildren(
          new Option('Choose a comparison branch', ''),
          ...result.branches.map(({ ref, label }) => new Option(label, ref))
        );
        field('target').value = result.comparison || '';
        field('target').options[0].disabled = true;
      }
      const scope = result.repository || 'Local branches';
      const baseline = result.target ? `merged into ${result.target}` : 'choose a comparison branch';
      const message = `${scope} · ${baseline} · ${choices.length} eligible`;
      field('status').textContent = result.readOnly ? `${message}. Open the live project to apply cleanup.` : message;
      setStage('preview');
    }

    function scan() {
      return run(async () => {
        setStage(null);
        preview = null;
        choices = [];
        field('status').textContent =
          mode === 'remote'
            ? 'Checking branches and pull requests on GitHub…'
            : 'Checking local branches and Factory references…';
        const query = comparison ? `?${new URLSearchParams({ ref: comparison })}` : '';
        preview = await request(`/api/${endpoint()}${query}`);
        renderPreview(preview);
      });
    }

    function showReview() {
      reviewed = selectedNames();
      field('selected').replaceChildren(...reviewed.map((name) => element('li', name)));
      const noun = reviewed.length === 1 ? 'branch' : 'branches';
      field('apply').textContent = `Delete ${reviewed.length} ${mode} ${noun}`;
      setStage('review');
      field('back').focus();
    }

    function showResults({ results }) {
      field('status').textContent = preview.repository
        ? `Cleanup results for ${preview.repository}`
        : 'Local branch cleanup results';
      field('results').replaceChildren(
        ...results.map(({ name, status, reason }) =>
          element('li', `${name} · ${status}${reason ? ` · ${reason}` : ''}`)
        )
      );
      setStage('results');
    }

    for (const kind of ['local', 'remote']) {
      document.getElementById(`admin-${kind}-open`).addEventListener('click', () => {
        mode = kind;
        comparison = null;
        field('title').textContent = `Clean up ${mode} branches`;
        field('dialog').showModal();
        void scan();
      });
    }
    field('dialog').addEventListener('cancel', (event) => {
      if (operation.pending) event.preventDefault();
    });
    field('close').addEventListener('click', () => field('dialog').close());
    field('refresh').addEventListener('click', scan);
    field('target').addEventListener('change', () => {
      comparison = field('target').value;
      void scan();
    });
    field('eligible').addEventListener('change', updateSelection);
    field('all').addEventListener('change', () => {
      for (const { input } of choices) input.checked = field('all').checked;
      updateSelection();
    });
    field('review-button').addEventListener('click', showReview);
    field('back').addEventListener('click', () => setStage('preview'));
    field('apply').addEventListener('click', () => {
      if (stage !== 'review') return;
      void run(async () => {
        setStage(null);
        field('status').textContent = 'Rechecking and deleting selected branches…';
        showResults(await post(endpoint(), { id: preview.id, selected: reviewed }));
      });
    });
  }

  function archiveDeletionUI({ request, post }) {
    const field = (id) => document.getElementById(`admin-archive-${id}`);
    const endpoint = 'project-archive-deletion';
    let preview;
    let choices = [];
    let reviewed;
    const operation = previewOperation(field, updateSelection);
    const { run } = operation;

    function setStage(stage) {
      field('preview').hidden = stage !== 'preview';
      field('review-button').hidden = stage !== 'preview';
      for (const id of ['review', 'back', 'apply']) field(id).hidden = stage !== 'review';
      field('results').hidden = stage !== 'results';
    }

    function selections() {
      return choices
        .filter(({ issue }) => issue.checked)
        .map(({ id, title, branches }) => ({
          id,
          title,
          branches: branches.filter(({ input }) => input.checked).map(({ name }) => name),
        }));
    }

    function updateSelection() {
      const selected = selections().length;
      field('all').checked = choices.length > 0 && selected === choices.length;
      field('all').indeterminate = selected > 0 && selected < choices.length;
      field('all').disabled = operation.pending || !choices.length || preview?.readOnly || choices.length > 500;
      field('review-button').disabled = operation.pending || selected === 0 || preview?.readOnly || selected > 500;
      for (const { issue, branches } of choices) {
        for (const { input } of branches) input.disabled = !issue.checked;
      }
    }

    function renderRow(row) {
      const { id, issueNumber, reason } = row;
      const title = issueNumber ? `#${issueNumber} ${row.title}` : row.title;
      const node = element('section');
      if (reason || preview.readOnly) {
        node.append(element('p', title));
        if (reason) node.append(element('p', reason, 'muted'));
        return node;
      }
      const { label, input: issue } = checkbox(title, false);
      issue.dataset.archivedIssue = id;
      node.append(label);
      const branches = [];
      for (const { name, reason: branchReason } of row.branches) {
        if (branchReason) node.append(element('p', `${name} · ${branchReason}`, 'muted'));
        else {
          const choice = checkbox(`Also delete local branch ${name}`, false);
          choice.input.dataset.branch = name;
          node.append(choice.label);
          branches.push({ name, input: choice.input });
        }
      }
      choices.push({ id, title, issue, branches });
      return node;
    }

    function scan() {
      return run(async () => {
        setStage(null);
        choices = [];
        field('status').textContent = 'Checking archived issues…';
        preview = await request(`/api/${endpoint}`);
        field('list').replaceChildren(...preview.rows.map(renderRow));
        const notes = [
          `${preview.rows.length} archived issues.`,
          preview.target && `Local branches are compared with ${preview.target}.`,
          preview.readOnly && 'Open the live project to delete issues.',
          choices.length > 500 && 'Select up to 500 issues at a time.',
        ];
        field('status').textContent = notes.filter(Boolean).join(' ');
        if (preview.branchError)
          field('error').textContent = `Local branch choices are unavailable. ${preview.branchError}`;
        setStage('preview');
      });
    }

    function review() {
      reviewed = selections();
      field('selected').replaceChildren(
        ...reviewed.map(({ title, branches }) =>
          element('li', branches.length ? `${title} · Local branches: ${branches.join(', ')}` : title)
        )
      );
      field('apply').textContent =
        `Permanently delete ${reviewed.length} archived ${reviewed.length === 1 ? 'issue' : 'issues'}`;
      setStage('review');
      field('back').focus();
    }

    function results(response) {
      const titles = new Map(reviewed.map(({ id, title }) => [id, title]));
      field('results').replaceChildren(
        ...response.results.map(({ id, status, reason, branches }) => {
          const item = element('li', `${titles.get(id)} · ${status}${reason ? ` · ${reason}` : ''}`);
          if (branches.length)
            item.append(
              ...branches.map((branch) =>
                element('p', `${branch.name} · ${branch.status}${branch.reason ? ` · ${branch.reason}` : ''}`, 'muted')
              )
            );
          return item;
        })
      );
      field('status').textContent = 'Archive deletion results';
      setStage('results');
      window.dispatchEvent(new Event('factory-archive-updated'));
    }

    field('open').addEventListener('click', () => {
      field('dialog').showModal();
      void scan();
    });
    field('close').addEventListener('click', () => field('dialog').close());
    field('dialog').addEventListener('cancel', (event) => {
      if (operation.pending) event.preventDefault();
    });
    field('refresh').addEventListener('click', scan);
    field('all').addEventListener('change', () => {
      for (const { issue } of choices) issue.checked = field('all').checked;
      updateSelection();
    });
    field('list').addEventListener('change', updateSelection);
    field('review-button').addEventListener('click', review);
    field('back').addEventListener('click', () => setStage('preview'));
    field('apply').addEventListener(
      'click',
      () =>
        void run(async () => {
          setStage(null);
          field('status').textContent = 'Deleting selected archived issues…';
          results(
            await post(endpoint, { id: preview.id, selected: reviewed.map(({ id, branches }) => ({ id, branches })) })
          );
        })
    );
  }

  window.createProjectAdminUI = ({ request, post }) => {
    branchCleanupUI({ request, post });
    archiveDeletionUI({ request, post });
    let preview = null;
    let rows = [];
    let pending = false;

    function selected() {
      return rows
        .filter(({ worktree }) => worktree.checked)
        .map(({ id, branch }) => ({ id, deleteBranch: branch?.checked === true }));
    }

    function updateControls() {
      const choices = selected();
      for (const { branch, worktree } of rows) {
        worktree.disabled = pending;
        if (branch) branch.disabled = pending || !worktree.checked;
      }
      $('ref').disabled = pending;
      $('refresh').disabled = pending;
      $('close').disabled = pending;
      $('apply').disabled = pending || !preview?.comparison || preview.readOnly || !choices.length;
      const branches = choices.filter(({ deleteBranch }) => deleteBranch).length;
      const worktreeLabel = `${choices.length} worktree ${choices.length === 1 ? 'record' : 'records'}`;
      const branchLabel = `${branches} ${branches === 1 ? 'branch' : 'branches'}`;
      $('apply').textContent = choices.length ? `Remove ${worktreeLabel} and ${branchLabel}` : 'Remove selected';
    }

    function renderEntry(entry) {
      const node = element('div');
      node.append(element('p', entry.path));
      if (entry.reason) {
        if (entry.branch) node.append(element('p', entry.branch.replace(/^refs\/heads\//, ''), 'muted'));
        node.append(element('p', entry.reason, 'muted'));
        return node;
      }
      const worktree = checkbox('Remove worktree record', true);
      node.append(worktree.label);
      let branch;
      const name = entry.branch?.replace(/^refs\/heads\//, '');
      if (entry.branchReason)
        node.append(element('p', [name, entry.branchReason].filter(Boolean).join(' · '), 'muted'));
      else {
        const detail = entry.merged ? '' : ' · commits not confirmed in comparison branch';
        branch = checkbox(`Delete local branch ${name}${detail}`, entry.merged);
        branch.input.dataset.branch = name;
        node.append(branch.label);
      }
      rows.push({ id: entry.id, worktree: worktree.input, branch: branch?.input });
      return node;
    }

    function renderPreview(result) {
      $('ref').replaceChildren(
        new Option('Choose a comparison branch', ''),
        ...result.branches.map((ref) => new Option(ref.replace(/^refs\/(heads|remotes)\//, ''), ref))
      );
      $('ref').value = result.comparison?.ref || '';
      $('ref').options[0].disabled = true;
      const message = result.entries.length
        ? `${result.entries.length} prunable worktree records found.`
        : 'No prunable worktree records found.';
      $('status').textContent = result.readOnly ? `${message} Open the live project to apply cleanup.` : message;
      $('list').replaceChildren(...result.entries.map(renderEntry));
    }

    async function run(action) {
      if (pending) return;
      pending = true;
      $('error').textContent = '';
      updateControls();
      try {
        await action();
      } catch (error) {
        $('error').textContent = error.message;
      } finally {
        pending = false;
        updateControls();
      }
    }

    function scan(ref) {
      return run(async () => {
        preview = null;
        rows = [];
        $('list').replaceChildren();
        $('status').textContent = 'Scanning this project…';
        preview = await request(`/api/${endpoint}` + (ref ? `?${new URLSearchParams({ ref })}` : ''));
        renderPreview(preview);
      });
    }

    function renderResults({ results }) {
      $('status').textContent = 'Cleanup results';
      $('list').replaceChildren(
        ...results.map(({ path, status, branch, reason, worktreeRemoved }) => {
          const node = element('div');
          node.append(element('p', path));
          const outcome =
            status === 'removed'
              ? `Worktree record removed. ${branch ? `Deleted ${branch.replace(/^refs\/heads\//, '')}.` : 'Local branch unchanged.'}`
              : `${worktreeRemoved ? 'Worktree record removed. ' : ''}${status === 'skipped' ? 'Skipped' : 'Failed'}: ${reason}`;
          node.append(element('p', outcome, 'muted'));
          return node;
        })
      );
    }

    $('worktrees').addEventListener('click', () => {
      $('dialog').showModal();
      void scan();
    });
    $('dialog').addEventListener('cancel', (event) => {
      if (pending) event.preventDefault();
    });
    $('close').addEventListener('click', () => $('dialog').close());
    $('refresh').addEventListener('click', () => void scan($('ref').value));
    $('ref').addEventListener('change', () => void scan($('ref').value));
    $('list').addEventListener('change', updateControls);
    $('form').addEventListener('submit', (event) => {
      event.preventDefault();
      if ($('apply').disabled) return;
      void run(async () => {
        const input = { id: preview.id, selected: selected() };
        preview = null;
        rows = [];
        $('list').replaceChildren();
        $('status').textContent = 'Removing selected worktree records…';
        renderResults(await post(endpoint, input));
      });
    });
  };
})();
