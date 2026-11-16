(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    index: { issues: [], folders: [], catalog: [] },
    view: null,
    issueId: new URL(location.href).searchParams.get('issue'),
    blockId: null,
    graphScrollIntent: null,
    sidebarWidth: null,
    inspectorWidth: null,
    tab: 'details',
    search: '',
    folders: new Set(),
    drafts: new Map(),
    repoFiles: new Map(),
    loading: false,
    pending: false,
    updatingBranch: null,
    newActionsPaused: false,
    sequence: 0,
    controller: null,
    error: '',
    connectionError: '',
    captureId: null,
    checkedBlock: null,
    toastTimer: null,
  };
  const kinds = {
    request: { icon: '💬', color: '#aaa49b', description: 'The goal and the evidence that will show it is done.' },
    sharpen: { icon: '◇', color: '#c6b66b', description: 'Refine the request and agree on what to do.' },
    grill: { icon: '◇', color: '#c6b66b', description: 'Resolve questions before the next step.' },
    understand: { icon: '⌕', color: '#a39bc3', description: 'Read the code and understand its behavior.' },
    repro: { icon: '↺', color: '#c69a62', description: 'Reproduce the problem and retain the result.' },
    design: { icon: '◇', color: '#aaa0ca', description: 'Explore and choose an implementation.' },
    work: { icon: '⌘', color: '#76b78d', description: 'Make the change with your chosen skill.' },
    tdd: { icon: '⊡', color: '#76b78d', description: 'Drive implementation with a failing test.' },
    edit: { icon: '✎', color: '#76b78d', description: 'Choose the edits to apply.' },
    prototype: { icon: '▱', color: '#76b78d', description: 'Build a prototype and gather feedback.' },
    sol: { icon: '↻', color: '#76b78d', description: 'Run a bounded Sol review loop.' },
    benchmark: { icon: '▥', color: '#c69a62', description: 'Measure the behavior and retain the proof.' },
    verify: { icon: '✓', color: '#c69a62', description: 'Check the result against your verification intent.' },
    publish: { icon: '↥', color: '#7c9acb', description: 'Push the verified branch and publish its pull request.' },
    merge: { icon: '⑂', color: '#7c9acb', description: 'Merge the issue into its target branch.' },
    'update-branch': { icon: '⑂', color: '#7c9acb', description: 'Bring starting branch changes into the issue.' },
    retro: { icon: '↶', color: '#aaa0ca', description: 'Record lessons and suggested follow-up work.' },
    close: { icon: '⊙', color: '#999999', description: 'Record the decision to close this issue.' },
    'delete-worktree': {
      icon: '⌫',
      color: '#999999',
      description: 'Remove the issue checkout after reviewing its records.',
    },
  };
  const runningStatuses = new Set(['running', 'starting', 'stopping', 'in-progress']);
  let projectSettings = null;
  let inspectedFile = null;
  let inspectorRender;

  function renderProjectSettings(settings) {
    projectSettings = settings;
    const lifecycle = settings.lifecycle;
    const policy = settings.humanInputPolicy;
    $('project-settings-content').innerHTML =
      `<p class="muted">${escape(settings.project)}</p><h3>Human input</h3><p>The factory checks required human input before dependent work.${policy.require_explicit_acceptance ? ' Closing a fixed issue requires your explicit acceptance.' : ''}${!policy.manual_checks_before_commit ? ' Local progress commits can keep outstanding human checks recorded.' : ''}</p><p class="muted">These rules come from the project adapter. There is no policy preset to select here. Each issue keeps its own requests and approvals.</p><h3>Lifecycle configuration</h3><p>${lifecycle.present ? 'Lifecycle configuration is present.' : 'Lifecycle configuration is missing.'}</p><p>${lifecycle.present ? 'The saved configuration is shown below. Each operation still checks its required human input.' : 'Editable work and verification need this configuration. Initialize the standard lifecycle below. If this project previously used custom states, restore its original configuration instead.'}</p><details><summary>${lifecycle.present ? 'View configuration' : 'Preview standard configuration'}</summary><pre>${escape(lifecycle.content)}</pre></details><p class="muted">${escape(lifecycle.path)}</p>`;
    $('initialize-lifecycle').hidden = lifecycle.present;
  }

  async function openProjectSettings() {
    projectSettings = null;
    $('project-settings-error').hidden = true;
    $('project-settings-content').textContent = 'Loading project settings…';
    $('initialize-lifecycle').hidden = true;
    $('project-settings-dialog').showModal();
    try {
      renderProjectSettings(await json('/api/project-settings'));
    } catch (error) {
      $('project-settings-error').textContent = error.message;
      $('project-settings-error').hidden = false;
    }
  }

  async function initializeLifecycle() {
    if (!projectSettings || $('initialize-lifecycle').disabled) return;
    $('initialize-lifecycle').disabled = true;
    $('project-settings-error').hidden = true;
    try {
      renderProjectSettings(
        await json('/api/project-settings-initialize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Factory-Action': 'manual' },
          body: JSON.stringify({ digest: projectSettings.lifecycle.digest }),
        })
      );
      toast('Lifecycle configuration saved. Retry the blocked step when ready.');
    } catch (error) {
      $('project-settings-error').textContent = error.message;
      $('project-settings-error').hidden = false;
    } finally {
      $('initialize-lifecycle').disabled = false;
    }
  }

  function escape(value) {
    return String(value ?? '').replace(
      /[&<>"']/g,
      (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
    );
  }

  function words(value) {
    return String(value ?? '')
      .replaceAll('-', ' ')
      .replaceAll('_', ' ');
  }

  function blockStyle(kind) {
    const fallback = kinds[kind] || { icon: '□', color: '#999999', description: 'An explicit step in this issue.' };
    const colors = { neutral: '#aaa49b', yellow: '#c6b66b', orange: '#c69a62', green: '#76b78d', blue: '#7c9acb' };
    const entry = state.index.catalog.find((item) => item.id === kind);
    return entry
      ? {
          icon: kinds[entry.kind]?.icon || fallback.icon,
          color: colors[entry.color] || fallback.color,
          description: entry.description,
        }
      : fallback;
  }

  function latest(block) {
    return block?.attempts?.at(-1) || null;
  }

  function status(block) {
    const attempt = latest(block);
    if (attempt?.invalidatedAt && !runningStatuses.has(attempt.status) && attempt.status !== 'uncertain')
      return 'invalidated';
    return attempt?.status || (block?.suggested ? 'suggested' : 'ready');
  }

  function isRunning(block) {
    return runningStatuses.has(status(block));
  }

  function statusText(value, attempt) {
    return value === 'blocked' && attempt?.result?.completed?.length ? 'Needs retry' : words(value);
  }

  function statusIcon(value) {
    const normalized = String(value || 'new').replaceAll('_', '-');
    const icons = {
      running: '◌',
      'in-progress': '◌',
      invalidated: '○',
      ready: '○',
      completed: '✓',
      succeeded: '✓',
      success: '✓',
      failed: '!',
      blocked: '⊘',
      merged: '⑂',
      'need-merge-from-dev': '↺',
      'need-input': '?',
      uncertain: '?',
      'ready-to-merge': '⑂',
      closed: '●',
      waiting: '◇',
      'needs-input': '◇',
      'need-input': '◇',
      'ready-to-merge': '⑂',
      'need-to-merge-from-dev': '↙',
      stopped: 'Ⅱ',
      paused: 'Ⅱ',
    };
    return `<span class="status-icon ${escape(normalized)}" title="${escape(words(normalized))}" aria-label="${escape(words(normalized))}">${icons[normalized] || '○'}</span>`;
  }

  function date(value) {
    if (!value) return '';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? String(value)
      : parsed.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function activeBlock() {
    return state.view?.flow?.blocks?.find((block) => block.id === state.blockId) || null;
  }

  function draftKey() {
    return `${state.issueId}/${state.blockId}`;
  }

  function draft() {
    return state.drafts.get(draftKey()) || {};
  }

  function setDraft(name, value) {
    state.drafts.set(draftKey(), { ...draft(), [name]: value });
    const note = $('draft-note');
    if (note) {
      note.textContent = 'Unsaved changes';
      note.className = 'draft-note';
    }
  }

  function showError(message) {
    state.error = String(message || 'The operation could not finish.');
    renderErrors();
  }

  function renderErrors() {
    const waiting = serverControlUI.isWaitingForServer();
    const message = waiting ? 'Waiting for server…' : state.error || state.connectionError;
    $('error-banner').hidden = !message;
    $('error-message').textContent = message;
    $('dismiss-error').hidden = waiting;
  }

  function toast(message) {
    clearTimeout(state.toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    state.toastTimer = setTimeout(() => {
      $('toast').hidden = true;
    }, 3500);
  }

  async function json(url, options = {}) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`The server returned an unreadable response (${response.status}). Your saved flow is unchanged.`);
    }
    if (!response.ok) throw new Error(result.error || result.message || `The request failed (${response.status}).`);
    return result;
  }

  function post(path, value) {
    return json('/api/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-factory-action': 'manual' },
      body: JSON.stringify(value),
    });
  }

  function applyView(result) {
    state.index = { ...state.index, ...result };
    if (result.flow && result.issue && result.issue.id === state.issueId) {
      state.view = result;
      if (!result.flow.blocks.some((block) => block.id === state.blockId)) {
        const attempted = result.flow.blocks
          .filter((block) => latest(block))
          .sort((a, b) =>
            String(latest(b).endedAt || latest(b).startedAt || '').localeCompare(
              String(latest(a).endedAt || latest(a).startedAt || '')
            )
          );
        state.blockId =
          result.flow.blocks.find((block) => isRunning(block))?.id ||
          attempted[0]?.id ||
          result.flow.blocks.find((block) => block.kind === 'request')?.id ||
          result.flow.blocks[0]?.id ||
          null;
        state.graphScrollIntent =
          result.issue.status === 'closed'
            ? { nodeId: '__destination', mode: 'end' }
            : attempted.length === 0
              ? { nodeId: '__base', mode: 'start' }
              : { nodeId: state.blockId, mode: 'center' };
      }
    }
    if (result.error) state.error = result.error;
    render();
  }

  async function load(force = false, announce = false) {
    if (serverControlUI.isWaitingForServer()) return;
    if (state.pending || (state.loading && !force)) {
      if (announce) toast('Wait for the current action before refreshing.');
      return;
    }
    if (force) state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const sequence = ++state.sequence;
    const selected = state.issueId;
    state.loading = true;
    try {
      const result = await json(`/api/flow${selected ? `?issue=${encodeURIComponent(selected)}` : ''}`, {
        signal: controller.signal,
      });
      if (sequence !== state.sequence || selected !== state.issueId || serverControlUI.isWaitingForServer()) return;
      state.connectionError = '';
      $('connection-status').className = 'connection';
      $('connection-status').innerHTML = '<span class="connection-dot"></span> Live · 2s';
      applyView(result);
      if (announce) toast('Saved flow refreshed.');
    } catch (error) {
      if (error.name === 'AbortError' || sequence !== state.sequence || serverControlUI.isWaitingForServer()) return;
      state.connectionError = `Unable to refresh. ${error.message} The last saved view remains visible.`;
      $('connection-status').className = 'connection offline';
      $('connection-status').innerHTML = '<span class="connection-dot"></span> Reconnecting';
      renderErrors();
    } finally {
      if (sequence === state.sequence) {
        state.loading = false;
        void checkOpenBlock();
      }
    }
  }

  async function loadRepoFiles(issueId) {
    if (state.repoFiles.has(issueId)) return;
    const result = await json(`/api/flow-files?issue=${encodeURIComponent(issueId)}`);
    state.repoFiles.set(issueId, result.files || []);
    if (state.issueId !== issueId) return;
    document.querySelectorAll('input[list^="repo-files-"]').forEach((field) => {
      const list = field.list;
      if (!list) return;
      list.replaceChildren(
        ...(result.files || []).map((path) => {
          const option = document.createElement('option');
          option.value = path;
          return option;
        })
      );
    });
  }

  async function action(name, fields = {}, options = {}) {
    if (state.pending) return null;
    const selected = state.issueId;
    const revision = state.view?.flow?.revision;
    if (!options.global && (!selected || revision == null)) {
      showError('Choose a loaded issue before changing its flow.');
      return null;
    }
    state.controller?.abort();
    state.sequence += 1;
    state.loading = false;
    state.pending = true;
    state.error = '';
    renderErrors();
    setBusy(true);
    try {
      const result = await post('flow-action', {
        action: name,
        ...(options.global ? {} : { issueId: selected, revision }),
        ...fields,
      });
      if (result.error) throw new Error(result.error);
      if (selected === state.issueId && result.flow) applyView(result);
      return result;
    } catch (error) {
      if (options.errorId) {
        $(options.errorId).textContent = error.message;
        $(options.errorId).hidden = false;
      }
      showError(error.message);
      return null;
    } finally {
      state.pending = false;
      setBusy(false);
    }
  }

  function setBusy(busy) {
    document
      .querySelectorAll(
        '[data-action], [data-add-kind], #capture-submit, #export-flow-submit, #folder-form button[type="submit"]'
      )
      .forEach((button) => {
        const runsBlock = ['start', 'continue'].includes(button.dataset.action);
        button.disabled =
          busy ||
          (runsBlock && operationPaused(activeBlock())) ||
          (button.id === 'delete-block' && Boolean(blockDeletionReason(activeBlock())));
      });
    document
      .querySelectorAll('#inspector-body input, #inspector-body select, #inspector-body textarea')
      .forEach((field) => {
        const closureSetting = ['retro-setting', 'auto-close-setting'].includes(field.id);
        field.disabled = busy || (closureSetting && state.view?.issue?.status === 'closed');
      });
    const runBlock = $('run-block');
    runBlock.disabled =
      busy ||
      (runBlock.dataset.action !== 'stop' &&
        (operationPaused(activeBlock()) || state.view?.flow?.blocks.some(isRunning))) ||
      status(activeBlock()) === 'stopping';
    updatePlaybackAvailability(busy);
    $('close-publish').disabled = busy;
    const startingBranch = $('starting-branch');
    if (startingBranch)
      startingBranch.disabled = busy || !state.view?.startingPointEditable || !state.view.branches?.length;
    $('target-update-menu').disabled = busy;
    $('worktree-menu').disabled = busy || state.view?.environment?.worktreeExists !== true;
    updateIssueDecisionControls(busy);
  }

  function updateIssueDecisionControls(busy) {
    const issue = state.view?.issue;
    const closed = issue?.status === 'closed';
    const pending = issue?.state === 'needs-approval';
    $('worktree-hint').hidden = pending;
    $('issue-approval-menu').hidden = !pending;
    $('issue-approval-menu').disabled = busy;
    $('close-with-reason').hidden = !issue || closed || pending;
    $('close-with-reason').disabled = busy;
    $('issue-archive-menu').hidden = !closed;
    $('issue-archive-menu').disabled = busy;
    const archived = issue?.location === 'archive';
    for (const option of $('issue-archive-menu').options)
      if (['archive', 'reveal', 'reopen'].includes(option.value)) option.hidden = archived;
    $('issue-archive-menu').options[0].textContent = archived ? 'Archived issue' : 'Archive';
    const closing = state.view?.flow?.closing;
    const awaiting = closed && closing && !closing.complete && !state.view.closureBusy;
    $('retry-closure').hidden = !awaiting;
    $('retry-closure').disabled = busy;
    $('skip-retro').hidden = !awaiting || !closing.retro || closing.filedRetro || closing.skipRetro;
    $('skip-retro').disabled = busy;
  }

  function updatePlaybackAvailability(busy) {
    const button = $('issue-playback');
    const playback = state.view?.autoplay;
    const paused = playback?.mode === 'paused';
    const closed = state.view?.issue?.status === 'closed';
    const pending = state.view?.issue?.state === 'needs-approval';
    button.hidden = closed;
    $('closed-issue-indicator').hidden = !closed;
    button.disabled = busy || !playback || pending || (paused && (state.newActionsPaused || closed));
    button.title = !playback
      ? 'Restart the Timey server to use Play'
      : paused && state.newActionsPaused
        ? 'Turn off No new actions to play'
        : '';
  }

  function selectIssue(id) {
    if (state.issueId === id && state.view) return;
    state.issueId = id;
    state.blockId = null;
    state.graphScrollIntent = null;
    state.view = null;
    state.error = '';
    const url = new URL(location.href);
    if (id) url.searchParams.set('issue', id);
    else url.searchParams.delete('issue');
    history.replaceState(null, '', url);
    render();
    void load(true);
  }

  function renderSidebar() {
    void updateProjectActions();
    const issues = (state.index.issues || []).filter((issue) =>
      `${issue.title} ${issue.issueNumber || ''}`.toLowerCase().includes(state.search.toLowerCase())
    );
    const folders = [
      ...new Set([...(state.index.folders || []), ...issues.map((issue) => issue.folder).filter(Boolean)]),
    ];
    const row = (issue) =>
      `<button class="issue-row${issue.id === state.issueId ? ' selected' : ''}" data-issue="${escape(issue.id)}" title="${escape(issue.title)}"${issue.id === state.issueId ? ' aria-current="page"' : ''}>${issue.activeBlock ? activeSpinner(issue.activeBlock) : statusIcon(issue.status)}<span class="issue-name">${issue.issueNumber ? `#${escape(issue.issueNumber)} - ` : ''}${escape(issue.title)}</span></button>`;
    const ungrouped = issues
      .filter((issue) => !issue.folder && issue.status !== 'closed')
      .map(row)
      .join('');
    const groups = folders
      .map((folder) => {
        const children = issues.filter((issue) => issue.folder === folder && issue.status !== 'closed');
        if (state.search && children.length === 0) return '';
        const collapsed = state.folders.has(folder) && !state.search;
        const active = children.find((issue) => issue.activeBlock);
        return `<section class="issue-folder"><div class="sidebar-heading"><button class="folder-toggle" data-folder="${escape(folder)}" aria-expanded="${!collapsed}">${active ? activeSpinner(active.activeBlock) : `<span class="folder-chevron" aria-hidden="true">${collapsed ? '›' : '⌄'}</span><span aria-hidden="true">▱</span>`}<span>${escape(folder)}</span><span class="folder-count">${children.length}</span></button><button class="icon-button" data-create-folder-issue="${escape(folder)}" aria-label="Create issue in ${escape(folder)}" title="Create issue in ${escape(folder)}">＋</button></div><div class="folder-items"${collapsed ? ' hidden' : ''}>${children.map(row).join('') || '<p class="sidebar-empty">No issues yet.</p>'}</div></section>`;
      })
      .join('');
    const list = $('issue-list');
    const closedOpen = list.querySelector('#closed-issues')?.open;
    list.innerHTML =
      ungrouped +
        groups +
        (issues.some((issue) => issue.status === 'closed')
          ? `<details id="closed-issues" class="issue-folder"${state.search || closedOpen ? ' open' : ''}><summary class="folder-toggle">Closed issues <span class="folder-count">${issues.filter((issue) => issue.status === 'closed').length}</span></summary><div class="folder-items">${issues
              .filter((issue) => issue.status === 'closed')
              .map(row)
              .join('')}</div></details>`
          : '') ||
      `<p class="sidebar-empty">${state.search ? 'No matching issues.' : 'Your issues will appear here.'}</p>`;
  }

  function activeSpinner(block) {
    const color = blockStyle(block.definition ?? block.kind).color;
    return `<span class="status-icon active-spinner" style="--spinner-color:${color}" aria-label="Running ${escape(words(block.kind))}" title="Running ${escape(words(block.kind))}"></span>`;
  }

  async function updateProjectActions() {
    const name = $('project-name');
    const button = $('project-actions');
    const project = state.index.project;
    name.textContent =
      typeof project === 'string'
        ? project.split('/').filter(Boolean).at(-1) || project
        : project?.name || 'Local workspace';
    name.title = typeof project === 'string' ? project : project?.path || '';
    try {
      const status = await requestServerControl('server-status');
      serverControlUI.show(status, requestServerControl);
    } catch {
      button.textContent = 'Actions unavailable';
      button.disabled = true;
    }
  }

  function requestServerControl(operation, data) {
    return json(
      '/api/' + operation,
      data === undefined
        ? undefined
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-factory-action': 'manual' },
            body: JSON.stringify(data),
          }
    );
  }

  function renderEnvironment() {
    const environment = state.view?.environment;
    $('environment').hidden = !environment;
    if (!environment) return;
    renderWorktreeHint(environment.worktreeExists);
    const chips = [];
    if (environment.branch)
      chips.push(`<span class="environment-chip" title="Current issue branch">⑂ ${escape(environment.branch)}</span>`);
    if (environment.dirty === true) chips.push('<span class="environment-chip warning">● Uncommitted changes</span>');
    renderTargetUpdate(environment);
    if (environment.ahead > 0) chips.push(`<span class="environment-chip">↑ ${escape(environment.ahead)} ahead</span>`);
    renderPullRequest(state.view.destination?.pr);
    if (environment.error || environment.remoteError)
      chips.push(
        `<span class="environment-chip warning" title="${escape(environment.error || environment.remoteError)}">Environment check incomplete</span>`
      );
    $('environment-status').innerHTML = chips.join('');
    $('environment').title = environment.observedAt ? `Git observed ${date(environment.observedAt)}` : '';
  }

  function renderPullRequest(pr) {
    const menu = $('issue-pr-menu');
    const link = $('issue-pr-link');
    const url = safeUrl(pr?.url);
    menu.hidden = !url;
    if (link.href !== url) menu.open = false;
    if (!url) return;
    const label = $('issue-pr-label');
    label.textContent = 'PR#' + pr.number;
    label.title = pr.title?.trim() || label.textContent;
    link.href = url;
    const review = new URL(url);
    review.pathname = review.pathname.replace(/\/$/, '') + '/files';
    review.search = '';
    review.hash = '';
    $('issue-pr-review').href = review.href;
  }

  function renderTargetUpdate(environment) {
    const menu = $('target-update-menu');
    const label = `Starting branch ahead by ${environment.startingBranchBehind}`;
    const updating = state.updatingBranch === state.issueId;
    $('target-update-progress').hidden = !updating;
    menu.hidden = updating || !(environment.startingBranchBehind > 0);
    menu.options[0].textContent = '↙ ' + label;
    menu.setAttribute('aria-label', label);
    menu.options[1].disabled = environment.worktreeExists !== true;
  }

  function renderWorktreeHint(exists) {
    const text = {
      true: 'Manage this issue’s worktree.',
      false: 'This issue’s worktree has been deleted.',
      null: 'No worktree has been created for this issue.',
    }[exists];
    $('worktree-hint').title = text;
    $('worktree-menu').title = text;
  }

  function safeUrl(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  function prLink(pr) {
    const url = safeUrl(pr?.url);
    return url
      ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">PR #${escape(pr.number)} ↗</a>`
      : '';
  }

  function operationPaused(block) {
    const destination = state.view?.destination;
    return (
      (['publish', 'merge'].includes(block?.kind) && Boolean(destination?.proposedBranch)) ||
      (block?.kind === 'publish' && Boolean(destination?.pr?.mergedAt))
    );
  }

  const destinationChecks = new Map();

  function destinationNode() {
    const { branch, follows, locked, pr, proposedBranch } = state.view.destination || {};
    const check = destinationChecks.get(state.issueId);
    const unavailable = branch && check?.branches && !check.branches.includes(branch);
    const display = branch ? `⑂ ${escape(branch)}` : 'Choose a destination';
    return `<div class="graph-terminal destination" data-node="__destination">
      <span class="terminal-label">Destination</span>
      ${
        locked
          ? `<span class="terminal-branch">${display}</span>`
          : `<button type="button" class="small-button" data-destination-open aria-label="Choose destination branch">${display}</button>`
      }
      <span class="terminal-note">${locked ? 'Locked to the PR' : follows ? 'Follows starting branch' : ''} ${prLink(pr)}</span>
      ${!locked && unavailable ? '<span class="terminal-note">Branch unavailable</span>' : ''}
      ${!locked && check?.branchesUnavailable ? '<span class="terminal-note">Couldn’t check branches</span>' : ''}
      ${
        proposedBranch
          ? `<span class="terminal-note">GitHub base changed to ${escape(proposedBranch)}</span>
        <button type="button" class="small-button" data-accept-base="${escape(proposedBranch)}">Accept GitHub base</button>`
          : ''
      }
    </div>`;
  }

  async function loadDestinationBranches() {
    const dialog = $('destination-dialog');
    const result = await action('destination-branches');
    if (!dialog.open) return;
    if (result) destinationChecks.set(state.issueId, result);
    renderGraph();
    const branches = result?.branches;
    const destination = state.view.destination;
    const unavailable = branches && destination.branch && !branches.includes(destination.branch);
    $('destination-message').textContent = !branches
      ? 'Couldn’t check branches.'
      : unavailable
        ? `Branch unavailable: ${destination.branch}. Choose another destination.`
        : '';
    $('destination-choices').hidden = !branches;
    $('retry-branches').hidden = Boolean(branches);
    $('save-destination').hidden = !branches;
    if (!branches) return;
    $('destination-branch').replaceChildren(
      new Option('Follow starting branch', ''),
      ...(unavailable && !destination.follows
        ? [new Option(destination.branch + ' (unavailable)', destination.branch)]
        : []),
      ...branches.map((branch) => new Option(branch, branch))
    );
    $('destination-branch').value = destination.follows ? '' : destination.branch;
    if (unavailable && !destination.follows) $('destination-branch').selectedOptions[0].disabled = true;
  }

  function graphLayers(blocks) {
    const ranks = new Map();
    const byId = new Map(blocks.map((block) => [block.id, block]));
    function rank(block, visiting = new Set()) {
      if (ranks.has(block.id)) return ranks.get(block.id);
      if (visiting.has(block.id)) return 0;
      const next = new Set([...visiting, block.id]);
      const dependencies = (block.after || []).map((id) => byId.get(id)).filter(Boolean);
      const value = dependencies.length ? Math.max(...dependencies.map((parent) => rank(parent, next))) + 1 : 0;
      ranks.set(block.id, value);
      return value;
    }
    const grouped = new Map();
    for (const block of blocks) {
      const level = rank(block);
      if (!grouped.has(level)) grouped.set(level, []);
      grouped.get(level).push(block);
    }
    return [...grouped.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, row]) => row.sort((a, b) => (a.lane || 0) - (b.lane || 0)));
  }

  function elapsedLabel(milliseconds) {
    const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = String(Math.floor(seconds / 60) % 60).padStart(2, '0');
    const remainder = String(seconds % 60).padStart(2, '0');
    return hours ? `${hours}:${minutes}:${remainder}` : `${minutes}:${remainder}`;
  }

  function savedWorkTime(attempt) {
    const start = Date.parse(attempt.startedAt);
    const end = Date.parse(attempt.inputRequestedAt ?? attempt.endedAt ?? attempt.lastActiveAt);
    return Number.isFinite(end - start) ? Math.max(0, end - start) : 0;
  }

  function blockTiming(block, attempt, currentStatus) {
    if (!attempt) return '';
    if (attempt.inputRequestedAt || attempt.input) return 'Needs input';
    if (attempt.result?.mergeConfirmation && currentStatus === 'blocked') return 'Needs approval';
    const start = Date.parse(attempt.startedAt);
    if (isRunning(block) && Number.isFinite(start)) {
      const now = Date.now();
      const stepStart = Date.parse(attempt.stepStartedAt ?? attempt.startedAt);
      return `<span data-timer-start="${start}" style="font-variant-numeric:tabular-nums" title="Time on this attempt">${elapsedLabel(now - start)}</span><span aria-hidden="true">·</span><span data-timer-start="${stepStart}" style="font-variant-numeric:tabular-nums" title="Time on the current command or step">${elapsedLabel(now - stepStart)}</span>`;
    }
    const label = {
      completed: 'Finished in',
      succeeded: 'Finished in',
      success: 'Finished in',
      failed: 'Failed after',
      blocked: 'Failed after',
      stopped: 'Stopped after',
      uncertain: 'Disconnected after',
    }[currentStatus];
    const end = Date.parse(attempt.endedAt ?? attempt.lastActiveAt);
    return label && Number.isFinite(end - start) ? `${label} ${elapsedLabel(savedWorkTime(attempt))}` : '';
  }

  function updateBlockTimers() {
    if (document.hidden || state.connectionError) return;
    const now = Date.now();
    for (const timer of $('graph').querySelectorAll('[data-timer-start]')) {
      const text = elapsedLabel(now - Number(timer.dataset.timerStart));
      if (timer.textContent !== text) timer.textContent = text;
    }
  }

  function blockDescription(block, style) {
    const attempt = latest(block);
    if (isRunning(block) && attempt && !block.readOnly && !attempt.inputRequestedAt)
      return attempt.step || 'Preparing this block.';
    return attempt?.summary || block.prompt || blockContent(block)?.description || style.description;
  }

  function cardContents(block, style) {
    const attempt = latest(block);
    const currentStatus = status(block);
    const hasEvidence = attempt?.evidence?.length || 0;
    const description = blockDescription(block, style);
    const timing = blockTiming(block, attempt, currentStatus);
    const parts = {
      status: `<span class="block-topline"><span class="block-icon" aria-hidden="true">${style.icon}</span>${escape(words(block.kind))}<span class="block-status${isRunning(block) && !attempt?.inputRequestedAt ? ' running' : ''}">${timing || escape(statusText(currentStatus, attempt))}</span></span>`,
      title: `<span class="block-label">${escape(block.label || words(block.kind))}</span>`,
      description: `<span class="block-description">${escape(description)}</span>`,
      footer: `<span class="block-bottomline"><span>${escape(block.skill || (block.suggested ? 'Suggested next step' : 'Choose a skill'))}</span><span>${hasEvidence ? `${hasEvidence} evidence` : attempt ? `Attempt ${block.attempts.length}` : block.lane > 0 ? `Lane ${block.lane + 1}` : 'View details ↗'}</span></span>`,
    };
    return (
      '<span class="block-port top"></span>' + Object.values(parts).join('') + '<span class="block-port bottom"></span>'
    );
  }

  function blockCard(block) {
    const style = blockStyle(block.definition ?? block.kind);
    const entry = blockContent(block);
    const source = entry ? ` data-ui-source="${escape(entry.id)}"` : '';
    return `<button class="block-card${state.blockId === block.id ? ' selected' : ''}${block.suggested ? ' suggested' : ''}" style="--block-color:${style.color}" data-block="${escape(block.id)}"${source} data-node="${escape(block.id)}" aria-pressed="${state.blockId === block.id}">${cardContents(block, style)}</button>`;
  }

  function renderGraph() {
    const flow = state.view?.flow;
    $('graph').hidden = !flow;
    $('workspace-empty').hidden = !!flow;
    if (!flow) return;
    if (document.activeElement === $('starting-branch') && $('graph').dataset.issue === state.issueId) return;
    const blocks = flow.blocks || [];
    const target = flow.target || {};
    const branch = target.branch || 'Target branch';
    const branches = state.view.branches || [];
    const point = targetData().startingPoint;
    const fixedBase = flow.workspace?.base || target.base;
    const selectedRef =
      point?.ref ||
      (fixedBase ? '' : branches.find((item) => item.ref === `refs/remotes/${target.remote}/${branch}`)?.ref) ||
      (fixedBase ? '' : branches.find((item) => item.ref === `refs/heads/${branch}`)?.ref) ||
      '';
    const selectedBranch = branches.find((item) => item.ref === selectedRef);
    const pinnedCommit = point?.commit || fixedBase;
    const selectedLabel = point?.name || target.branch || 'Saved starting point';
    const options = branches.map((item) => {
      const selected = item.ref === selectedRef;
      const commit = selected && pinnedCommit ? pinnedCommit : item.commit;
      return `<option value="${escape(item.ref)}"${selected ? ' selected' : ''}>${escape(item.name)} · ${escape(commit?.slice(0, 8))}</option>`;
    });
    if (!selectedBranch)
      options.unshift(
        `<option value="${escape(selectedRef)}" selected>${escape(pinnedCommit ? `${selectedLabel} · ${pinnedCommit.slice(0, 8)}` : 'Choose a branch')}${point && !selectedBranch ? ' (unavailable)' : ''}</option>`
      );
    const startingNote =
      state.view.branchCatalogError ||
      (!branches.length
        ? 'No Git branches are available.'
        : state.view.startingPointEditable
          ? 'Changes the starting branch for this issue.'
          : 'Starting point is fixed after work begins.');
    const layers = graphLayers(blocks);
    const destination = destinationNode();
    const baseNode = `<div class="graph-terminal base" data-node="__base"><span class="terminal-label">Starting point</span><label class="starting-branch-label" for="starting-branch">Starting branch</label><select id="starting-branch" aria-describedby="starting-branch-note" title="Change the starting branch for this issue">${options.join('')}</select>${pinnedCommit ? `<span class="terminal-note starting-commit" title="${escape(pinnedCommit)}">Base ${escape(pinnedCommit.slice(0, 12))}</span>` : ''}${flow.workspace?.branch ? `<span class="terminal-note">${escape(flow.workspace.branch)}</span>` : ''}<span class="terminal-note" id="starting-branch-note">${escape(startingNote)}</span></div>`;
    $('graph').classList.toggle(
      'closed',
      state.view.issue.location === 'closed' || state.view.issue.state === 'closed'
    );
    $('graph').innerHTML =
      `<svg class="graph-lines" aria-hidden="true"></svg>${baseNode}${layers.map((row) => `<div class="graph-row">${row.map(blockCard).join('')}</div>`).join('')}<button class="graph-add" data-open-palette aria-label="Add a step" title="Add a step">＋</button>${destination}`;
    $('graph').dataset.issue = state.issueId;
    requestAnimationFrame(() => {
      drawConnections();
      const intent = state.graphScrollIntent;
      state.graphScrollIntent = null;
      if (intent) scrollToBlock(intent);
    });
  }

  function drawConnections() {
    const graph = $('graph');
    const svg = graph.querySelector('svg');
    if (!svg || graph.hidden || !state.view?.flow) return;
    svg.removeAttribute('style');
    const bounds = graph.getBoundingClientRect();
    const nodes = new Map([...graph.querySelectorAll('[data-node]')].map((node) => [node.dataset.node, node]));
    const blocks = state.view.flow.blocks;
    const edges = [];
    const parents = new Set();
    for (const block of blocks) {
      const dependencies = (block.after || []).filter((id) => nodes.has(id));
      if (dependencies.length) {
        for (const parent of dependencies) {
          edges.push([parent, block.id, block.suggested]);
          parents.add(parent);
        }
      } else edges.push(['__base', block.id, block.suggested]);
    }
    for (const block of blocks) if (!parents.has(block.id)) edges.push([block.id, '__destination', block.suggested]);
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${graph.scrollWidth} ${graph.scrollHeight}`);
    svg.style.width = `${graph.scrollWidth}px`;
    svg.style.height = `${graph.scrollHeight}px`;
    for (const [from, to, suggested] of edges) {
      const source = nodes.get(from)?.getBoundingClientRect();
      const target = nodes.get(to)?.getBoundingClientRect();
      if (!source || !target) continue;
      const x1 = source.left + source.width / 2 - bounds.left;
      const y1 = source.bottom - bounds.top;
      const x2 = target.left + target.width / 2 - bounds.left;
      const y2 = target.top - bounds.top;
      const middle = (y1 + y2) / 2;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', suggested ? '#484848' : '#575757');
      path.setAttribute('stroke-width', '1');
      if (suggested) path.setAttribute('stroke-dasharray', '4 4');
      svg.append(path);
    }
  }

  function scrollToBlock({ nodeId, mode }) {
    const node = [...$('graph').querySelectorAll('[data-node]')].find((item) => item.dataset.node === nodeId);
    if (!node) return;
    const scroll = $('graph-scroll');
    const bounds = scroll.getBoundingClientRect();
    const card = node.getBoundingClientRect();
    if (mode !== 'reveal') {
      const top =
        mode === 'start'
          ? card.top - bounds.top
          : mode === 'end'
            ? card.bottom - bounds.top - scroll.clientHeight
            : card.top + card.height / 2 - bounds.top - scroll.clientHeight / 2;
      scroll.scrollBy({
        top,
        left: card.left + card.width / 2 - bounds.left - scroll.clientWidth / 2,
        behavior: 'instant',
      });
      return;
    }
    const reveal = (start, end, visibleStart, visibleEnd) => {
      if (start >= visibleStart && end <= visibleEnd) return 0;
      if (start < visibleStart && end > visibleEnd) return 0;
      return start < visibleStart ? start - visibleStart : end - visibleEnd;
    };
    scroll.scrollBy({
      top: reveal(card.top, card.bottom, bounds.top, bounds.top + scroll.clientHeight),
      left: reveal(card.left, card.right, bounds.left, bounds.left + scroll.clientWidth),
      behavior: 'instant',
    });
  }

  function formField(name, label, value, placeholder = '', rows = 2) {
    return `<label class="field">${escape(label)}<textarea data-field="${escape(name)}" name="${escape(name)}" rows="${rows}" placeholder="${escape(placeholder)}">${escape(value)}</textarea></label>`;
  }

  function targetData() {
    const flow = state.view?.flow;
    return {
      delivery: flow
        ? { ...flow.target, branch: state.view.destination ? state.view.destination.branch : flow.target.branch }
        : null,
      startingPoint: flow?.startingPoint,
    };
  }

  function displayValue(value) {
    if (value === undefined || value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  }

  function typedInput(name, detail, value) {
    const fieldName = escape(name);
    const fieldValue = value ?? '';
    const type = detail.type || 'text';
    if (type === 'long text')
      return `<textarea name="${fieldName}" data-field="${fieldName}" rows="3">${escape(displayValue(fieldValue))}</textarea>`;
    if (type === 'choice')
      return `<select name="${fieldName}" data-field="${fieldName}"><option value="">Choose…</option>${(
        detail.options || []
      )
        .map(
          (option) =>
            `<option value="${escape(option)}"${String(fieldValue) === option ? ' selected' : ''}>${escape(option)}</option>`
        )
        .join('')}</select>`;
    if (type === 'boolean')
      return `<input type="checkbox" name="${fieldName}" data-field="${fieldName}" value="true"${fieldValue === true || fieldValue === 'true' ? ' checked' : ''} />`;
    if (type === 'filename') {
      const listId = 'repo-files-' + fieldName;
      const paths = state.repoFiles.get(state.issueId) || [];
      const selected = String(fieldValue || '');
      return `<input type="text" name="${fieldName}" data-field="${fieldName}" list="${escape(listId)}" value="${escape(selected)}" placeholder="Choose a file from this repository" /><datalist id="${escape(listId)}">${[
        ...(selected && !paths.includes(selected) ? [selected] : []),
        ...paths,
      ]
        .map((path) => `<option value="${escape(path)}"></option>`)
        .join('')}</datalist>`;
    }
    if (type === 'number')
      return `<input type="number" name="${fieldName}" data-field="${fieldName}" value="${escape(displayValue(fieldValue))}" />`;
    if (type === 'url')
      return `<input type="url" name="${fieldName}" data-field="${fieldName}" value="${escape(displayValue(fieldValue))}" />`;
    return `<input type="text" name="${fieldName}" data-field="${fieldName}" value="${escape(displayValue(fieldValue))}" />`;
  }

  function readonlyInput(name, detail, value, openFile = null) {
    const fieldName = escape(name);
    const fieldValue = value ?? '';
    const type = detail.type || 'text';
    if (detail.kind === 'file' || type === 'filename') {
      const path = detail.kind === 'file' || type === 'filename' ? (fieldValue?.path ?? fieldValue) : fieldValue;
      if (!path) return '<span class="inline-empty">Not produced yet</span>';
      const button = openFile
        ? `<button class="small-button" type="button" data-open-file="${escape(openFile)}">Inspect ↗</button>`
        : detail.kind === 'file'
          ? `<button class="small-button" type="button" data-open-file="${escape(path)}">Inspect ↗</button>`
          : detail.fileAvailable
            ? `<button class="small-button" type="button" data-open-flow-file="${escape(path)}">Inspect ↗</button>`
            : '';
      return `<div class="readonly-file"><input type="text" readonly value="${escape(displayValue(path))}" />${button}</div>`;
    }
    if (type === 'long text')
      return fieldValue === ''
        ? '<span class="inline-empty">Not produced yet</span>'
        : `<textarea readonly rows="3">${escape(displayValue(fieldValue))}</textarea>`;
    if (type === 'boolean')
      return `<input type="checkbox" disabled${fieldValue === true || fieldValue === 'true' ? ' checked' : ''} />`;
    if (type === 'choice') {
      const options = detail.options || [];
      const selected = String(fieldValue);
      return `<select disabled><option value=""${fieldValue === '' ? ' selected' : ''}>${fieldValue === '' ? 'Not produced yet' : 'Choose…'}</option>${options
        .map(
          (option) =>
            `<option value="${escape(option)}"${option === selected ? ' selected' : ''}>${escape(option)}</option>`
        )
        .join('')}</select>`;
    }
    if (type === 'url') {
      let href = '';
      try {
        const parsed = new URL(String(fieldValue));
        if (['http:', 'https:'].includes(parsed.protocol)) href = parsed.href;
      } catch {}
      return `<div class="readonly-file"><input type="url" readonly value="${escape(displayValue(fieldValue))}" placeholder="Not produced yet" />${href ? `<a class="small-button" href="${escape(href)}" target="_blank" rel="noopener noreferrer">Open ↗</a>` : ''}</div>`;
    }
    return `<input type="${type === 'number' ? 'number' : 'text'}" readonly value="${escape(displayValue(fieldValue))}" placeholder="Not produced yet" />`;
  }

  function outputsSection(block) {
    const outputs = block.outputs || [];
    return `<section class="detail-section"><div class="section-label">Outputs</div>${
      outputs.length
        ? outputs
            .map(
              (output) =>
                `<label class="field"><span>${escape(output.label)}</span>${readonlyInput(output.key, output, output.value)}</label>`
            )
            .join('')
        : '<p class="inline-empty">This block declares no outputs.</p>'
    }</section>`;
  }

  function declaredDetails(block, editable = false) {
    const fields = (block.details || []).filter((detail) => !detail.derived);
    if (!fields.length) return '';
    const request = fields.find((detail) => detail.requestId)?.requestId;
    return `<section class="detail-section"><div class="section-label">Inputs${request ? `<button type="button" class="small-button" data-block="${escape(request)}">Open Request</button>` : ''}</div>${fields
      .map((detail) => {
        const { key, label, value, candidates, selected } = detail;
        if (!editable || detail.fixed)
          return `<label class="field"><span>${escape(label)}</span>${readonlyInput(key, detail, value)}</label>`;
        const mode = draft()['mode-' + key] ?? detail.mode;
        const current = draft()['link-' + key] ?? selected;
        const choices = (candidates || [])
          .map(
            (item) =>
              `<option value="${escape(item.blockId)}"${current === item.blockId ? ' selected' : ''}>${escape(item.address + '.' + item.output)}</option>`
          )
          .join('');
        const modeControl = `<select name="mode-${escape(key)}" data-field="mode-${escape(key)}" aria-label="${escape(label + ' mode')}"><option value="manual"${mode === 'manual' ? ' selected' : ''}>Manual</option><option value="source"${mode === 'source' ? ' selected' : ''}${candidates?.length ? '' : ' disabled'}>Source</option></select>`;
        const control =
          mode === 'source'
            ? candidates?.length > 1
              ? `<select name="link-${escape(key)}" data-field="link-${escape(key)}" aria-label="${escape(label + ' source')}"><option value="">Choose a source</option>${choices}</select>${readonlyInput(key, detail, value)}`
              : candidates?.length === 1
                ? `<small>${escape(candidates[0].address + '.' + candidates[0].output)}</small>${readonlyInput(key, detail, value)}`
                : '<span class="inline-empty">No matching upstream output is available.</span>'
            : typedInput('input-' + key, detail, draft()['input-' + key] ?? value ?? '');
        return `<div class="field"><span>${escape(label)}</span>${modeControl}${control}</div>`;
      })
      .join('')}</section>`;
  }

  function definitionActions(block) {
    const definition = state.index.catalog.find((entry) => entry.id === (block.definition ?? block.kind));
    const path = definition?.content;
    return `<div class="block-actions definition-actions"><button class="small-button" type="button" data-action="refresh-definition" aria-label="Refresh block definition" title="Refresh block definition">🪄</button>${path?.bundled || path?.override ? `<details class="block-markdown-menu" data-preserve="block-markdown-menu"><summary class="small-button">Markdown</summary><div class="issue-flow-options"><button class="small-button" type="button" data-action="reveal-definition">Reveal Markdown in Finder</button><button class="small-button" type="button" data-action="open-block-extension">${path.extension ? 'Open extension' : 'Create extension'}</button></div></details>` : ''}</div>`;
  }

  async function checkOpenBlock(force = false) {
    const block = activeBlock();
    if (serverControlUI.isWaitingForServer()) return;
    if (!block || block.readOnly || state.pending || state.tab !== 'details' || state.view.flow.request) return;
    const key = state.issueId + ':' + block.id;
    if (key === state.checkedBlock && !force) return;
    state.checkedBlock = key;
    const result = await action('open-block', { blockId: block.id });
    if (!result?.details || activeBlock() !== block) return;
    if (result.revision < state.view.flow.revision) return;
    state.view.flow.revision = result.revision;
    if (JSON.stringify(block.details) !== JSON.stringify(result.details)) {
      block.details = result.details;
      renderInspector();
    }
  }

  function retiredHistory() {
    const blocks = (state.view.flow.retiredBlocks || []).filter((block) => block.attempts.length);
    if (!blocks.length) return '';
    return `<section class="detail-section"><details><summary>Blocks from earlier routes</summary>${blocks
      .map((block) => `<h3>${escape(block.label)}</h3>${block.attempts.map(attemptCard).join('')}`)
      .join('')}</details></section>`;
  }

  function saveRow() {
    const dirty = Object.keys(draft()).length > 0;
    return `<div class="save-row"><span id="draft-note" class="${dirty ? 'draft-note' : 'saved-note'}">${dirty ? 'Unsaved changes' : 'Saved locally'}</span><button type="submit" class="small-button" data-action="save"${state.pending ? ' disabled' : ''}>Save changes</button></div>`;
  }

  function requestDetails(block) {
    const flow = state.view.flow;
    const values = { ...block.data, ...draft() };
    const last = latest(block);
    const folders = [...new Set([...(state.index.folders || []), ...(flow.folder ? [flow.folder] : [])])];
    const definition = state.index.catalog.find((entry) => entry.id === (block.definition ?? block.kind));
    const open = state.view.issue.status !== 'closed';
    const disabled = open ? '' : ' disabled';
    const settings = `<label><input type="checkbox" id="retro-setting"${values.runRetro ? ' checked' : ''}${disabled}> Run a retro</label>${state.view.issue.state === 'needs-approval' ? '' : `<label><input type="checkbox" id="auto-close-setting"${flow.autoClose ? ' checked' : ''}${disabled}> Close as Fixed and remove the worktree after Factory Merge</label>`}`;
    return `<section class="detail-section"><div class="section-label">Inputs</div><form id="request-form">${formField('wording', 'Your words', values.wording, 'The original request.', 4)}${saveRow()}</form>${settings}</section>${outputsSection(block)}${definition?.prompt ? `<details class="detail-section system-prompt" data-preserve="system-prompt"><summary>System prompt</summary><div class="prompt-preview">${escape(definition.prompt)}</div></details>` : ''}${last ? `<section class="detail-section">${attemptCard(last, block.attempts.length - 1)}${block.attempts.length > 1 ? `<details class="attempt-history" data-preserve="attempt-history"><summary>Earlier requests</summary>${block.attempts.slice(0, -1).map(attemptCard).join('')}</details>` : ''}</section>` : ''}${retiredHistory()}<section class="detail-section"><div class="section-label">Organization</div><form id="issue-folder-form"><label class="field">Folder<select id="issue-folder" name="folder" data-field="folder"><option value="">No folder</option>${folders.map((folder) => `<option value="${escape(folder)}"${(values.folder ?? flow.folder) === folder ? ' selected' : ''}>${escape(folder)}</option>`).join('')}</select></label><button type="submit" class="small-button" data-action="folder">Move issue</button></form></section>`;
  }

  function skillOptions(block, selected) {
    const catalog = state.index.catalog.find((entry) => entry.id === (block.definition ?? block.kind));
    const skills = catalog?.skills || [];
    return skills
      .map(
        (skill) => `<option value="${escape(skill)}"${skill === selected ? ' selected' : ''}>${escape(skill)}</option>`
      )
      .join('');
  }

  function systemPromptEditor(block, values, locked) {
    const catalog = state.index.catalog.find((entry) => entry.id === (block.definition ?? block.kind));
    const skills = catalog?.skills || [];
    const mode = draft()['prompt-mode'] || (skills.includes(values.skill) ? 'skill' : 'text');
    const field =
      mode === 'skill'
        ? `<label class="field"><span>Allowed skill</span><select name="skill" data-field="skill"${locked}>${skillOptions(block, values.skill)}</select></label>`
        : formField('prompt', 'Prompt text', values.prompt, blockStyle(block.definition ?? block.kind).description, 4);
    return `<details class="system-prompt" data-preserve="system-prompt"><summary>System prompt <span class="muted-inline">${mode === 'skill' ? 'Skill' : 'Text'}</span></summary>${skills.length ? `<label class="field"><span>Use</span><select name="prompt-mode" data-field="prompt-mode"${locked}><option value="text"${mode === 'text' ? ' selected' : ''}>Text</option><option value="skill"${mode === 'skill' ? ' selected' : ''}>Allowed skill</option></select></label>` : ''}${field}${skills.length ? '<small>Only skills listed in this block type’s Markdown are available.</small>' : ''}</details>`;
  }

  function evidenceLinks(attempt) {
    return (state.view?.artifacts || [])
      .filter((artifact) => artifact.attemptId === attempt.id)
      .map(
        (artifact) =>
          `<button class="evidence-link" data-open-file="${escape(artifact.path)}" data-artifact-id="${escape(artifact.id)}"><span aria-hidden="true">▤</span><span>${escape(artifact.label)}</span></button>`
      )
      .join('');
  }

  function attemptCard(attempt, index) {
    const summary =
      attempt.summary ||
      (runningStatuses.has(attempt.status)
        ? 'This block is running. Its output will appear here.'
        : 'No summary was recorded.');
    let result = '';
    if (attempt.result)
      result = typeof attempt.result === 'string' ? attempt.result : JSON.stringify(attempt.result, null, 2);
    return `<div class="block-progress"><div class="progress-heading"><span>${statusIcon(attempt.status)} ${escape(statusText(attempt.status, attempt))}${attempt.invalidatedAt ? ' · Invalidated' : ''}</span><span class="progress-meta">Attempt ${index + 1}</span></div><p class="detail-copy">${escape(summary)}</p>${attempt.result?.pr ? prLink({ number: attempt.result.pr, url: attempt.result.url }) : ''}<p class="progress-meta" style="margin-top:9px">${escape(date(attempt.startedAt))}${attempt.endedAt ? ` · ended ${escape(date(attempt.endedAt))}` : ''}</p>${attempt.output ? `<pre class="attempt-output">${escape(attempt.output)}</pre>` : ''}${result && result !== summary ? `<pre class="attempt-output">${escape(result)}</pre>` : ''}${attempt.details?.length ? `<details data-preserve="details-${escape(attempt.id)}"><summary>Details used</summary><pre class="attempt-output">${escape(JSON.stringify(attempt.details, null, 2))}</pre></details>` : ''}${attempt.systemPrompt ? `<details data-preserve="prompt-${escape(attempt.id)}"><summary>System prompt used</summary><pre class="attempt-output">${escape(attempt.systemPrompt)}</pre></details>` : ''}${evidenceLinks(attempt)}</div>`;
  }

  function comments(block) {
    const entries = block.comments || [];
    return `<section class="detail-section"><div class="section-label">${block.kind === 'prototype' ? 'Prototype feedback' : 'Block notes'}</div>${entries.length ? `<div class="timeline">${entries.map((comment) => `<article class="message"><div class="message-meta"><span class="message-author">You</span><time>${escape(date(comment.at))}</time></div><p class="message-body">${escape(comment.text)}</p></article>`).join('')}</div>` : '<p class="inline-empty">No comments yet.</p>'}${commentForm(block)}</section>`;
  }

  function commentForm(block) {
    return `<form class="comment-composer" id="comment-form"><label class="field">${block.kind === 'prototype' ? 'What should change?' : 'Add a note'}<textarea name="comment" data-field="comment" rows="3" placeholder="Add context for this block…" required>${escape(draft().comment || '')}</textarea></label><button class="small-button" type="submit" data-action="comment"${state.pending ? ' disabled' : ''}>Save comment</button></form>`;
  }

  function editChecklist(block, changes) {
    if (block.kind !== 'edit') return '';
    const edits = changes.edits || block.edits || [];
    return `<section class="detail-section"><div class="section-label">Edits to apply</div>${edits.map((edit) => `<label class="check-row"><input type="checkbox" data-edit="${escape(edit.id)}"${edit.enabled !== false ? ' checked' : ''} /><span>${escape(edit.text)}</span></label>`).join('') || '<p class="inline-empty">Add an edit below. Checked edits will be included when this block runs.</p>'}<div class="edit-add"><input id="new-edit" data-field="newEdit" placeholder="Describe an edit…" aria-label="New edit" value="${escape(changes.newEdit || '')}" /><button type="button" class="small-button" data-add-edit>Add</button></div></section>`;
  }

  let blockContents = new Map();

  function blockContent(block) {
    return block?.readOnly ? undefined : blockContents.get(block?.definition ?? block?.kind);
  }

  document.addEventListener('factory-ui-sources', (event) => {
    const previous = blockContents;
    blockContents = new Map(
      event.detail.filter((entry) => entry.document).map((entry) => [entry.id.split('/').at(-1), entry])
    );
    for (const block of state.view?.flow?.blocks ?? []) {
      const key = block.definition ?? block.kind;
      const entry = blockContent(block);
      if (entry?.description === previous.get(key)?.description && entry?.id === previous.get(key)?.id) continue;
      const element = $('graph').querySelector(`[data-block="${CSS.escape(block.id)}"]`);
      if (!element) continue;
      if (entry) element.dataset.uiSource = entry.id;
      else element.removeAttribute('data-ui-source');
      element.querySelector('.block-description').textContent = blockDescription(block, blockStyle(key));
    }
    const block = activeBlock();
    const entry = blockContent(block);
    const prose = $('inspector-body').querySelector('.block-content');
    if (prose && !entry) prose.remove();
    else if (prose && entry && prose.innerHTML !== entry.inspectorHtml) {
      prose.dataset.uiSource = entry.id;
      preserveDisclosures(prose, () => {
        prose.innerHTML = entry.inspectorHtml;
      });
    } else if (state.tab === 'details' && block && !block.readOnly && !prose && entry) {
      renderInspector();
    }
  });

  function contentSection(block) {
    const entry = blockContent(block);
    return entry
      ? `<section class="detail-section block-content" data-ui-source="${escape(entry.id)}">${entry.inspectorHtml}</section>`
      : '';
  }

  function cleanupResults(attempt) {
    return (attempt?.result?.results || [])
      .map((item) => {
        const retry =
          ['failed', 'preserved'].includes(item.status) && !state.view.closureBusy
            ? `<button class="small-button" type="button" data-cleanup-retry="${escape(item.id)}">Retry</button>`
            : '';
        return `<p>${escape(item.name || item.kind || 'Resource')} · ${escape(item.reason)} ${retry}</p>`;
      })
      .join('');
  }

  function blockDetails(block) {
    if (state.view.flow.request)
      return '<section class="detail-section"><p class="detail-copy">Restart the Factory server to edit this flow. Your saved issue is available.</p></section>';
    if (block.readOnly)
      return `<section class="detail-section"><p class="detail-copy">This operation started through the existing issue controls. Inspect or stop it there before starting a new flow block.</p><a href="/classic?issue=${encodeURIComponent(state.issueId)}">Open its original controls</a>${block.attempts.map(attemptCard).join('')}</section>`;
    if (block.kind === 'request') return definitionActions(block) + requestDetails(block) + contentSection(block);
    const changes = draft();
    const values = { ...block, ...changes };
    const attempts = block.attempts || [];
    const last = latest(block);
    const running = isRunning(block);
    if (['retro', 'cleanup'].includes(block.kind))
      return `<section class="detail-section">${last ? attemptCard(last, attempts.length - 1) : '<p>This block runs during Close.</p>'}${block.kind === 'cleanup' ? cleanupResults(last) : ''}${attempts.length > 1 ? `<details><summary>Earlier attempts</summary>${attempts.slice(0, -1).map(attemptCard).join('')}</details>` : ''}</section>`;
    const locked = state.pending ? ' disabled' : '';
    const sections = {
      settings: `<form id="block-form">${declaredDetails(block, true)}${outputsSection(block)}${systemPromptEditor(block, values, locked)}${editChecklist(block, changes)}<section class="detail-section"><div class="section-label">Block settings</div><label class="field">Name<input name="label" data-field="label" value="${escape(values.label || '')}" /></label><div class="field-row"><label class="field">Parallel lane<select name="lane" data-field="lane">${[0, 1, 2, 3].map((lane) => `<option value="${lane}"${Number(values.lane || 0) === lane ? ' selected' : ''}>${lane === 0 ? 'Main lane' : `Parallel lane ${lane + 1}`}</option>`).join('')}</select></label>${block.kind === 'sol' ? `<label class="field">Iterations<input type="number" name="iterations" data-field="iterations" min="1" max="20" value="${escape(values.iterations || 1)}" /></label>` : ''}</div></section>${saveRow()}</form>`,
      progress: `<section class="detail-section"><div class="section-label">${running ? 'Current progress' : 'Progress'}<span data-ui-value="Status comes from the saved block.">${escape(statusText(status(block), last))}</span></div>${last ? attemptCard(last, attempts.length - 1) : `<p class="inline-empty">This block has not run yet. Review its inputs before starting.</p>`}${attempts.length > 1 ? `<details class="attempt-history" data-preserve="attempt-history"><summary>${attempts.length - 1} earlier ${attempts.length === 2 ? 'attempt' : 'attempts'}</summary>${attempts.slice(0, -1).map(attemptCard).join('')}</details>` : ''}</section>`,
      sequence: `<section class="detail-section"><div class="section-label">Sequence</div><p class="detail-copy">Move this step toward the destination or toward the starting point.</p><div class="block-actions"><button class="small-button" data-action="move" data-direction="down"${locked}>↑ Earlier</button><button class="small-button" data-action="move" data-direction="up"${locked}>↓ Later</button></div></section>`,
      notes: comments(block),
    };
    return definitionActions(block) + Object.values(sections).join('') + contentSection(block);
  }

  function renderConversation(block) {
    const messages = state.view?.conversation || [];
    return `<p class="conversation-context">This issue’s conversation shows notes and responses from its blocks.</p>${messages.length ? `<div class="timeline">${messages.map((message) => `<article class="message"><div class="message-meta"><span class="message-author">${escape(message.actor || message.role || 'Factory')}${message.blockId ? ` · ${escape(state.view.flow.blocks.find((entry) => entry.id === message.blockId)?.label || 'Block')}` : ''}</span><time>${escape(date(message.at))}</time></div><p class="message-body">${escape(message.body)}</p></article>`).join('')}</div>` : '<p class="inline-empty">No conversation entries yet. Starting a block will retain its activity here.</p>'}${block ? commentForm(block) : ''}`;
  }

  function renderArtifacts(block, artifacts) {
    if (!block) return '<p class="inline-empty">Select a block to see its artifacts.</p>';
    const cards = (attempt) =>
      Object.entries(attempt.artifacts?.values || {})
        .map(
          ([key, value]) =>
            `<article class="artifact"><h3>${escape(key)}</h3><pre class="detail-value">${escape(displayValue(value))}</pre></article>`
        )
        .join('') +
      artifacts
        .filter((artifact) => artifact.attemptId === attempt.id)
        .map(
          (artifact) =>
            `<article class="artifact"><div class="artifact-header"><h3>${escape(artifact.label)}</h3></div><p class="artifact-path">${escape(artifact.path)}</p><div class="artifact-actions"><button class="small-button" data-open-file="${escape(artifact.path)}" data-artifact-id="${escape(artifact.id)}">Inspect ↗</button><button class="small-button danger-button" data-delete-artifact="${escape(artifact.id)}"${state.pending ? ' disabled' : ''}>Delete</button></div></article>`
        )
        .join('');
    const attempts = block.attempts;
    const current = attempts.length ? cards(attempts.at(-1)) : '';
    const previous = attempts
      .slice(0, -1)
      .map((attempt, index) => {
        const saved = cards(attempt);
        return saved
          ? `<details class="attempt-history" data-artifact-run="${escape(attempt.id)}"><summary>Previous artifacts · Run ${index + 1}</summary>${saved}</details>`
          : '';
      })
      .reverse()
      .join('');
    return (current || '<p class="inline-empty">No artifacts from the latest run.</p>') + previous;
  }

  function preserveDisclosures(container, replace) {
    const key = (element) =>
      element.dataset.preserve ?? element.dataset.artifactRun ?? element.querySelector('summary')?.textContent.trim();
    const saved = new Map([...container.querySelectorAll('details')].map((element) => [key(element), element.open]));
    replace();
    for (const element of container.querySelectorAll('details')) {
      const open = saved.get(key(element));
      if (open !== undefined) element.open = open;
    }
  }

  function preserveEditor(renderBody) {
    const body = $('inspector-body');
    const current = document.activeElement;
    const focused = body.contains(current) && current instanceof HTMLElement;
    const key = focused ? current.dataset.field || current.id || current.dataset.edit : null;
    const selection =
      focused && typeof current.selectionStart === 'number' ? [current.selectionStart, current.selectionEnd] : null;
    const scroll = body.scrollTop;
    const outputScroll = body.querySelector('.attempt-output')?.scrollTop;
    preserveDisclosures(body, renderBody);
    if (key) {
      const replacement = [...body.querySelectorAll('[data-field], [id], [data-edit]')].find(
        (element) => (element.dataset.field || element.id || element.dataset.edit) === key
      );
      if (replacement) {
        replacement.focus({ preventScroll: true });
        if (selection && replacement.setSelectionRange) replacement.setSelectionRange(...selection);
      }
    }
    body.scrollTop = scroll;
    if (outputScroll != null && body.querySelector('.attempt-output'))
      body.querySelector('.attempt-output').scrollTop = outputScroll;
  }

  function renderBlockRunControl(block) {
    const runButton = $('run-block');
    const running = isRunning(block);
    const recovering = block?.attempts.some(
      (attempt) => !attempt.reconciledAt && ['running', 'stopping', 'uncertain'].includes(attempt.status)
    );
    const retrying = ['blocked', 'failed', 'stopped'].includes(status(block));
    const continuing = recovering || retrying;
    runButton.hidden =
      !block ||
      block.readOnly ||
      Boolean(state.view.flow.request) ||
      state.view.issue.state === 'needs-approval' ||
      (!running && ['retro', 'cleanup'].includes(block.kind)) ||
      (block.kind === 'close' && state.view.issue.status === 'closed');
    runButton.dataset.action = running ? 'stop' : continuing ? 'continue' : 'start';
    runButton.textContent = running
      ? '■ Stop'
      : recovering
        ? 'Recover'
        : mergeApproval(block)
          ? 'Approve merge'
          : retrying
            ? 'Retry'
            : '▷ Run';
    runButton.classList.toggle('danger-button', running);
  }

  function blockDeletionReason(block) {
    if (!block) return 'Select a block.';
    if (block.kind === 'request') return 'Request is required for the issue flow.';
    if (block.readOnly) return 'Manage this operation from its original controls.';
    const closing = state.view?.flow.closing;
    if (closing && !closing.complete) return 'Finish the closure sequence before deleting blocks.';
    if (isRunning(block) || status(block) === 'uncertain') return 'Stop or reconcile the block before deleting it.';
    return '';
  }

  function renderBlockDeletion(block) {
    const button = $('delete-block');
    button.hidden = !block;
    button.title = blockDeletionReason(block) || 'Delete block';
  }

  function renderInspector() {
    const block = activeBlock();
    const style = blockStyle(block?.definition ?? block?.kind);
    $('inspector-kind').textContent = block ? words(block.kind) : 'Block details';
    $('inspector-title').style.setProperty('--block-color', style.color);
    $('inspector-symbol').textContent = block ? style.icon : '◇';
    $('inspector-block-name').textContent = block?.label || 'Select a block';
    renderBlockRunControl(block);
    renderBlockDeletion(block);
    setBusy(state.pending);
    const artifacts = (state.view?.artifacts || []).filter((artifact) => artifact.blockId === block?.id);
    $('artifact-count').textContent = artifacts.length || '';
    for (const button of document.querySelectorAll('[data-tab]'))
      button.setAttribute('aria-selected', String(button.dataset.tab === state.tab));
    const body = $('inspector-body');
    body.setAttribute('aria-labelledby', `tab-${state.tab}`);
    const scope = JSON.stringify([state.issueId, block?.id, state.tab]);
    const html = !state.view
      ? '<div class="inspector-empty"><span aria-hidden="true">↖</span><p>Select an issue and a block to inspect its intent, progress and evidence.</p></div>'
      : state.tab === 'artifacts'
        ? renderArtifacts(block, artifacts)
        : state.tab === 'conversation'
          ? renderConversation(block)
          : block
            ? blockDetails(block)
            : '<p class="inline-empty">Add a block to begin this issue.</p>';
    if (inspectorRender?.scope === scope) {
      if (inspectorRender.html === html) return;
      preserveEditor(() => {
        body.innerHTML = html;
      });
    } else {
      body.innerHTML = html;
      body.scrollTop = 0;
    }
    inspectorRender = { scope, html };
  }

  function renderPlayback(blocks) {
    const playback = state.view?.autoplay;
    const playing = playback?.mode === 'playing' || playback?.mode === 'waiting';
    const waiting = blocks.find((block) => playback?.mode === 'waiting' && playback.blockId === block.id);
    $('issue-playback').textContent = playing ? 'Ⅱ Pause' : '▷ Play';
    $('issue-playback').setAttribute('aria-label', playing ? 'Pause issue' : 'Play issue');
    const waitingButton = $('waiting-block');
    waitingButton.hidden = !waiting;
    waitingButton.textContent = waiting ? waiting.label + ' needs confirmation' : '';
    waitingButton.dataset.block = waiting?.id || '';
    $('playback-status').textContent =
      state.view?.flow?.closing?.error || (waiting ? '' : playback?.reason || (playing ? 'Playing' : 'Paused'));
  }

  function render() {
    renderSidebar();
    const issue = state.view?.issue;
    $('issue-heading').hidden = !issue;
    $('issue-type-label').textContent = issue
      ? words(
          state.view.flow.blocks.find((block) => block.kind === 'request')?.data?.fields?.type ||
            state.view.flow.routeType ||
            state.view.flow.type ||
            'Issue'
        ) + ' ·'
      : '';
    $('issue-number').textContent = issue?.issueNumber ? `#${issue.issueNumber}` : issue ? 'Issue flow' : 'Issue flow';
    $('issue-title').textContent = issue?.title || '';
    if ($('rename-issue-form').dataset.issue !== issue?.id) closeRename();
    renderFlowPicker();
    const blocks = state.view?.flow?.blocks || [];
    const running = blocks.find((block) => isRunning(block));
    const completed = blocks.filter((block) => ['completed', 'succeeded', 'success'].includes(status(block))).length;
    $('issue-subtitle').textContent = issue
      ? `${words(issue.status || 'new')}${closureLabel(issue)} · ${blocks.length} blocks${completed ? ` · ${completed} completed` : ''}${running ? ` · ${running.label} running` : ''}`
      : '';
    renderPlayback(blocks);
    $('flow-footer-label').textContent = running
      ? `${running.label} is running`
      : state.view
        ? 'Saved flow'
        : 'Changes are saved locally';
    renderEnvironment();
    renderGraph();
    checkOpenPublication();
    renderInspector();
    renderErrors();
    setBusy(state.pending);
  }

  function closureLabel(issue) {
    return issue.status === 'closed' && issue.closure ? ` · ${issue.closure.label}` : '';
  }

  function renderFlowPicker() {
    const definitions = state.view?.flowDefinitions;
    $('issue-flow-picker').hidden = !definitions;
    $('rebuild-flow').hidden = !definitions;
    if (!definitions) return;
    const current = state.view.flow.definition.id;
    $('issue-flow-name').textContent = definitions.current;
    $('rebuild-flow').dataset.updated = String(definitions.updated);
    $('rebuild-flow').title = definitions.updated
      ? 'Rebuild from the changed Markdown'
      : 'Rebuild from the linked Markdown';
    const selectors = definitions.available.map(
      ({ id, name }) =>
        `<button class="small-button" type="button" data-action="select-flow" data-flow-id="${escape(id)}"${id === current ? ' aria-current="true"' : ''}>${id === current ? '✓ ' : ''}${escape(name)}</button>`
    );
    const options = [];
    if (definitions.reveal)
      options.push('<button class="small-button" type="button" data-action="reveal-flow">Reveal in Finder</button>');
    options.push(
      '<button class="small-button" type="button" data-action="open-export-flow">Save as user flow</button>',
      `<div class="issue-flow-selectors" role="group" aria-label="Flows for this issue type">${selectors.join('')}</div>`
    );
    for (const error of definitions.errors) options.push(`<span>${escape(error)}</span>`);
    const html = options.join('');
    const list = $('issue-flow-options');
    if (list.dataset.html !== html) {
      list.innerHTML = html;
      list.dataset.html = html;
    }
  }

  async function flowDefinitionAction(button) {
    const name = button.dataset.action;
    $('issue-flow-picker').open = false;
    if (name === 'open-export-flow') {
      const { current, exportSuggestion } = state.view.flowDefinitions;
      $('export-flow-form').elements.namedItem('name').value = current;
      $('export-flow-id').value = exportSuggestion.flowId;
      $('export-flow-path').dataset.directory = exportSuggestion.directory;
      renderExportFlowPath();
      $('export-flow-error').hidden = true;
      $('export-flow-dialog').showModal();
      return;
    }
    const result = await action(name, name === 'select-flow' ? { flowId: button.dataset.flowId } : {});
    if (result && name === 'rebuild-flow') toast('Flow rebuilt.');
  }

  function renderExportFlowPath() {
    const path = $('export-flow-path');
    path.textContent = path.dataset.directory + '/' + ($('export-flow-id').value || 'flow-name') + '.md';
  }

  function openCapture() {
    $('capture-error').hidden = true;
    $('capture-dialog').showModal();
    $('capture-description').focus();
  }

  function openPalette() {
    if (!state.view) return;
    $('block-palette').innerHTML =
      (state.index.catalog || [])
        .filter((kind) => !['request', 'retro', 'cleanup'].includes(kind.kind))
        .map((kind) => {
          const style = blockStyle(kind.id);
          return `<button class="palette-item" style="--block-color:${style.color}" data-add-kind="${escape(kind.id)}"${state.pending ? ' disabled' : ''}><strong><span class="block-icon" aria-hidden="true">${style.icon}</span>${escape(kind.label)}</strong><small>${escape(kind.description || style.description)}</small></button>`;
        })
        .join('') ||
      '<p class="inline-empty">The block catalog is unavailable. Refresh the workspace to try again.</p>';
    const errors = state.index.catalogErrors || [];
    $('block-palette-error').textContent = errors.join('\n');
    $('block-palette-error').hidden = !errors.length;
    $('palette-dialog').showModal();
  }

  async function addBlock(kind) {
    const selected = activeBlock();
    const result = await action('add', {
      kind,
      ...(selected && !selected.suggested && kind !== 'update-branch' ? { afterId: selected.id } : {}),
    });
    if (!result) return;
    $('palette-dialog').close();
    toast('Block added. Choose its skill and start it when ready.');
    await load(true);
  }

  async function saveRequest(event) {
    event.preventDefault();
    const key = draftKey();
    const values = new FormData(event.target);
    const wording = String(values.get('wording') || '');
    toast('Clarifying the request…');
    const result = await action('request', { wording });
    if (!result) return;
    state.drafts.delete(key);
    renderInspector();
  }

  async function saveBlock(event) {
    event.preventDefault();
    const block = activeBlock();
    if (!block) return;
    const key = draftKey();
    const values = new FormData(event.target);
    const promptMode = values.get('prompt-mode') || 'text';
    const changes = {
      label: String(values.get('label') || ''),
      skill: promptMode === 'skill' ? values.get('skill') || null : null,
      prompt: promptMode === 'text' ? String(values.get('prompt') || '') : '',
      lane: Number(values.get('lane') || 0),
    };
    changes.inputs = {};
    changes.links = {};
    for (const detail of (block.details || []).filter((item) => item.input && !item.fixed)) {
      const mode = values.get('mode-' + detail.key) || detail.mode;
      if (mode === 'manual') {
        const field = event.target.elements.namedItem('input-' + detail.key);
        if (!field) continue;
        let value = field.type === 'checkbox' ? field.checked : field.value;
        if (detail.type === 'number' && value !== '') value = Number(value);
        changes.inputs[detail.key] = value;
      } else {
        const selected = values.get('link-' + detail.key) || detail.selected;
        if (detail.candidates?.length > 1 && !selected) {
          showError(`Choose a source for ${detail.label}, or switch it to Manual.`);
          return;
        }
        if (selected) changes.links[detail.key] = selected;
      }
    }
    if (block.kind === 'sol') changes.iterations = Number(values.get('iterations') || 1);
    if (block.kind === 'edit') changes.edits = draft().edits || block.edits || [];
    const result = await action('update', { blockId: block.id, changes });
    if (!result) return;
    const comment = state.drafts.get(key)?.comment;
    state.drafts.delete(key);
    if (comment) state.drafts.set(key, { comment });
    toast('Block settings saved.');
    await load(true);
  }

  let publishReview;

  function publicationBasis(blockId) {
    const block = state.view?.flow?.blocks.find((entry) => entry.id === blockId);
    const request = state.view?.flow?.blocks.find((entry) => entry.kind === 'request');
    return JSON.stringify([
      state.view?.issue?.title,
      state.view?.destination?.branch,
      state.view?.destination?.proposedBranch,
      state.view?.environment?.head,
      state.view?.environment?.dirty,
      request?.data?.editId,
      ...['goal', 'requestedProof', 'wording'].map(
        (key) => block?.details?.find((detail) => detail.key === key)?.value
      ),
    ]);
  }

  function checkOpenPublication() {
    const review = publishReview;
    if (
      review &&
      $('publish-dialog').open &&
      review.preview &&
      !state.pending &&
      review.issueId === state.issueId &&
      review.basis !== publicationBasis(review.blockId)
    )
      void reviewPublication();
  }

  function openPublication(block, continuing) {
    publishReview = { issueId: state.issueId, blockId: block.id, continuing };
    $('publish-dialog').showModal();
    return reviewPublication();
  }

  async function reviewPublication(confirming = false) {
    const review = publishReview;
    if (!review || review.issueId !== state.issueId || state.pending) return;
    const token = review.preview?.token;
    const basis = publicationBasis(review.blockId);
    review.preview = null;
    $('confirm-publish').hidden = true;
    $('publish-error').hidden = true;
    $('publish-preview').textContent = 'Checking the issue commit and GitHub destination…';
    const result = await action(
      confirming ? 'confirm-publish' : 'preview-publish',
      { blockId: review.blockId, previewToken: token, continue: review.continuing },
      { errorId: 'publish-error' }
    );
    if (publishReview !== review || !$('publish-dialog').open) {
      if (result?.accepted) await load(true);
      return;
    }
    if (result?.accepted) {
      review.confirmed = true;
      $('publish-dialog').close();
      await load(true);
      return;
    }
    if (result?.previewChanged) {
      await load(true);
      return reviewPublication();
    }
    const preview = result?.publication;
    review.preview = preview;
    review.basis = basis;
    if (!preview) {
      $('publish-preview').replaceChildren();
      return;
    }
    const changed =
      confirming && preview.token !== token && preview.status === 'confirm'
        ? '<p>The publication changed. Review the updated preview.</p>'
        : '';
    let contents;
    if (preview.status === 'blocked') {
      contents = `<p>${escape(preview.message)}</p>`;
    } else if (preview.status === 'current') {
      contents = '<p>PR is up to date.</p>';
    } else {
      contents = `<p><strong>${escape(preview.title)}</strong></p>
        <p>${escape(preview.branch)} → ${escape(preview.target)}</p>
        ${
          preview.pr
            ? `<ul>${preview.rename ? `<li>Title changes from “${escape(preview.previousTitle)}” to “${escape(preview.title)}”.</li>` : ''}
              ${preview.push ? `<li>Commit changes from <code>${escape(preview.previousHead)}</code> to <code>${escape(preview.head)}</code>.</li>` : ''}</ul>`
            : `<p>Issue commit <code>${escape(preview.head)}</code></p>
              <h3>PR description</h3><pre id="publish-description" class="detail-value"></pre>`
        }`;
    }
    $('publish-preview').innerHTML = changed + contents + (preview.pr ? `<p>${prLink(preview.pr)}</p>` : '');
    const description = $('publish-description');
    if (description) description.textContent = preview.body;
    const canConfirm = preview.status === 'confirm' || preview.status === 'current';
    $('confirm-publish').hidden = !canConfirm;
    $('confirm-publish').textContent =
      preview.status === 'current' ? 'Confirm current PR' : preview.pr ? 'Update PR' : 'Publish PR';
    $('close-publish').textContent = canConfirm ? 'Cancel' : 'Close';
  }

  function closeRename() {
    $('rename-issue-form').hidden = true;
    $('issue-title').parentElement.hidden = false;
    delete $('rename-issue-form').dataset.issue;
  }

  function mergeApproval(block) {
    return block?.kind === 'merge' && status(block) === 'blocked' ? latest(block)?.result?.mergeConfirmation : null;
  }

  async function startBlock(name, block) {
    const unsaved = Object.keys(draft()).filter((key) => !['comment', 'newEdit'].includes(key));
    if (unsaved.length) {
      showError('Save your block settings before starting. Your draft is still here.');
      return;
    }
    const approval = mergeApproval(block);
    if (block.kind === 'close') return openClosure();
    const confirmations = {
      merge:
        approval &&
        `Merge PR #${approval.pr} into ${approval.branch}?\n\nPR commit: ${approval.head}\nTarget revision: ${approval.target}`,
      close: `Close "${state.view.issue.title}"? This records your decision to end this issue.`,
      'delete-worktree': worktreeDeletionPrompt(state.view.flow.workspace?.checkout),
    };
    if (block.kind === 'publish') return openPublication(block, name === 'continue');
    const confirmed = Boolean(confirmations[block.kind]);
    if (confirmed && !confirm(confirmations[block.kind])) {
      if (state.view.autoplay?.blockId === block.id) await action('cancel-confirmation', { blockId: block.id });
      return;
    }
    const result = await action(block.kind === 'request' ? 'run-request' : name, {
      blockId: block.id,
      ...(confirmed ? { confirmed: true } : {}),
      ...(approval ? { mergeToken: approval.token } : {}),
    });
    if (result) await load(true);
  }

  function worktreeDeletionPrompt(path = 'No checkout path is recorded.') {
    return `Delete this issue worktree, its local branch, and its local conversation files?\n\n${path}\n\nReview the artifacts before proceeding.`;
  }

  async function deleteWorktree() {
    const issueId = state.issueId;
    const expected = await action('delete-worktree');
    if (!expected || state.issueId !== issueId || !confirm(worktreeDeletionPrompt(expected.path))) return;
    if (await action('delete-worktree', { expected })) toast('Worktree deleted.');
  }

  async function blockAction(button) {
    const block = activeBlock();
    if (!block) return;
    const name = button.dataset.action;
    if (['start', 'continue'].includes(name)) return startBlock(name, block);
    if (['refresh-definition', 'open-block-extension', 'reveal-definition'].includes(name)) {
      await action(name, { blockId: block.id });
      return;
    }
    if (
      name === 'remove' &&
      !confirm(`Remove the "${block.label}" block from this flow? Its completed work may still exist in the checkout.`)
    )
      return;
    if (!['move', 'remove', 'stop'].includes(name)) return;
    const result = await action(name, {
      blockId: block.id,
      ...(name === 'move' ? { direction: button.dataset.direction } : {}),
    });
    if (result) await load(true);
  }

  async function postComment(event) {
    event.preventDefault();
    const block = activeBlock();
    const text = String(new FormData(event.target).get('comment') || '').trim();
    if (!text || !block) return;
    const key = draftKey();
    const result = await action('comment', { blockId: block.id, text });
    if (!result) return;
    const saved = state.drafts.get(key) || {};
    delete saved.comment;
    state.drafts.set(key, saved);
    toast('Comment saved.');
    await load(true);
  }

  async function inspectFile(path, artifactId, flowFile = false) {
    const file = { artifactId, issueId: state.issueId, raw: '', restatement: null, request: null };
    inspectedFile = file;
    $('file-title').textContent = path;
    $('file-content').textContent = 'Reading artifact…';
    $('file-restate').checked = false;
    $('file-restate').disabled = true;
    $('file-restate-control').hidden = !artifactId;
    if (!$('file-dialog').open) $('file-dialog').showModal();
    try {
      const result = await json(
        flowFile
          ? `/api/flow-file?issue=${encodeURIComponent(file.issueId)}&path=${encodeURIComponent(path)}`
          : `/api/shown-file?path=${encodeURIComponent(path)}`
      );
      if (result.error) throw new Error(result.error);
      if (inspectedFile !== file) return;
      file.raw = result.content ?? result.file?.content ?? '';
      $('file-content').textContent = file.raw || 'This artifact is empty.';
      $('file-restate').disabled = !file.raw.trim();
    } catch (error) {
      if (inspectedFile === file) $('file-content').textContent = error.message;
    }
  }

  async function restateFile() {
    const file = inspectedFile;
    if (!file) return;
    const toggle = $('file-restate');
    const output = $('file-content');
    if (!toggle.checked) {
      output.textContent = file.raw;
      return;
    }
    if (file.restatement !== null) {
      output.textContent = file.restatement;
      return;
    }
    output.textContent = 'Restating in plain language…';
    file.request ||= json('/api/flow-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-factory-action': 'manual' },
      body: JSON.stringify({ action: 'restate-artifact', issueId: file.issueId, artifactId: file.artifactId }),
    });
    try {
      const result = await file.request;
      file.restatement = result.restatement;
      if (inspectedFile === file && toggle.checked) output.textContent = file.restatement;
    } catch (error) {
      if (inspectedFile === file && toggle.checked) output.textContent = error.message;
    } finally {
      file.request = null;
    }
  }

  async function deleteArtifact(id) {
    const artifact = state.view?.artifacts?.find((item) => item.id === id);
    if (!artifact) return;
    if (!confirm(`Permanently delete this artifact?\n\n${artifact.path}\n\nThis cannot be undone.`)) return;
    const result = await action('delete-artifact', { artifactId: id, confirmed: true });
    if (result) {
      toast('Artifact deleted.');
      await load(true);
    }
  }

  function columnLayout() {
    const width = window.innerWidth;
    if (width <= 540) return { sidebar: { min: 100, max: Math.max(100, Math.min(220, width - 230)), initial: 124 } };
    if (width <= 930) return { sidebar: { min: 160, max: Math.min(360, width - 300), initial: 190 } };
    return {
      sidebar: { min: 180, max: width <= 1180 ? 420 : 520, initial: width <= 1180 ? 205 : width >= 1650 ? 264 : 242 },
      inspector: { min: 280, max: 680, initial: width <= 1180 ? 335 : width >= 1650 ? 435 : 390 },
      available: $('app').clientWidth - (width <= 1180 ? 310 : width >= 1650 ? 460 : 380),
    };
  }

  function columnBounds(name, layout = columnLayout()) {
    const bounds = layout[name];
    if (!layout.inspector) return bounds;
    const other = name === 'sidebar' ? 'inspector' : 'sidebar';
    return {
      ...bounds,
      max: Math.min(bounds.max, layout.available - document.querySelector(`.${other}`).getBoundingClientRect().width),
    };
  }

  function applyColumnWidth(name, width, bounds) {
    const { min, max, initial } = bounds;
    const value = Math.round(Math.max(min, Math.min(max, width ?? initial)));
    $('app').style.setProperty(`--${name}-width`, `${value}px`);
    return value;
  }

  function updateColumnHandles() {
    const layout = columnLayout();
    for (const name of ['sidebar', 'inspector']) {
      if (!layout[name]) continue;
      const { min, max } = columnBounds(name, layout);
      const value = Math.round(document.querySelector(`.${name}`).getBoundingClientRect().width);
      const handle = $(`${name}-resizer`);
      handle.setAttribute('aria-valuemin', min);
      handle.setAttribute('aria-valuemax', Math.floor(max));
      handle.setAttribute('aria-valuenow', value);
      handle.setAttribute('aria-valuetext', `${value} pixels`);
    }
  }

  function resizeColumns() {
    const layout = columnLayout();
    const sidebar = applyColumnWidth('sidebar', state.sidebarWidth, {
      ...layout.sidebar,
      max: layout.inspector
        ? Math.min(layout.sidebar.max, layout.available - layout.inspector.min)
        : layout.sidebar.max,
    });
    if (layout.inspector) {
      applyColumnWidth('inspector', state.inspectorWidth, {
        ...layout.inspector,
        max: Math.min(layout.inspector.max, layout.available - sidebar),
      });
    }
    updateColumnHandles();
  }

  function resizeColumn(name, width) {
    const value = applyColumnWidth(name, width, columnBounds(name));
    state[`${name}Width`] = value;
    updateColumnHandles();
    return value;
  }

  for (const [name, direction] of [
    ['sidebar', 1],
    ['inspector', -1],
  ]) {
    const resizer = $(`${name}-resizer`);
    const key = `factory-flow-${name}-width`;
    let drag = null;
    try {
      const saved = Number(localStorage.getItem(key));
      if (saved > 0 && Number.isFinite(saved)) state[`${name}Width`] = saved;
    } catch {}
    const saveWidth = () => {
      try {
        localStorage.setItem(key, String(state[`${name}Width`]));
      } catch {}
    };
    resizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !columnLayout()[name]) return;
      event.preventDefault();
      drag = {
        pointerId: event.pointerId,
        x: event.clientX,
        width: document.querySelector(`.${name}`).getBoundingClientRect().width,
      };
      resizer.setPointerCapture(event.pointerId);
      $('app').classList.add('resizing');
      resizer.focus({ preventScroll: true });
    });
    resizer.addEventListener('pointermove', (event) => {
      if (drag?.pointerId !== event.pointerId) return;
      resizeColumn(name, drag.width + direction * (event.clientX - drag.x));
    });
    const finishResize = (event) => {
      if (drag?.pointerId !== event.pointerId) return;
      drag = null;
      $('app').classList.remove('resizing');
      saveWidth();
    };
    resizer.addEventListener('pointerup', finishResize);
    resizer.addEventListener('pointercancel', finishResize);
    resizer.addEventListener('lostpointercapture', finishResize);
    resizer.addEventListener('keydown', (event) => {
      if (!columnLayout()[name]) return;
      const { min, max } = columnBounds(name);
      const width = document.querySelector(`.${name}`).getBoundingClientRect().width;
      const next = { ArrowLeft: width - 16 * direction, ArrowRight: width + 16 * direction, Home: min, End: max }[
        event.key
      ];
      if (next === undefined) return;
      event.preventDefault();
      resizeColumn(name, next);
      saveWidth();
    });
  }
  resizeColumns();

  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-destination-open')) {
      $('destination-message').textContent = 'Checking branches…';
      for (const id of ['retry-branches', 'destination-choices', 'save-destination']) $(id).hidden = true;
      $('destination-dialog').showModal();
      return void loadDestinationBranches();
    }
    if (button.dataset.acceptBase) {
      return void action('accept-pr-base', { branch: button.dataset.acceptBase });
    }
    if (button.dataset.cleanupRetry) return void action('retry-closure', { resourceId: button.dataset.cleanupRetry });
    if (button.dataset.issue) return selectIssue(button.dataset.issue);
    if (button.dataset.folder) {
      const folder = button.dataset.folder;
      if (state.folders.has(folder)) state.folders.delete(folder);
      else state.folders.add(folder);
      renderSidebar();
      return;
    }
    if (button.dataset.block) {
      state.blockId = button.dataset.block;
      state.graphScrollIntent = { nodeId: state.blockId, mode: 'reveal' };
      $('inspector-body').scrollTop = 0;
      renderGraph();
      renderInspector();
      setBusy(state.pending);
      void checkOpenBlock(true);
      return;
    }
    if (button.dataset.tab) {
      state.tab = button.dataset.tab;
      $('inspector-body').scrollTop = 0;
      renderInspector();
      void checkOpenBlock(true);
      return;
    }
    if (button.dataset.closeDialog) return $(button.dataset.closeDialog).close();
    if (button.hasAttribute('data-open-palette')) return openPalette();
    if (button.dataset.addKind) return void addBlock(button.dataset.addKind);
    if (button.dataset.openFile) return void inspectFile(button.dataset.openFile, button.dataset.artifactId);
    if (button.dataset.openFlowFile) return void inspectFile(button.dataset.openFlowFile, null, true);
    if (button.dataset.deleteArtifact) return void deleteArtifact(button.dataset.deleteArtifact);
    if (button.hasAttribute('data-add-edit')) {
      const text = $('new-edit').value.trim();
      if (!text) return;
      setDraft('edits', [
        ...(draft().edits || activeBlock()?.edits || []),
        { id: crypto.randomUUID(), text, enabled: true },
      ]);
      setDraft('newEdit', '');
      renderInspector();
      return;
    }
    if (['select-flow', 'rebuild-flow', 'reveal-flow', 'open-export-flow'].includes(button.dataset.action))
      return void flowDefinitionAction(button);
    if (button.dataset.action && !['save', 'comment', 'folder'].includes(button.dataset.action))
      void blockAction(button);
  });

  document.addEventListener('input', (event) => {
    const field = event.target;
    if (!field.dataset.field) return;
    setDraft(
      field.dataset.field,
      field.type === 'checkbox'
        ? field.checked
        : ['iterations', 'lane'].includes(field.dataset.field)
          ? Number(field.value)
          : field.value
    );
  });

  document.addEventListener('focusin', (event) => {
    const field = event.target;
    if (
      !field.dataset.field?.startsWith('input-') ||
      !activeBlock()?.details?.some(
        (detail) => detail.key === field.dataset.field.slice(6) && detail.type === 'filename'
      )
    )
      return;
    void loadRepoFiles(state.issueId).catch((error) => showError(`Unable to list repository files. ${error.message}`));
  });

  $('file-restate').addEventListener('change', () => void restateFile());
  $('file-dialog').addEventListener('close', () => {
    inspectedFile = null;
  });

  async function updateBranch() {
    const issueId = state.issueId;
    state.updatingBranch = issueId;
    renderEnvironment();
    try {
      const result = await action('update-worktree');
      if (result && state.issueId === issueId) toast(result.branchUpdateSummary || 'Branch updated.');
    } finally {
      state.updatingBranch = null;
      renderEnvironment();
      void load(true);
    }
  }

  $('target-update-menu').addEventListener('change', async (event) => {
    const menu = event.target;
    const operation = menu.value;
    menu.value = '';
    if (operation === 'update') return updateBranch();
    if (operation === 'add' && (await action('add', { kind: 'update-branch' }))) toast('Update Branch block added.');
  });

  document.addEventListener('change', async (event) => {
    const field = event.target;
    if (['retro-setting', 'auto-close-setting'].includes(field.id)) {
      if (!(await action(field.id, { enabled: field.checked }))) field.checked = !field.checked;
      return;
    }
    if (field.dataset.field?.startsWith('mode-') || field.dataset.field === 'prompt-mode') {
      setDraft(field.dataset.field, field.value);
      renderInspector();
      return;
    }
    if (field.id === 'worktree-menu') {
      const operation = field.value;
      field.value = '';
      if (operation === 'open' || operation === 'terminal') {
        const terminal = operation === 'terminal';
        if (await action('open-worktree', { terminal }))
          toast(terminal ? 'Opened Terminal in the worktree.' : 'Opened the worktree in Finder.');
      } else if (operation === 'update') {
        await updateBranch();
      } else if (operation === 'delete') {
        await deleteWorktree();
      }
      return;
    }
    if (field.id === 'starting-branch') {
      void (async () => {
        await action('starting-point', { ref: field.value });
        await load(true);
      })();
      return;
    }
    if (field.dataset.edit) {
      const edits = draft().edits || activeBlock()?.edits || [];
      setDraft(
        'edits',
        edits.map((edit) => (edit.id === field.dataset.edit ? { ...edit, enabled: field.checked } : edit))
      );
    }
  });

  document.addEventListener('focusout', (event) => {
    if (event.target.id !== 'starting-branch') return;
    setTimeout(() => {
      renderGraph();
      setBusy(state.pending);
    }, 0);
  });

  document.addEventListener('submit', (event) => {
    if (event.target.id === 'request-form') return void saveRequest(event);
    if (event.target.id === 'block-form') return void saveBlock(event);
    if (event.target.id === 'comment-form') return void postComment(event);
    if (event.target.id === 'issue-folder-form') {
      event.preventDefault();
      const key = draftKey();
      void action('folder', { folder: new FormData(event.target).get('folder') || null }).then((result) => {
        if (!result) return;
        const saved = state.drafts.get(key) || {};
        delete saved.folder;
        state.drafts.set(key, saved);
        return load(true);
      });
    }
  });

  window.openFlowCapture = openCapture;
  $('new-issue').addEventListener('click', openCapture);
  $('rename-issue').addEventListener('click', () => {
    const form = $('rename-issue-form');
    const { id, title } = state.view.issue;
    form.dataset.issue = id;
    form.dataset.title = title;
    $('issue-title').parentElement.hidden = true;
    form.hidden = false;
    $('rename-issue-title').value = title;
    $('rename-issue-title').select();
  });
  $('cancel-rename').addEventListener('click', closeRename);
  $('rename-issue-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = $('rename-issue-title').value;
    if (await action('rename-issue', { title, previousTitle: event.currentTarget.dataset.title })) closeRename();
  });
  $('retry-branches').addEventListener('click', loadDestinationBranches);
  $('destination-dialog')
    .querySelector('form')
    .addEventListener('submit', async (event) => {
      if (event.submitter?.id !== 'save-destination') return;
      event.preventDefault();
      const branch = $('destination-branch').value || null;
      if (await action('destination', { branch })) $('destination-dialog').close();
      else await loadDestinationBranches();
    });
  $('confirm-publish').addEventListener('click', () => void reviewPublication(true));
  $('publish-dialog').addEventListener('cancel', (event) => {
    if (state.pending) event.preventDefault();
  });
  $('publish-dialog').addEventListener('close', () => {
    const review = publishReview;
    publishReview = null;
    if (
      review &&
      !review.confirmed &&
      review.issueId === state.issueId &&
      state.view.autoplay?.blockId === review.blockId
    )
      void action('cancel-confirmation', { blockId: review.blockId });
  });
  $('project-settings').addEventListener('click', openProjectSettings);
  $('initialize-lifecycle').addEventListener('click', initializeLifecycle);
  $('empty-new-issue').addEventListener('click', openCapture);
  const closureModal = $('issue-closure-dialog');
  const closureFields = $('issue-closure-fields');
  const closureButton = $('confirm-issue-closure');
  const closureCancel = $('cancel-issue-closure');
  const closureError = $('issue-closure-error');
  const closureDialog = window.createIssueClosureDialog({
    dialog: closureModal,
    panel: closureFields,
    approve: closureButton,
    error: closureError,
    request: (name, data) => post(name, { ...data, flow: true }),
  });
  closureModal.addEventListener('cancel', (event) => {
    if (closureFields.inert) event.preventDefault();
  });
  async function archiveIssue(issueId) {
    if (!confirm('Archive this closed issue?')) return;
    const {
      results: [result],
    } = await post('issue-storage-move', { action: 'archive', issueId, issueIds: [issueId] });
    if (result.status === 'archived' || result.status === 'published') {
      state.index.issues = state.index.issues.filter((issue) => issue.id !== issueId);
      if (state.issueId === issueId) selectIssue(null);
      toast('Issue archived.');
    } else if (result.status === 'review') {
      toast('Archive is awaiting review on the shared queue.');
    } else {
      throw Error(result.error || 'The issue could not be archived.');
    }
  }

  async function reopenIssue(issueId) {
    if (!confirm('Reopen this issue and return it to investigation?')) return;
    const context = await json('/api/issue-closure?kind=reopen&issue=' + encodeURIComponent(issueId));
    await post('issue-decision', { ...context, kind: 'reopen' });
    toast('Issue reopened.');
  }

  $('issue-archive-menu').addEventListener('change', async (event) => {
    const menu = event.target;
    const operation = menu.value;
    menu.value = '';
    const issueId = state.view?.issue?.id;
    if (!issueId || state.pending) return;
    if (operation === 'cleanup') {
      const { flow, issue } = state.view;
      return void closureDialog.open(() => ({
        issueId,
        flowRevision: flow.revision,
        cleanupOnly: true,
        resolution: issue.closure?.reason,
        closureReasons: [
          { id: issue.closure?.reason || 'fixed', label: issue.closure?.label || 'Fixed', description: '' },
        ],
      }));
    }
    state.pending = true;
    setBusy(true);
    try {
      if (operation === 'archive') await archiveIssue(issueId);
      if (operation === 'reveal') await post('issue-report-reveal', { issueId });
      if (operation === 'reopen') await reopenIssue(issueId);
    } catch (error) {
      showError(error.message);
    } finally {
      state.pending = false;
      setBusy(false);
      void load(true);
    }
  });

  function openClosure() {
    const { issue, flow } = state.view;
    void closureDialog.open(async () => ({
      ...(await json('/api/issue-closure?issue=' + encodeURIComponent(issue.id))),
      kind: 'close',
      flowRevision: flow.revision,
    }));
  }
  $('close-with-reason').addEventListener('click', openClosure);
  $('issue-pr-menu').addEventListener('click', (event) => {
    if (event.target.closest('a')) $('issue-pr-menu').open = false;
  });
  $('retry-closure').addEventListener('click', () => void action('retry-closure'));
  $('skip-retro').addEventListener('click', () => {
    if (confirm('Continue to Cleanup without a completed retro?')) void action('skip-retro');
  });
  $('issue-approval-menu').addEventListener('change', async (event) => {
    const menu = event.target;
    const choice = menu.value;
    menu.value = '';
    const { issue } = state.view;
    if (choice === 'delete-pending-issue' && !confirm(`Permanently delete “${issue.title}”?`)) return;
    const result = await action(choice, { title: issue.title });
    if (!result) return;
    if (result.publication) {
      toast(result.publication.status === 'review' ? 'Deletion awaits shared queue review.' : result.publication.error);
      return;
    }
    if (choice === 'delete-pending-issue') selectIssue(null);
    void load(true);
  });
  $('issue-closure-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (closureButton.disabled) return;
    const decision = closureDialog.decision();
    closureButton.disabled = true;
    closureCancel.disabled = true;
    closureFields.inert = true;
    closureButton.textContent = 'Closing…';
    closureError.textContent = '';
    try {
      if (decision.cleanupOnly) {
        if (await action('cleanup-again', { revision: decision.flowRevision, cleanup: decision.cleanup }))
          closureModal.close();
        return;
      }
      const result = await post('issue-decision', decision);
      if (state.view?.issue.id === decision.issueId) {
        const issue = state.view.issue;
        issue.status = 'closed';
        issue.state = result.state;
        state.view.autoplay = { mode: 'paused', reason: 'Issue closed' };
        render();
      }
      closureModal.close();
      toast(
        result.publication?.status === 'review'
          ? 'Saved locally. The shared report is awaiting human review.'
          : result.publication?.status === 'failed'
            ? 'Saved locally. Shared report publication needs attention.'
            : 'Issue closed.'
      );
      void load(true);
    } catch (error) {
      closureError.textContent = error.message;
    } finally {
      closureButton.textContent = 'Close issue';
      closureButton.disabled = false;
      closureCancel.disabled = false;
      closureFields.inert = false;
    }
  });
  $('issue-playback').addEventListener('click', () => {
    if (state.view?.autoplay?.mode !== 'paused') return void action('pause');
    const hasDraft = [...state.drafts].some(
      ([key, values]) =>
        key.startsWith(state.issueId + '/') &&
        Object.keys(values).some((field) => !['comment', 'newEdit'].includes(field))
    );
    if (hasDraft) return showError('Save your block settings before playing. Your drafts are still here.');
    void action('play');
  });
  document.addEventListener('factory-actions-paused', ({ detail }) => {
    state.newActionsPaused = detail;
    updatePlaybackAvailability(state.pending);
  });
  $('refresh').addEventListener('click', () => {
    void load(true, true);
  });
  $('dismiss-error').addEventListener('click', () => {
    state.error = '';
    state.connectionError = '';
    renderErrors();
  });
  $('issue-search').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderSidebar();
  });
  $('new-folder').addEventListener('click', () => {
    $('folder-error').hidden = true;
    $('folder-dialog').showModal();
    $('folder-name').focus();
  });

  $('capture-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const description = $('capture-description').value.trim();
    if (!description || state.pending) return;
    state.captureId ||= crypto.randomUUID();
    $('capture-error').hidden = true;
    const result = await action(
      'capture',
      {
        requestId: state.captureId,
        description,
        type: $('capture-type').value,
        folder: window.captureFolder(),
        needsApproval: $('capture-needs-approval').checked,
        runRetro: $('capture-retro').checked,
      },
      { global: true, errorId: 'capture-error' }
    );
    if (!result) return;
    state.captureId = null;
    $('capture-description').value = '';
    $('capture-retro').checked = false;
    $('capture-needs-approval').checked = false;
    $('capture-dialog').close();
    toast('Issue created. Its blocks are ready for you to choose.');
    const id = result.issue?.id || result.issueId;
    if (id) selectIssue(id);
    else await load(true);
  });

  $('export-flow-id').addEventListener('input', renderExportFlowPath);
  $('export-flow-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.target));
    $('export-flow-error').hidden = true;
    if (await action('export-flow', fields, { errorId: 'export-flow-error' })) {
      $('export-flow-dialog').close();
      toast('User flow saved and linked to this issue.');
    }
  });

  $('folder-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('folder-name').value.trim();
    if (!name || state.pending) return;
    $('folder-error').hidden = true;
    const result = await action('create-folder', { name }, { global: true, errorId: 'folder-error' });
    if (!result) return;
    $('folder-name').value = '';
    $('folder-dialog').close();
    toast('Folder created. Move an issue into it from its request block.');
    await load(true);
  });

  document.addEventListener('keydown', (event) => {
    if (
      event.key.toLowerCase() !== 'n' ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.target.closest('input, textarea, select, [contenteditable="true"]') ||
      document.querySelector('dialog[open]')
    )
      return;
    event.preventDefault();
    openCapture();
  });
  window.addEventListener('resize', resizeColumns);
  new ResizeObserver(drawConnections).observe($('graph-scroll'));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void load();
  });
  setInterval(updateBlockTimers, 1000);
  setInterval(() => {
    if (!document.hidden) void load();
  }, 2000);
  serverControlUI.watchConnection(() => {
    $('connection-status').className = 'connection offline';
    $('connection-status').innerHTML = '<span class="connection-dot"></span> Offline';
    renderErrors();
  });
  void load();
})();
