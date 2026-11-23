(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const view = window.timeyView;
  const initialSelection = new URL(location.href).searchParams;
  const state = {
    index: { issues: [], folders: [], catalog: [] },
    view: null,
    issueId: initialSelection.get('issue'),
    folder: initialSelection.get('issue') ? null : initialSelection.get('folder'),
    fileFolder: initialSelection.get('fileRoot')
      ? {
          root: initialSelection.get('fileRoot'),
          path: initialSelection.get('filePath') || '',
          name:
            initialSelection.get('filePath')?.split('/').at(-1) ||
            initialSelection.get('fileRoot').replace('system-', ''),
        }
      : null,
    blockId: null,
    deleteBlockId: null,
    graphScrollIntent: null,
    sidebarWidth: null,
    inspectorWidth: null,
    tab: 'details',
    search: '',
    draggedIssueId: null,
    collapsedFolders: new Set(view.read('flow-collapsed-folders', [])),
    collapsedCollections: new Set(view.read('flow-collapsed-collections', ['closed-issues', 'archived-issues'])),
    archivedIssues: null,
    collapsedSearchFolders: new Set(),
    drafts: new Map(Object.entries(view.read('flow-drafts', {}))),
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
    toastTimer: null,
    storeSelection: null,
  };
  const issueStoreUI = window.createIssueStoreUI({ request: json, post, changed: () => load(true) });
  const issueOwnershipUI = window.createIssueOwnershipUI({ request: json, post, changed: () => load(true) });
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
  function emptyFolderSelection() {
    return {
      issueIds: new Set(),
      selection: null,
      scan: null,
      group: null,
      overnight: null,
      view: 'open',
      query: '',
      matches: null,
      bulk: null,
      bulkResults: null,
    };
  }
  let folderSelection = emptyFolderSelection();
  let inspectedFile = null;
  let inspectorRender;
  let folderConfig = null;
  let strategyFolder = null;
  const folderSettingsUI = window.createFolderSettingsUI({
    container: $('folder-settings-panel'),
    omitFields: ['selection_strategy'],
    request: json,
    notify: toast,
    changed: (data) => {
      folderConfig = data;
      strategyFolder = null;
      if (state.fileFolder && data.folder?.name && data.kind !== 'plain') state.folder = data.folder.name;
      renderFolderWorkspace();
      void loadFolderStrategies();
      void load(true);
    },
  });
  const projectSettingsUI = window.createProjectSettingsUI({
    request: json,
    changed: () => {
      state.storeSelection = null;
      void load(true);
    },
  });

  function folderLocation() {
    return state.fileFolder ? { root: state.fileFolder.root, path: state.fileFolder.path } : { folder: state.folder };
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
    const attempt = block?.attempts?.at(-1);
    return attempt?.supersededByPR ? null : attempt || null;
  }

  function status(block) {
    const attempt = latest(block);
    if (attempt?.invalidatedAt && !runningStatuses.has(attempt.status) && attempt.status !== 'uncertain')
      return 'invalidated';
    return attempt?.status || blockDefaultStatus(block);
  }

  function blockDefaultStatus(block) {
    if (block?.historicallyCompleted) return 'completed';
    return block?.suggested ? 'suggested' : 'ready';
  }

  function routeComplete(blocks) {
    if (!blocks.length) return false;
    const closureStart = blocks.findIndex((block) => ['close', 'retro', 'cleanup'].includes(block.kind));
    const routeBlocks = closureStart < 0 ? blocks : blocks.slice(0, closureStart);
    return routeBlocks.every(
      (block) =>
        status(block) === 'completed' || (block.kind === 'request' && Boolean(block.data?.fields) && !latest(block))
    );
  }

  function playbackAction(blocks) {
    const issue = state.view?.issue;
    const location = issue?.location;
    const closed = location === 'closed' || issue?.status === 'closed';
    const playing = ['playing', 'waiting'].includes(state.view?.autoplay?.mode);
    if (playing) return 'pause';
    if (!issue || location === 'archive' || state.view?.grouping?.master) return 'hidden';
    if (routeComplete(blocks)) return closed || state.view.flow.routeType === 'investigation' ? 'archive' : 'close';
    if (closed || issue.readOnly) return 'hidden';
    return blocks.some((block) => block.attempts?.length) ? 'resume' : 'start';
  }

  function isRunning(block) {
    return runningStatuses.has(status(block));
  }

  function statusText(value, attempt) {
    if (value === 'blocked' && attempt?.result?.humanInput) return 'Needs your input';
    return value === 'blocked' && attempt?.result?.completed?.length ? 'Needs retry' : words(value);
  }

  function blockHumanInput(block) {
    return block && state.view?.humanInput?.blockId === block.id ? state.view.humanInput : null;
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

  function persistDrafts() {
    view.write('flow-drafts', Object.fromEntries(state.drafts));
  }

  function setDraft(name, value) {
    state.drafts.set(draftKey(), { ...draft(), [name]: value });
    persistDrafts();
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
    const storage = state.index?.storeStatus || state.view?.storeStatus;
    const message = waiting
      ? 'Waiting for server…'
      : state.error ||
        state.connectionError ||
        (storeUnavailable() && storage?.phase !== 'refreshing'
          ? 'Shared storage is unavailable. Browse cached history and keep local drafts; shared changes and new runs are paused.'
          : '');
    if (document.documentElement.dataset.projectIssueRequestEmbed === 'true') {
      $('request-embed-error').hidden = !message;
      view.text($('request-embed-error-message'), message);
      return;
    }
    $('error-banner').hidden = !message;
    view.text($('error-message'), message);
    $('dismiss-error').hidden = waiting || storeUnavailable();
  }

  function storeUnavailable() {
    return Boolean((state.index?.storeStatus || state.view?.storeStatus)?.unavailable);
  }

  function localStoreControl(action) {
    return state.view?.issue?.localOwner && ['stop', 'pause'].includes(action);
  }

  function applyStoreAvailability() {
    if (!storeUnavailable()) return;
    document
      .querySelectorAll(
        '[data-action], [data-add-kind], #capture-submit, #export-flow-submit, #folder-form button[type="submit"], #rename-issue, #move-starting-branch, #starting-branch, #target-update-menu, #merge-state-menu, #issue-input-continue, #run-block, #inspector-body button[type="submit"]'
      )
      .forEach((button) => {
        if (!localStoreControl(button.dataset.action)) button.disabled = true;
      });
    document
      .querySelectorAll(
        '#issue-flow-picker, #issue-settings-form, #issue-store-form, #rename-issue-form, #issue-grouping, [data-skill-picker]'
      )
      .forEach((element) => {
        element.inert = true;
      });
    document.querySelectorAll('#inspector-body input, #inspector-body select').forEach((field) => {
      field.disabled = true;
    });
    $('issue-playback').disabled ||= !localStoreControl(playbackAction(state.view?.flow?.blocks || []));
    $('worktree-menu').querySelector('option[value="update"]').disabled = true;
    updateIssueDecisionControls(true);
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

  window.createInvestigationFollowupsUI({
    request: post,
    folders: () => state.index.issueFolders || [],
    changed: () => load(true),
  });

  const projectHome = window.createProjectHomeUI({
    request: json,
    post,
    navigateHome: () => selectWorkspace({}),
    changed: () => load(true),
  });
  const investigationUI = window.createInvestigationIssueUI({ request: json, post, changed: () => load(true) });
  const investigationControls = window.createInvestigationFlowControls({
    request: json,
    post,
    changed: () => load(true),
    archive: archiveIssueWithUiState,
  });

  function investigationActions(block) {
    if (block?.kind !== 'understand' || status(block) !== 'completed') return '';
    return `<section class="detail-section"><div class="section-label">Findings</div><p class="detail-copy">Turn these findings into concrete work.</p><button class="small-button" data-investigation-followups="${escape(block.id)}" data-source-issue="${escape(state.issueId)}"${state.newActionsPaused ? ' disabled' : ''}>Create follow-up issues</button></section>`;
  }

  function applyView(result) {
    state.index = { ...state.index, ...result };
    if (result.flow && result.issue && result.issue.id === state.issueId) {
      state.view = result;
      if (document.documentElement.dataset.projectIssueRequestEmbed === 'true') {
        state.blockId = result.flow.blocks.find((block) => block.kind === 'request')?.id || null;
        state.tab = 'details';
      } else if (!result.flow.blocks.some((block) => block.id === state.blockId)) {
        state.deleteBlockId = null;
        const attempted = result.flow.blocks
          .filter((block) => latest(block))
          .sort((a, b) =>
            String(latest(b).endedAt || latest(b).startedAt || '').localeCompare(
              String(latest(a).endedAt || latest(a).startedAt || '')
            )
          );
        const savedSelection = view.read('flow-selection:' + state.issueId, {});
        const savedBlock = result.flow.blocks.find((block) => block.id === savedSelection.blockId);
        if (savedBlock && ['details', 'conversation', 'artifacts'].includes(savedSelection.tab))
          state.tab = savedSelection.tab;
        state.blockId =
          savedBlock?.id ||
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
    if (!force && (state.pending || state.loading)) {
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
      const query = new URLSearchParams();
      if (selected) query.set('issue', selected);
      if (announce) query.set('refresh', 'true');
      if (document.documentElement.dataset.projectIssueRequestEmbed === 'true') query.set('view', 'request');
      const params = query.toString();
      const result = await json(`/api/flow${params ? `?${params}` : ''}`, {
        signal: controller.signal,
      });
      if (sequence !== state.sequence || selected !== state.issueId || serverControlUI.isWaitingForServer()) return;
      state.connectionError = '';
      $('connection-status').className = 'connection';
      $('connection-status').innerHTML = '<span class="connection-dot"></span> Local updates · GitHub on demand';
      $('connection-status').title = result.storeStatus?.checkedAt
        ? `Shared data last checked ${date(result.storeStatus.checkedAt)}`
        : 'Remote data refreshes on demand.';
      if (announce) state.error = '';
      applyView(result);
      void refreshIssueStore();
      if (announce)
        toast(
          result.environment?.remoteError || result.sharedQueueWarning
            ? 'Refresh incomplete. Last saved values retained.'
            : 'Current view refreshed.'
        );
    } catch (error) {
      if (error.name === 'AbortError' || sequence !== state.sequence || serverControlUI.isWaitingForServer()) return;
      state.connectionError = `Unable to refresh. ${error.message} The last saved view remains visible.`;
      $('connection-status').className = 'connection offline';
      $('connection-status').innerHTML = '<span class="connection-dot"></span> Reconnecting';
      renderErrors();
    } finally {
      if (sequence === state.sequence) {
        state.loading = false;
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
    if (storeUnavailable() && !localStoreControl(name)) {
      renderErrors();
      return null;
    }
    if (!options.global && state.view?.issue?.readOnly && !state.view.issue.readOnlyActions.includes(name)) {
      showError(state.view.issue.readOnlyReason);
      return null;
    }
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
    branchRepairUI.update(state.view);
    $('folder-workspace').inert = busy;
    const frozenIssue = Boolean(state.view?.issue?.readOnly);
    document.querySelectorAll('[data-open-palette]').forEach((button) => {
      button.disabled = busy || frozenIssue;
    });
    document.querySelectorAll('[data-skill-picker]').forEach((picker) => {
      picker.inert = frozenIssue;
    });
    $('issue-flow-picker').inert = frozenIssue;
    $('issue-settings-form').inert = frozenIssue;
    $('rename-issue-form').inert = frozenIssue;
    $('rename-issue').disabled = busy || frozenIssue;
    $('issue-grouping').inert = busy;
    const attached = Boolean(state.view?.grouping?.master);
    const frozen = Boolean(state.view?.issue?.readOnly);
    document
      .querySelectorAll(
        '[data-action], [data-add-kind], #capture-submit, #export-flow-submit, #folder-form button[type="submit"]'
      )
      .forEach((button) => {
        const runsBlock = ['start', 'continue'].includes(button.dataset.action);
        button.disabled =
          busy ||
          (frozen &&
            (button.dataset.addKind ||
              (button.dataset.action && !state.view.issue.readOnlyActions.includes(button.dataset.action)))) ||
          (attached && Boolean(button.dataset.action) && !['comment', 'folder'].includes(button.dataset.action)) ||
          (runsBlock && operationPaused(activeBlock())) ||
          (button.id === 'delete-block' && Boolean(blockDeletionReason(activeBlock())));
      });
    document
      .querySelectorAll('#inspector-body input, #inspector-body select, #inspector-body textarea')
      .forEach((field) => {
        const closureSetting = [
          'retro-setting',
          'auto-close-setting',
          'full-regression-setting',
          'issue-folder-locked',
        ].includes(field.id);
        field.disabled =
          busy ||
          frozen ||
          (attached && Boolean(field.closest('#request-form, #block-form'))) ||
          (closureSetting && state.view?.issue?.status === 'closed');
      });
    document.querySelectorAll('#inspector-body button[type="submit"]').forEach((button) => {
      button.disabled = busy || frozen;
    });
    const runBlock = $('run-block');
    runBlock.disabled =
      busy ||
      (runBlock.dataset.action !== 'stop' &&
        (operationPaused(activeBlock()) || state.view?.flow?.blocks.some(isRunning))) ||
      status(activeBlock()) === 'stopping';
    const inputBlock = state.view?.flow?.blocks.find((block) => block.id === state.view.humanInput?.blockId);
    $('issue-input-continue').disabled =
      busy ||
      !inputBlock ||
      (state.view?.humanInput?.kind !== 'agent' &&
        (state.newActionsPaused || attached || operationPaused(inputBlock) || state.view.flow.blocks.some(isRunning)));
    updatePlaybackAvailability(busy);
    $('close-publish').disabled = busy;
    $('move-starting-branch').disabled = busy || frozen;
    const startingBranch = $('starting-branch');
    if (startingBranch)
      startingBranch.disabled = busy || !state.view?.startingPointEditable || !state.view.branches?.length;
    const branchBusy = busy || frozen || Boolean(state.view?.flow?.blocks.some(isRunning));
    $('target-update-menu').disabled = branchBusy;
    $('worktree-menu').querySelector('option[value="update"]').disabled = branchBusy;
    $('worktree-menu').disabled = busy || state.view?.environment?.worktreeExists !== true;
    $('merge-state-menu').disabled = busy || frozen || Boolean(state.view?.flow?.blocks.some(isRunning));
    updateIssueDecisionControls(busy);
    $('issue-store-form').inert = busy;
    applyStoreAvailability();
  }

  function updateIssueDecisionControls(busy) {
    const issue = state.view?.issue;
    const closed = issue?.status === 'closed';
    const pending = issue?.state === 'needs-approval';
    $('worktree-hint').hidden = pending;
    for (const id of ['approve-issue', 'delete-pending-issue']) {
      $(id).hidden = !pending;
      $(id).disabled = busy;
    }
    const routeAction = playbackAction(state.view?.flow?.blocks || []);
    $('close-with-reason').hidden =
      !issue ||
      state.view?.flow?.routeType === 'investigation' ||
      closed ||
      pending ||
      Boolean(state.view?.grouping?.master) ||
      routeAction === 'close';
    $('close-with-reason').disabled = busy;
    $('issue-archive-menu').hidden = !closed;
    $('issue-archive-menu').disabled = busy;
    const archived = issue?.location === 'archive';
    for (const option of $('issue-archive-menu').options)
      if (['archive', 'reveal', 'reopen'].includes(option.value))
        option.hidden = archived || (option.value === 'reopen' && issue?.readOnly);
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
    const mode = playbackAction(state.view?.flow?.blocks || []);
    const issue = state.view?.issue;
    const routeAction = ['start', 'resume', 'pause'].includes(mode);
    const closed = issue?.location === 'closed' || issue?.status === 'closed';
    const showArchive = mode === 'archive';
    const pending = state.view?.issue?.state === 'needs-approval';
    button.hidden = mode === 'hidden';
    $('closed-issue-indicator').hidden = !closed || showArchive;
    button.disabled =
      busy ||
      !playback ||
      (routeAction && pending) ||
      (['start', 'resume'].includes(mode) && (state.newActionsPaused || closed || issue?.readOnly));
    const unavailableAction = mode === 'close' ? 'close' : mode === 'archive' ? 'archive' : 'start or resume';
    button.title = !playback
      ? `Restart the Timey server to ${unavailableAction} this issue`
      : ['start', 'resume'].includes(mode) && state.newActionsPaused
        ? 'Turn off No new actions to start or resume this issue'
        : '';
  }

  function selectIssue(id) {
    if (!state.folder && !state.fileFolder && state.issueId === id && state.view) return;
    selectWorkspace({ issue: id });
  }

  function selectFolder(folder) {
    if (state.folder === folder) return;
    selectWorkspace({ folder });
  }

  window.addEventListener('factory-open-issue-folder', (event) => selectFolder(event.detail));

  window.addEventListener('factory-open-file-folder', (event) => selectWorkspace({ fileFolder: event.detail }));
  window.addEventListener('factory-file-folder-ready', (event) => {
    if (state.fileFolder?.root !== event.detail.root || state.fileFolder.path !== event.detail.path) return;
    state.fileFolder = event.detail;
    renderFolderWorkspace();
  });

  function sidebarCollapsedFolders() {
    return state.search ? state.collapsedSearchFolders : state.collapsedFolders;
  }

  function selectWorkspace({ issue = null, folder = null, fileFolder = null }) {
    state.folder = folder;
    state.fileFolder = fileFolder;
    folderSelection = emptyFolderSelection();
    folderConfig = null;
    strategyFolder = null;
    folderSettingsUI.setLocation(null);
    $('folder-scan-form').reset();
    $('folder-search-form').reset();
    $('folder-issue-view').value = 'open';
    state.issueId = issue;
    state.blockId = null;
    state.deleteBlockId = null;
    state.graphScrollIntent = null;
    state.view = null;
    state.error = '';
    const url = new URL(location.href);
    for (const [key, value] of Object.entries({
      issue,
      folder,
      fileRoot: fileFolder?.root,
      filePath: fileFolder?.path,
    })) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    history.replaceState(null, '', url);
    window.dispatchEvent(new CustomEvent('factory-workspace-changed'));
    render();
    void load(true);
  }

  function renderSidebar() {
    if (state.draggedIssueId) return;
    void updateProjectActions();
    const issues = (state.index.issues || []).filter((issue) =>
      `${issue.title} ${issue.issueNumber || ''}`.toLowerCase().includes(state.search.toLowerCase())
    );
    const folders = [
      ...new Set([...(state.index.folders || []), ...issues.map((issue) => issue.folder).filter(Boolean)]),
    ];
    const row = (issue) =>
      `<button class="issue-row${issue.id === state.issueId ? ' selected' : ''}" data-issue="${escape(issue.id)}" draggable="${issue.status !== 'closed' && !issue.readOnly && !issue.activeBlock}" title="${escape(issue.title)}"${issue.id === state.issueId ? ' aria-current="page"' : ''}>${issue.activeBlock ? activeSpinner(issue.activeBlock) : statusIcon(issue.humanInput ? 'needs-input' : issue.status)}<span class="issue-name">${issue.issueNumber ? `#${escape(issue.issueNumber)} - ` : ''}${escape(issue.title)}${issue.humanInput ? '<span class="issue-input-label">Needs your input</span>' : ''}</span></button>`;
    const groups = folders
      .map((folder) => {
        const children = issues.filter((issue) => issue.folder === folder && issue.status !== 'closed');
        if (state.search && children.length === 0) return '';
        const collapsed = sidebarCollapsedFolders().has(folder);
        const active = children.find((issue) => issue.activeBlock);
        const name = escape(folder);
        const selected = state.folder === folder;
        return `<section class="issue-folder"><div class="sidebar-folder-row" data-issue-folder-drop="${name}"><button class="icon-button folder-disclosure" type="button" data-toggle-folder="${name}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${name}" aria-expanded="${!collapsed}"></button><button class="folder-toggle" data-folder="${name}"${selected ? ' aria-current="page"' : ''}>${active ? activeSpinner(active.activeBlock) : ''}<span class="issue-folder-name">${name}</span><span class="folder-count">${children.length}</span></button><button class="icon-button sidebar-folder-create" data-create-folder-issue="${name}" aria-label="Create issue in ${name}" title="Create issue in ${name}">＋</button></div><div class="folder-items"${collapsed ? ' hidden' : ''}>${children.map(row).join('')}</div></section>`;
      })
      .join('');
    const closed = issues.filter((issue) => issue.status === 'closed');
    $('migrate-issue-folders').hidden = !(state.index.legacyFolders || []).length;
    const archive = (state.archivedIssues || []).filter((issue) =>
      `${issue.title} ${issue.issueNumber || ''}`.toLowerCase().includes(state.search.toLowerCase())
    );
    const collection = (id, name, content) =>
      `<details id="${id}" class="issue-folder" data-collection data-view-controlled-open${state.search || !state.collapsedCollections.has(id) ? ' open' : ''}><summary class="folder-toggle folder-disclosure">${name}</summary><div class="folder-items">${content}</div></details>`;
    const empty = '<p class="sidebar-empty">No matching issues.</p>';
    const statusCollections = [
      { id: 'in-progress-issues', name: 'In progress', matches: (issue) => issue.status === 'running' },
      {
        id: 'blocked-status-issues',
        name: 'Blocked',
        matches: (issue) =>
          issue.state !== 'needs-approval' &&
          issue.status !== 'running' &&
          (['blocked', 'need-input'].includes(issue.status) || issue.waitingForApproval),
      },
    ].map(({ id, name, matches }) => {
      const members = issues.filter((issue) => !issue.paused && issue.status !== 'closed' && matches(issue));
      return collection(
        id,
        `${name}<span class="folder-count">${members.length}</span>`,
        members.map(row).join('') || empty
      );
    });
    view.render(
      $('issue-list'),
      statusCollections.join('') +
        `<div id="open-issues">${groups || empty}</div>` +
        collection('closed-issues', 'Closed', closed.map(row).join('') || empty) +
        collection(
          'archived-issues',
          'Archived',
          state.archivedIssues
            ? archive.map(row).join('') || empty
            : '<p class="sidebar-empty">Open Archived to load its reports.</p>'
        ),
      'flow-sidebar:' + state.index.project
    );
  }

  function canMoveSidebarIssue(id, folder) {
    const issue = state.index.issues.find((row) => row.id === id);
    if (state.pending || !issue || issue.status === 'closed' || issue.activeBlock) return false;
    if (folder === undefined) return true;
    return Boolean(folder) && issue.folder !== folder && !issue.folderLocked;
  }

  async function moveSidebarIssue(issueId, folder) {
    const issue = state.index.issues.find((row) => row.id === issueId);
    if (!canMoveSidebarIssue(issueId, folder)) return;
    const result = await action('folder', { issueId, revision: issue.flowRevision, folder }, { global: true });
    if (!result) return;
    if (folder) sidebarCollapsedFolders().delete(folder);
    applyView(result);
    toast(`Moved issue to ${folder}.`);
  }

  window.createIssueFolderDrag({
    list: $('issue-list'),
    canMove: canMoveSidebarIssue,
    move: moveSidebarIssue,
    dragging: (id) => {
      state.draggedIssueId = id;
    },
  });

  $('delete-sidebar-folder').addEventListener('click', async () => {
    if (state.pending) return;
    const selected = folderLocation();
    state.pending = true;
    $('delete-sidebar-folder').disabled = true;
    try {
      const preview = await json('/api/folder-delete-preview?' + new URLSearchParams(selected));
      if (!preview.canDelete) return toast(preview.reason);
      const installed = preview.installed ? '\nThese installed files are used by Factory.' : '';
      if (!confirm(`Move “${preview.name}” and all its contents to Trash?${installed}`)) return;
      await post('folder-delete', { ...selected, basis: preview.basis });
      window.dispatchEvent(new CustomEvent('factory-folder-deleted', { detail: selected }));
      selectWorkspace({});
      toast('Moved folder to Trash.');
    } catch (error) {
      showError(error.message);
    } finally {
      state.pending = false;
      $('delete-sidebar-folder').disabled = false;
      void load(true);
    }
  });

  async function loadArchive() {
    try {
      const { issues } = await json('/api/issue-storage?location=archive');
      state.archivedIssues = issues.map((issue) => ({ ...issue, status: 'closed' }));
      renderSidebar();
    } catch (error) {
      toast(error.message);
    }
  }

  window.addEventListener('factory-archive-updated', loadArchive);

  $('issue-list').addEventListener('click', (event) => {
    const collection = event.target.closest('summary')?.parentElement;
    if (!collection?.hasAttribute('data-collection')) return;
    if (collection.open) state.collapsedCollections.add(collection.id);
    else {
      state.collapsedCollections.delete(collection.id);
      if (collection.id === 'archived-issues') void loadArchive();
    }
    view.write('flow-collapsed-collections', [...state.collapsedCollections]);
  });

  function issueLabel(issue) {
    return `${issue.issueNumber == null ? '' : `#${issue.issueNumber} `}${issue.title ?? issue.id}`;
  }

  function issueLink(issue) {
    return `<a href="?issue=${encodeURIComponent(issue.id)}" data-open-folder-issue="${escape(issue.id)}">${escape(issueLabel(issue))}</a>`;
  }

  const folderMarkup = new WeakMap();

  function updateFolderMarkup(element, html) {
    if (folderMarkup.get(element) === html) return;
    const field = element.contains(document.activeElement) ? document.activeElement : null;
    view.render(element, html, 'folder:' + state.folder + ':' + element.id);
    folderMarkup.set(element, html);
    if (field?.id) $(field.id)?.focus({ preventScroll: true });
  }

  function folderIssueRow(issue, reason, field) {
    const check = `<input type="checkbox" name="${field}" value="${escape(issue.id)}" id="${field}-${escape(issue.id)}"${field === 'member' ? (folderSelection.issueIds.has(issue.id) ? ' checked' : '') : ' checked'} aria-label="Select ${escape(issueLabel(issue))}" />`;
    return `<li>${check}<div>${issueLink(issue)}${reason ? `<p>${escape(reason)}</p>` : ''}</div></li>`;
  }

  function folderIssueStatus(issue, reason) {
    return [reason, issue.masterId ? 'Sub-issue' : '', issue.folderLocked ? 'Folder moves restricted' : '']
      .filter(Boolean)
      .join(' · ');
  }

  function folderRun() {
    const runs = state.index.folderRuns || {};
    return Object.hasOwn(runs, state.folder) ? runs[state.folder] : null;
  }

  function overnightActive(run) {
    return ['running', 'stopping'].includes(run?.status);
  }

  function renderFolderRun() {
    const preview = $('folder-night-preview');
    const plan = folderSelection.overnight;
    preview.hidden = !plan;
    updateFolderMarkup(
      preview,
      plan
        ? `<h2>Work All Night plan</h2><p>${escape(plan.finishLine)}</p><ul>${plan.issues.map((issue) => `<li>${issueLink(issue)}</li>`).join('')}</ul><div class="folder-controls"><button class="primary-button" type="button" data-folder-command="start-night"${state.newActionsPaused ? ' disabled' : ''}>Start overnight run</button><button class="small-button" type="button" data-folder-command="cancel-night">Cancel</button></div>`
        : ''
    );
    const report = $('folder-night-report');
    const run = folderRun();
    report.hidden = !run;
    updateFolderMarkup(
      report,
      run
        ? `<h2>Overnight report</h2><p>${escape(words(run.status))} · ${escape(run.finishLine)}</p><ul class="folder-run-results">${run.issues.map(overnightIssue).join('')}</ul>${run.status === 'running' ? '<button class="small-button" type="button" data-folder-command="stop-night">Stop overnight run</button>' : ''}`
        : ''
    );
  }

  function overnightIssue(issue) {
    const { status, summary, failedCheck, nextAction, pr, url } = issue;
    return `<li>${issueLink(issue)} · ${escape(words(status))}
      ${summary ? `<p>${escape(summary)}</p>` : ''}
      ${failedCheck ? `<p>Failed check: ${escape(failedCheck)}</p>` : ''}
      ${nextAction ? `<p>${escape(nextAction)}</p>` : ''}
      ${url ? prLink({ url, number: pr }) : ''}</li>`;
  }

  function renderFolderButtons() {
    const selected = state.index.issues.filter((issue) => folderSelection.issueIds.has(issue.id));
    const count = selected.length;
    $('folder-selection-summary').textContent = count ? `${count} selected` : '';
    const enable = (command, allowed) => {
      document.querySelector(`[data-folder-command="${command}"]`).disabled = !allowed;
    };
    const mayGroup =
      folderSelection.view === 'open' &&
      selected.every((issue) => (issue.groupEligible ?? issue.folderEligible) && !issue.masterId);
    const mayRun =
      folderSelection.view === 'open' &&
      selected.every((issue) => !issue.masterId && !issue.activeBlock && issue.state !== 'needs-approval');
    enable('group', count >= 2 && mayGroup);
    enable('plan-night', count > 0 && mayRun && !overnightActive(folderRun()) && !state.newActionsPaused);
    const visible = folderMembers();
    const selectedVisible = visible.filter((issue) => folderSelection.issueIds.has(issue.id)).length;
    const all = visible.length > 0 && selectedVisible === visible.length;
    const checkbox = $('folder-select-all');
    checkbox.checked = all;
    checkbox.indeterminate = selectedVisible > 0 && !all;
    checkbox.disabled = !visible.length;
    const bulk = document.querySelector('[data-folder-command="bulk"]');
    const verb = folderSelection.view === 'closed' ? 'Archive' : 'Start';
    bulk.textContent = all || !selectedVisible ? `${verb} all` : `${verb} selected (${selectedVisible})`;
    bulk.disabled = !selectedVisible || state.pending || (folderSelection.view === 'open' && state.newActionsPaused);
    document.querySelector('[data-folder-command="recommend"]').disabled = folderSelection.view !== 'open';
    $('folder-scan-form').hidden = folderSelection.view !== 'open';
    $('folder-scan-review').querySelector('button[type="submit"]').disabled = !document.querySelector(
      '#folder-scan-list input:checked'
    );
  }

  function folderMembers() {
    const closed = folderSelection.view === 'closed';
    const query = folderSelection.query.toLowerCase();
    return state.index.issues.filter(
      (issue) =>
        issue.folder === state.folder &&
        (issue.status === 'closed') === closed &&
        (folderSelection.matches
          ? folderSelection.matches.has(issue.id)
          : `${issue.title} ${issue.issueNumber || ''}`.toLowerCase().includes(query))
    );
  }

  function renderFolderBulk() {
    const preview = folderSelection.bulk;
    const verb = folderSelection.view === 'closed' ? 'Archive' : 'Start';
    $('folder-bulk-preview').hidden = !preview;
    updateFolderMarkup(
      $('folder-bulk-preview'),
      preview
        ? `<h2>Review ${verb.toLowerCase()}</h2><ul>${(preview.issues || []).map((issue) => `<li>${issueLink(issue)}${issue.reason ? `<p>${escape(issue.reason)}</p>` : ''}</li>`).join('')}</ul><div class="folder-controls"><button type="button" class="primary-button" data-folder-command="run-bulk">${verb} selected issues</button><button type="button" class="small-button" data-folder-command="cancel-bulk">Cancel</button></div>`
        : ''
    );
    const results = folderSelection.bulkResults;
    $('folder-bulk-results').hidden = !results;
    updateFolderMarkup(
      $('folder-bulk-results'),
      results
        ? `<h2>Action results</h2><ul>${results
            .map((result) => {
              const issue = state.index.issues.find(({ id }) => id === result.id) || { id: result.id };
              return `<li>${issueLink(issue)} · ${escape(result.status)}${result.error ? `<p>${escape(result.error)}</p>` : ''}</li>`;
            })
            .join('')}</ul>`
        : ''
    );
  }

  async function previewFolderBulk() {
    const preview = await folderAction('folder-bulk-preview', {
      folder: state.folder,
      view: folderSelection.view,
      issueIds: folderMembers()
        .filter((issue) => folderSelection.issueIds.has(issue.id))
        .map(({ id }) => id),
    });
    if (!preview) return;
    folderSelection.bulk = preview;
    folderSelection.bulkResults = null;
    renderFolderWorkspace();
  }

  async function runFolderBulk() {
    if (!folderSelection.bulk) return;
    const result = await folderAction('folder-bulk-run', { previewId: folderSelection.bulk.id });
    if (!result) return;
    folderSelection.bulkResults = result.results;
    folderSelection.bulk = null;
    folderSelection.issueIds.clear();
    await load(true);
    renderFolderWorkspace();
  }

  async function searchFolderAI() {
    const query = $('folder-search-query').value.trim();
    if (!query) return;
    const selection = folderSelection;
    $('folder-search-status').hidden = false;
    $('folder-search-status').textContent = 'Searching all issues in this view…';
    const result = await folderAction('folder-ai-search', { folder: state.folder, view: selection.view, query });
    if (!result || selection !== folderSelection) return;
    selection.matches = new Map((result.matches || []).map(({ id, reason }) => [id, reason]));
    selection.query = '';
    $('folder-search-status').textContent = `${selection.matches.size} matching issues. Selection unchanged.`;
    renderFolderWorkspace();
  }

  async function loadFolderStrategies() {
    const folder = state.folder;
    if (!folder || folderConfig?.kind === 'broken' || strategyFolder === folder) return;
    strategyFolder = folder;
    try {
      const result = await json('/api/folder-strategies?' + new URLSearchParams({ folder }));
      if (state.folder !== folder) return;
      const select = $('folder-selection-strategy');
      select.innerHTML = result.strategies
        .map(({ id, name }) => `<option value="${escape(id)}">${escape(name)}</option>`)
        .join('');
      select.value = result.selected;
    } catch (error) {
      strategyFolder = null;
      showError(error.message);
    }
  }

  async function changeFolderStrategy(copy) {
    if (!state.folder || state.pending) return;
    try {
      const result = await post('folder-strategies', {
        folder: state.folder,
        action: copy ? 'copy' : 'select',
        strategy: $('folder-selection-strategy').value,
        revision: folderConfig?.revision,
      });
      strategyFolder = null;
      if (result.strategies) {
        $('folder-selection-strategy').innerHTML = result.strategies
          .map(({ id, name }) => `<option value="${escape(id)}">${escape(name)}</option>`)
          .join('');
        $('folder-selection-strategy').value = result.selected;
      }
      await folderSettingsUI.refresh();
      toast(copy ? 'Selection strategy copied to your user folder.' : 'Selection strategy saved.');
    } catch (error) {
      showError(error.message);
    }
  }

  function renderIssueSettings() {
    const view = state.view;
    if (!view) return;
    const settings = view.issueSettings;
    if (!settings) {
      $('issue-settings').hidden = true;
      return;
    }
    $('issue-settings').hidden = false;
    issueOwnershipUI.render(view.issue, view.storeStatus?.unavailable).catch((error) => showError(error.message));
    const fields = settings.fields || [];
    const values = settings.values || {};
    $('issue-settings-form').querySelector('button[type="submit"]').disabled = Boolean(settings.frozen);
    $('issue-settings').title = settings.frozen ? 'Settings are retained for the started run.' : '';
    updateFolderMarkup(
      $('issue-settings-fields'),
      fields
        .filter(({ key }) => ['branch', 'skill', 'model', 'effort'].includes(key))
        .map((field) =>
          window.factorySettingField(
            field,
            {
              raw: settings.overrides?.[field.key] || 'default',
              value: values[field.key],
              source: settings.sources?.[field.key],
            },
            'issue-setting',
            settings.frozen
          )
        )
        .join('')
    );
    window.factoryAgentOptions($('issue-settings-fields'));
  }

  function renderFolderWorkspace() {
    const workspace = $('folder-workspace');
    const selected = Boolean(state.folder || state.fileFolder);
    workspace.hidden = !selected;
    workspace.closest('.workspace').classList.toggle('folder-open', selected);
    workspace.closest('.workspace').querySelector('.inspector').hidden = selected;
    $('graph-scroll').hidden = selected;
    $('flow-view-title').textContent = selected ? 'Folder' : 'Issue flow';
    $('issue-folder-content').hidden = !state.folder;
    if (!selected) return;
    $('folder-workspace-title').textContent = folderConfig?.folder?.label || state.fileFolder?.name || state.folder;
    folderSettingsUI.setLocation(folderLocation());
    $('issue-folder-content').hidden = !state.folder || folderConfig?.kind === 'plain';
    if (!state.folder || folderConfig?.kind === 'plain') return;
    const { issues, folders } = state.index;
    const members = folderMembers();
    const reasons = new Map(
      folderSelection.matches || folderSelection.selection?.candidates.map(({ id, reason }) => [id, reason])
    );
    updateFolderMarkup(
      $('folder-member-list'),
      members
        .map((issue) => folderIssueRow(issue, folderIssueStatus(issue, reasons.get(issue.id)), 'member'))
        .join('') || '<li class="muted">No issues in this folder.</li>'
    );
    const source = $('folder-scan-source');
    const lastSource = source.value;
    updateFolderMarkup(
      source,
      '<option value="">All open issues</option>' +
        folders
          .filter((folder) => folder !== state.folder)
          .map((folder) => `<option value="${escape(folder)}">${escape(folder)}</option>`)
          .join('')
    );
    source.value = [...source.options].some((option) => option.value === lastSource) ? lastSource : '';
    const scan = folderSelection.scan;
    $('folder-scan-review').hidden = !scan;
    updateFolderMarkup(
      $('folder-scan-list'),
      (scan?.candidates || [])
        .map(({ id, reason }) => folderIssueRow(issues.find((issue) => issue.id === id) || { id }, reason, 'candidate'))
        .join('')
    );
    $('folder-group-form').hidden = !folderSelection.group;
    renderFolderBulk();
    renderFolderRun();
    renderFolderButtons();
  }

  function renderIssueGrouping() {
    const panel = $('issue-grouping');
    const grouping = state.view?.grouping;
    const { master, children, reasoning, formerMasters } = grouping || {};
    panel.hidden = !master && !children?.length && !formerMasters?.length;
    const groupReasons = new Map(reasoning?.map(({ id, reason }) => [id, reason]));
    const html = [];
    if (master) {
      const label = state.view.issue.status === 'closed' ? 'Fixed by' : 'Work belongs to';
      html.push(`<p>${label} ${issueLink(master)}</p>`);
    }
    for (const formerMaster of formerMasters || [])
      html.push(`<p>Earlier work and evidence in ${issueLink(formerMaster)}</p>`);
    if (children?.length) {
      html.push(
        `<h2>Sub-issues</h2><ul class="folder-run-results">${children
          .map((child) => renderSubIssue(child, groupReasons.get(child.id)))
          .join('')}</ul>`
      );
    }
    updateFolderMarkup(panel, html.join(''));
  }

  function renderSubIssue(child, reason) {
    const { requestedProof, proof, nextAction, canDetach } = child;
    return `<li>${issueLink(child)}${reason ? `<p>${escape(reason)}</p>` : ''}${requestedProof ? `<p>Requested proof: ${escape(requestedProof)}</p>` : ''}${proof ? `<p>${proof.status === 'passed' ? 'Passed' : 'Unmet'}: ${escape(proof.observation)}</p>` : ''}${nextAction ? `<p>${escape(nextAction)}</p>` : ''}<div class="folder-controls">${proof?.status === 'failed' ? '<button class="small-button" type="button" data-group-play>Continue on the master</button>' : ''}${canDetach ? `<button class="small-button" type="button" data-detach-sub-issue="${escape(child.id)}">${proof?.status === 'failed' ? 'Detach and fix separately' : 'Detach'}</button>` : ''}</div></li>`;
  }

  async function folderAction(name, fields = {}) {
    const selection = folderSelection;
    const result = await action(name, fields, { global: true });
    return selection === folderSelection ? result : null;
  }

  function updateFolderSelection(ids) {
    folderSelection.issueIds = new Set(ids);
    folderSelection.group = null;
    folderSelection.overnight = null;
    folderSelection.bulk = null;
    renderFolderWorkspace();
  }

  async function recommendFolderIssues() {
    const selection = await folderAction('folder-selection', {
      folder: state.folder,
      strategy: $('folder-selection-strategy').value,
    });
    if (!selection) return;
    folderSelection.selection = selection;
    updateFolderSelection(selection.candidates.map(({ id }) => id));
    if (!selection.candidates.length) toast('No issues fit this selection strategy.');
  }

  async function previewFolderGroup() {
    const preview = await folderAction('folder-group-preview', {
      folder: state.folder,
      issueIds: [...folderSelection.issueIds],
      selectionId: folderSelection.selection?.id,
    });
    if (!preview) return;
    folderSelection.group = { ...preview, requestId: crypto.randomUUID() };
    $('folder-master-wording').value = preview.wording;
    renderFolderWorkspace();
    $('folder-master-wording').focus();
  }

  async function createFolderMaster(event) {
    event.preventDefault();
    const preview = folderSelection.group;
    if (!preview) return;
    const result = await folderAction('folder-group-create', {
      previewId: preview.id,
      wording: $('folder-master-wording').value,
      requestId: preview.requestId,
    });
    if (result) selectIssue(result.issue.id);
  }

  async function scanForFolderIssues(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const autoApprove = fields.has('autoApprove');
    form.elements.autoApprove.checked = false;
    const result = await folderAction('folder-scan', {
      folder: state.folder,
      strategy: $('folder-selection-strategy').value,
      sourceFolder: fields.get('source') || null,
      autoApprove,
    });
    if (!result) return;
    folderSelection.scan = !autoApprove && result.candidates.length ? result : null;
    folderMarkup.delete($('folder-scan-list'));
    renderFolderWorkspace();
    if (autoApprove) await folderMoveComplete(result);
    else if (!folderSelection.scan) toast('No matching issues to move.');
  }

  async function folderMoveComplete(result) {
    const moved = result.moved || 0;
    toast(moved === 1 ? 'Moved one issue.' : `Moved ${moved} issues.`);
    await load(true);
  }

  async function moveReviewedIssues(event) {
    event.preventDefault();
    const scan = folderSelection.scan;
    if (!scan) return;
    const result = await folderAction('folder-move', {
      folder: state.folder,
      scanId: scan.id,
      issueIds: new FormData(event.currentTarget).getAll('candidate'),
    });
    if (!result) return;
    closeFolderPreview('scan');
    await folderMoveComplete(result);
  }

  async function previewFolderNight() {
    folderSelection.overnight = await folderAction('folder-night-plan', {
      folder: state.folder,
      issueIds: [...folderSelection.issueIds],
    });
    renderFolderWorkspace();
  }

  async function startFolderNight() {
    if (!folderSelection.overnight) return;
    const result = await folderAction('folder-night-start', { planId: folderSelection.overnight.id });
    if (!result) return;
    closeFolderPreview('overnight');
    await load(true);
  }

  async function stopFolderNight() {
    if (await folderAction('folder-night-stop', { folder: state.folder })) await load(true);
  }

  function closeFolderPreview(key) {
    folderSelection[key] = null;
    renderFolderWorkspace();
  }

  const folderCommands = {
    recommend: recommendFolderIssues,
    group: previewFolderGroup,
    'plan-night': previewFolderNight,
    'start-night': startFolderNight,
    'stop-night': stopFolderNight,
    'cancel-night': () => closeFolderPreview('overnight'),
    'cancel-group': () => closeFolderPreview('group'),
    'cancel-scan': () => closeFolderPreview('scan'),
    bulk: previewFolderBulk,
    'run-bulk': runFolderBulk,
    'cancel-bulk': () => closeFolderPreview('bulk'),
  };

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

  const branchRepairUI = window.createBranchRepairUI({
    button: $('fix-branch'),
    action,
    isBusy: () => state.pending,
  });

  function renderEnvironment() {
    branchRepairUI.update(state.view);
    const environment = state.view?.environment;
    $('environment').hidden = !environment;
    if (!environment) return;
    renderWorktreeHint(environment.worktreeExists);
    const mergeMenu = $('merge-state-menu');
    mergeMenu.hidden = !environment.merge;
    mergeMenu.title = environment.merge?.conflicts.join(', ') || 'A local merge is awaiting completion.';
    const chips = [];
    if (environment.branch)
      chips.push(`<span class="environment-chip" title="Current issue branch">⑂ ${escape(environment.branch)}</span>`);
    if (environment.dirty === true) chips.push('<span class="environment-chip warning">● Uncommitted changes</span>');
    renderTargetUpdate(environment);
    if (environment.ahead > 0) chips.push(`<span class="environment-chip">↑ ${escape(environment.ahead)} ahead</span>`);
    renderPullRequest(state.view.destination?.pr);
    if (environment.remoteObservedAt)
      chips.push(
        `<span class="environment-chip" title="Saved GitHub observation. Use Refresh to check again.">GitHub checked ${escape(date(environment.remoteObservedAt))}</span>`
      );
    if (environment.error || environment.remoteError)
      chips.push(
        `<span class="environment-chip warning" title="${escape(environment.error || environment.remoteError)}">Check failed · Refresh to retry</span>`
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

  function destinationFollowLabel() {
    if (state.view.issueSettings?.frozen) return 'Uses saved run target';
    if (state.view.issueSettings?.overrides?.branch) return 'Uses issue target override';
    return state.view.flow.resolvedBranch ? 'Follows folder default' : 'Follows starting branch';
  }

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
      <span class="terminal-note">${locked ? 'Locked to the PR' : follows ? destinationFollowLabel() : ''} ${prLink(pr)}</span>
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
    const store = await issueStoreUI.fill($('destination-issue-store'), {
      issueId: state.issueId,
    });
    $('destination-issue-store').dataset.saved = store.selected;
    $('destination-issue-store').required = false;
    $('destination-store-source').textContent = issueStoreUI.savedLabel(store);
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
      new Option(state.view.destination.follows ? 'Follow starting branch' : 'Use issue target setting', ''),
      ...(unavailable && !destination.follows
        ? [new Option(destination.branch + ' (unavailable)', destination.branch)]
        : []),
      ...branches.map((branch) => new Option(`${state.view.flow.target.remote}/${branch}`, branch))
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
    if (blockHumanInput(block)) return 'Needs your input';
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
    if (blockHumanInput(block)) return blockHumanInput(block).message;
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
      footer: `<span class="block-bottomline"><span data-skill-picker="${escape(block.id)}" title="Choose this block’s skill">${escape(block.effectiveSkill || block.skill || 'Choose a skill')} ▾</span><span>${hasEvidence ? `${hasEvidence} evidence` : attempt ? `Attempt ${block.attempts.length}` : block.lane > 0 ? `Lane ${block.lane + 1}` : 'View details ↗'}</span></span>`,
    };
    return (
      '<span class="block-port top"></span>' + Object.values(parts).join('') + '<span class="block-port bottom"></span>'
    );
  }

  async function openBlockSkillPicker(blockId) {
    const block = state.view?.flow.blocks.find((item) => item.id === blockId);
    if (!block || block.readOnly || isRunning(block)) return;
    const definition = state.index.catalog.find((item) => item.id === (block.definition ?? block.kind));
    const issueId = state.issueId;
    const dialog = document.createElement('dialog');
    dialog.innerHTML =
      '<h2>Block skill</h2><label class="field">Skill<select aria-label="Block skill"></select></label><p>Available choices and defaults come from this block type. Use Add skill… to edit this block’s user Markdown skill list.</p><form method="dialog"><button>Close</button></form>';
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    const picker = window.createSkillSelect(dialog.querySelector('select'), {
      onAdd: async () => {
        if (state.issueId !== issueId) return dialog.close();
        await action('open-block-extension', { blockId });
        dialog.close();
      },
      onChange: async (skill) => {
        if (state.issueId !== issueId) return dialog.close();
        if (await action('update', { blockId, changes: { skill: skill === 'none' ? null : skill } })) dialog.close();
      },
      onSetup: async (names) => {
        try {
          const missing = names.filter((name) => !available.skills.some((skill) => skill.name === name));
          const result = await post('project-discuss-action', { action: 'create', requestId: crypto.randomUUID() });
          await post('project-discuss-action', {
            action: 'send',
            conversationId: result.selected.id,
            clientId: crypto.randomUUID(),
            text:
              'Install these missing block skills for this project: ' +
              missing.join(', ') +
              '. Declared skill sources: ' +
              JSON.stringify(definition?.skillSources || {}) +
              '. Read user/skills/requirements.json for additional sources. Preserve existing custom skills and verify discovery.',
            settings: { clarificationSkill: 'none', skills: ['skill-installer'] },
            attachments: [],
          });
          toast('Skill installation requested in Project Discuss.');
          dialog.close();
        } catch (error) {
          showError(error.message);
        }
      },
    });
    picker.update(
      [
        ...(definition?.skills || []).map((name) => ({ kind: 'skill', name, label: name, skill: name })),
        { kind: 'value', name: 'none', label: 'No skill' },
      ],
      block.effectiveSkill || block.skill || 'none'
    );
    dialog.querySelector('select').disabled = true;
    dialog.showModal();
    let available;
    try {
      available = await json('/api/project-discuss-skills');
      picker.discovered(available.skills);
      dialog.querySelector('select').disabled = false;
    } catch (error) {
      showError(error.message);
    }
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
    const startingNote = startingBranchNote(state.view, branches);
    const layers = graphLayers(blocks);
    const destination = destinationNode();
    const baseNode = `<div class="graph-terminal base" data-node="__base"><span class="terminal-label">Starting point</span><label class="starting-branch-label" for="starting-branch">Starting branch</label><select id="starting-branch" aria-describedby="starting-branch-note" title="Change the starting branch for this issue">${options.join('')}</select>${pinnedCommit ? `<span class="terminal-note starting-commit" title="${escape(pinnedCommit)}">Base ${escape(pinnedCommit.slice(0, 12))}</span>` : ''}${flow.workspace?.branch ? `<span class="terminal-note">${escape(flow.workspace.branch)}</span>` : ''}<span class="terminal-note" id="starting-branch-note">${escape(startingNote)}</span></div>`;
    $('graph').classList.toggle(
      'closed',
      state.view.issue.location === 'closed' || state.view.issue.state === 'closed'
    );
    view.render(
      $('graph'),
      `<svg class="graph-lines" aria-hidden="true"></svg>${baseNode}${layers.map((row) => `<div class="graph-row">${row.map(blockCard).join('')}</div>`).join('')}<button class="graph-add" data-open-palette aria-label="Add a step" title="Add a step">＋</button>${destination}`,
      'flow-graph:' + state.issueId
    );
    $('graph').dataset.issue = state.issueId;
    requestAnimationFrame(() => {
      drawConnections();
      const intent = state.graphScrollIntent;
      state.graphScrollIntent = null;
      if (intent) scrollToBlock(intent);
    });
  }

  function startingBranchNote(view, branches) {
    if (view.branchCatalogError) return view.branchCatalogError;
    if (!branches.length) return 'No Git branches are available.';
    if (view.destination?.locked) return 'The issue already has a pull request.';
    if (!view.startingPointEditable) return 'Available for idle, unpublished issues with an available worktree.';
    return view.environment?.worktreeExists
      ? 'Choose a branch to move the saved issue work onto it.'
      : 'Choose a branch for this issue.';
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
                `<label class="field"><span>${escape(output.label)}</span><div data-ai-text data-ai-key="output-${escape(state.issueId)}-${escape(block.id)}-${escape(output.key)}" data-ai-source="${escape(displayValue(output.value))}">${readonlyInput(output.key, output, output.value)}</div></label>`
            )
            .join('')
        : '<p class="inline-empty">This block declares no outputs.</p>'
    }</section>`;
  }

  const investigationRunSelection = new Map();
  const investigationRunKey = (block) => state.issueId + '/' + block.id;
  function inquiryRunOptions(block) {
    if (!['understand', 'investigate'].includes(block.kind)) return [];
    return block.attempts.filter(
      (attempt) => attempt.status === 'completed' && attempt.investigation?.mode !== 'discussion'
    );
  }
  function investigationSourcePicker(block) {
    if (!['generate-report', 'create-issues'].includes(block.kind)) return '';
    const selected = investigationRunSelection.get(investigationRunKey(block));
    const runs = state.view.flow.blocks.concat(state.view.flow.retiredBlocks || []).flatMap(inquiryRunOptions);
    return `<label class="field">Source investigation run<select data-investigation-source="${escape(block.id)}"><option value="">Latest current completed run</option>${runs.map((attempt, index) => `<option value="${escape(attempt.id)}"${selected === attempt.id ? ' selected' : ''}>Run ${index + 1} · ${escape(date(attempt.startedAt))}</option>`).join('')}</select><small>Choose retained findings for the next output run.</small></label>`;
  }
  document.addEventListener('change', (event) => {
    if (!event.target.hasAttribute('data-investigation-source')) return;
    investigationRunSelection.set(state.issueId + '/' + event.target.dataset.investigationSource, event.target.value);
  });
  function investigationRunInput(block) {
    return { investigationRunId: investigationRunSelection.get(investigationRunKey(block)) || undefined };
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
    const regression =
      flow.routeType === 'investigation'
        ? ''
        : `<label><input type="checkbox" id="full-regression-setting"${values.fullRegression === true ? ' checked' : ''}${disabled}> Run full regression suite</label>`;
    const settings = `${regression}<label><input type="checkbox" id="retro-setting"${values.runRetro ? ' checked' : ''}${disabled}> Run a retro</label>${state.view.issue.state === 'needs-approval' ? '' : `<label><input type="checkbox" id="auto-close-setting"${flow.autoClose ? ' checked' : ''}${disabled}> Close as Fixed and remove the worktree after Factory Merge</label>`}`;
    return `<section class="detail-section"><div class="section-label">Inputs</div><form id="request-form">${formField('wording', 'Your words', values.wording, 'The original request.', 4)}${saveRow()}</form>${settings}</section>${requestMergeBranch()}${outputsSection(block)}${definition?.prompt ? `<details class="detail-section system-prompt" data-preserve="system-prompt"><summary>System prompt</summary><div class="prompt-preview">${escape(definition.prompt)}</div></details>` : ''}${last ? `<section class="detail-section">${attemptCard(last, block.attempts.length - 1)}${block.attempts.length > 1 ? `<details class="attempt-history" data-preserve="attempt-history"><summary>Earlier requests</summary>${block.attempts.slice(0, -1).map(attemptCard).join('')}</details>` : ''}</section>` : ''}${retiredHistory()}<section class="detail-section"><div class="section-label">Organization</div><form id="issue-folder-form"><label class="field">Folder<select id="issue-folder" name="folder" data-field="folder" required>${folders.map((folder) => `<option value="${escape(folder)}"${(values.folder ?? flow.folder) === folder ? ' selected' : ''}${flow.folderLocked && folder !== flow.folder ? ' disabled' : ''}>${escape(folder)}</option>`).join('')}</select></label><button type="submit" class="small-button" data-action="folder">Move issue</button></form><label class="folder-check"><input id="issue-folder-locked" type="checkbox"${flow.folderLocked ? ' checked' : ''} /> Prevent moves into folders</label></section>`;
  }

  function requestMergeBranch() {
    const { branch, follows, locked, pr } = state.view.destination || {};
    const check = destinationChecks.get(state.issueId);
    const unavailable = branch && check?.branches && !check.branches.includes(branch);
    const display = branch ? `⑂ ${escape(branch)}` : 'Choose merge branch';
    return `<section class="detail-section"><div class="section-label">Merge branch</div><div class="request-merge-branch">${locked ? `<span>${display}</span>` : `<button type="button" class="small-button" data-destination-open data-destination-label="Merge branch" aria-label="Choose merge branch">${display}</button>`}<small>${locked ? 'Locked to the pull request' : follows ? destinationFollowLabel() : ''} ${prLink(pr)}</small>${!locked && unavailable ? '<small>Branch unavailable</small>' : ''}${!locked && check?.branchesUnavailable ? '<small>Couldn’t check branches</small>' : ''}</div></section>`;
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
    return `<details class="system-prompt" data-preserve="system-prompt"><summary>System prompt <span class="muted-inline">${mode === 'skill' ? 'Skill' : 'Text'}</span></summary>${skills.length ? `<label class="field"><span>Use</span><select name="prompt-mode" data-field="prompt-mode"${locked}><option value="text"${mode === 'text' ? ' selected' : ''}>Text</option><option value="skill"${mode === 'skill' ? ' selected' : ''}>Allowed skill</option></select></label>` : ''}${field}${block.effectiveSkill && block.effectiveSkill !== block.skill ? `<small>Uses inherited issue skill: ${escape(block.effectiveSkill)}</small>` : ''}${skills.length ? '<small>Only skills listed in this block type’s Markdown are available.</small>' : ''}</details>`;
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
    return `<div class="block-progress" data-attempt-id="${escape(attempt.id)}"><div class="progress-heading"><span>${statusIcon(attempt.status)} ${escape(statusText(attempt.status, attempt))}${attempt.invalidatedAt ? ' · Invalidated' : ''}</span><span class="progress-meta">Attempt ${index + 1}</span></div><p class="detail-copy" data-ai-text data-ai-key="summary-${escape(attempt.id)}" data-ai-source="${escape(summary)}">${escape(summary)}</p>${attempt.result?.pr ? prLink({ number: attempt.result.pr, url: attempt.result.url }) : ''}<p class="progress-meta" style="margin-top:9px">${escape(date(attempt.startedAt))}${attempt.endedAt ? ` · ended ${escape(date(attempt.endedAt))}` : ''}</p>${attempt.output ? `<pre class="attempt-output" data-ai-text data-ai-key="live-${escape(attempt.id)}" data-ai-source="${escape(attempt.output)}">${escape(attempt.output)}</pre>` : ''}${result && result !== summary ? `<pre class="attempt-output" data-ai-text data-ai-key="result-${escape(attempt.id)}" data-ai-source="${escape(result)}">${escape(result)}</pre>` : ''}${attempt.details?.length ? `<details data-preserve="details-${escape(attempt.id)}"><summary>Details used</summary><pre class="attempt-output">${escape(JSON.stringify(attempt.details, null, 2))}</pre></details>` : ''}${attempt.systemPrompt ? `<details data-preserve="prompt-${escape(attempt.id)}"><summary>System prompt used</summary><pre class="attempt-output">${escape(attempt.systemPrompt)}</pre></details>` : ''}${evidenceLinks(attempt)}</div>`;
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
      const scope = JSON.stringify([state.issueId, block.id, 'content']);
      view.track(prose, scope);
      view.render(prose, entry.inspectorHtml, scope);
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

  function historicalIssueLink(id) {
    const issue = state.index.issues.find((entry) => entry.id === id);
    return `<li><a href="/?issue=${encodeURIComponent(id)}">${escape(issue?.title || 'Open saved issue')}</a></li>`;
  }
  function historicalOutputProgress(block) {
    const ids = block.historicalCompletion.issueIds || [];
    return `<p class="detail-copy">Completed by an earlier investigation run.</p><ul>${ids.map(historicalIssueLink).join('')}</ul>`;
  }
  const agentQuestionDrafts = new Map();
  const questionDraftKey = (request, id) => `${state.issueId}/${request.attemptId}/${request.requestId}/${id}`;
  document.addEventListener('input', (event) => {
    if (event.target.dataset.agentQuestionKey)
      agentQuestionDrafts.set(event.target.dataset.agentQuestionKey, event.target.value);
  });
  function agentApprovalCard(request) {
    const questions = request.params.questions || [];
    const content = questions.length
      ? questions
          .map((question) => {
            const key = questionDraftKey(request, question.id);
            const options = (question.options || []).map(({ label }) => label).join(', ');
            return `<label class="field">${escape(question.question)}<input data-agent-question="${escape(question.id)}" data-agent-question-key="${escape(key)}" value="${escape(agentQuestionDrafts.get(key) || '')}" placeholder="${escape(options)}" /><small>You can also enter your own answer.</small></label>`;
          })
          .join('') + '<button class="small-button" data-action="agent-answer">Send answers</button>'
      : `<pre class="attempt-output">${escape(request.params.command)}\n${escape(request.params.reason)}</pre>${request.options.map((option) => `<button class="small-button" data-action="agent-answer" data-decision="${escape(option.id)}">${escape(option.label)}</button>`).join('')}`;
    return `<section class="detail-section" data-agent-approval="${escape(request.requestId)}" data-attempt-id="${escape(request.attemptId)}"><p>Agent input required</p>${content}</section>`;
  }
  function blockProgress(block, last, attempts, published) {
    if (last) return attemptCard(last, attempts.length - 1);
    if (block.historicallyCompleted) return historicalOutputProgress(block);
    return `<p class="inline-empty">${published ? `PR #${escape(published)} has been published. Run Merge to check it.` : 'This block has not run yet. Review its inputs before starting.'}</p>`;
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
    const previousAttempts = last ? attempts.slice(0, -1) : attempts;
    const published = attempts.at(-1)?.supersededByPR;
    const permissions = (state.view.agentApprovals || []).filter((request) => request.blockId === block.id);
    const progress = blockProgress(block, last, attempts, published);
    const running = isRunning(block);
    if (['retro', 'cleanup'].includes(block.kind))
      return `<section class="detail-section">${last ? attemptCard(last, attempts.length - 1) : '<p>This block runs during Close.</p>'}${block.kind === 'cleanup' ? cleanupResults(last) : ''}${attempts.length > 1 ? `<details><summary>Earlier attempts</summary>${attempts.slice(0, -1).map(attemptCard).join('')}</details>` : ''}</section>`;
    const locked = state.pending ? ' disabled' : '';
    const sections = {
      settings: `<form id="block-form">${investigationSourcePicker(block)}${declaredDetails(block, true)}${outputsSection(block)}${systemPromptEditor(block, values, locked)}${editChecklist(block, changes)}<section class="detail-section"><div class="section-label">Block settings</div><label class="field">Name<input name="label" data-field="label" value="${escape(values.label || '')}" /></label><div class="field-row"><label class="field">Parallel lane<select name="lane" data-field="lane">${[0, 1, 2, 3].map((lane) => `<option value="${lane}"${Number(values.lane || 0) === lane ? ' selected' : ''}>${lane === 0 ? 'Main lane' : `Parallel lane ${lane + 1}`}</option>`).join('')}</select></label>${block.kind === 'sol' ? `<label class="field">Iterations<input type="number" name="iterations" data-field="iterations" min="1" max="20" value="${escape(values.iterations || 1)}" /></label>` : ''}</div></section>${saveRow()}</form>`,
      progress: `<section class="detail-section"><div class="section-label">${running ? 'Current progress' : 'Progress'}<span data-ui-value="Status comes from the saved block.">${escape(statusText(status(block), last))}</span></div>${progress}${previousAttempts.length ? `<details class="attempt-history" data-preserve="attempt-history"><summary>${previousAttempts.length} earlier ${previousAttempts.length === 1 ? 'attempt' : 'attempts'}</summary>${previousAttempts.map(attemptCard).join('')}</details>` : ''}</section>`,
      sequence: `<section class="detail-section"><div class="section-label">Sequence</div><p class="detail-copy">Move this step toward the destination or toward the starting point.</p><div class="block-actions"><button class="small-button" data-action="move" data-direction="down"${locked}>↑ Earlier</button><button class="small-button" data-action="move" data-direction="up"${locked}>↓ Later</button></div></section>`,
      notes: comments(block),
    };
    return (
      permissions.map(agentApprovalCard).join('') +
      investigationActions(block) +
      definitionActions(block) +
      Object.values(sections).join('') +
      contentSection(block)
    );
  }

  function conversationMessage(message) {
    const producer = state.view.flow.blocks.find((entry) => entry.id === message.blockId);
    return window.chatMessageMarkup({
      id: message.id,
      user: message.actor === 'human',
      label: message.role || message.actor,
      meta: [producer?.label, date(message.at)].filter(Boolean).join(' · '),
      content: `<p class="message-body">${escape(message.body)}</p>`,
      aiSource: message.body,
      aiKey: 'flow-conversation-' + message.id,
    });
  }

  function renderConversation(block) {
    const messages = state.view?.conversation || [];
    return `<p class="conversation-context">This issue's conversation shows notes and responses from its blocks.</p>${messages.length ? `<div class="timeline">${messages.map(conversationMessage).join('')}</div>` : '<p class="inline-empty">No conversation entries yet. Starting a block will retain its activity here.</p>'}${block ? commentForm(block) : ''}`;
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
    return (
      investigationActions(block) +
      (current || '<p class="inline-empty">No artifacts from the latest run.</p>') +
      previous
    );
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
      Boolean(state.view.issue.readOnly && !running) ||
      Boolean(state.view.grouping?.master) ||
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
          : blockHumanInput(block)
            ? 'Continue'
            : retrying
              ? 'Retry'
              : '▷ Run';
    runButton.classList.toggle('danger-button', running);
  }

  function blockDeletionReason(block) {
    if (!block) return 'Select a block.';
    if (state.view?.issue?.readOnly) return 'This merged issue is read-only.';
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
    if (inspectorRender?.scope === scope && inspectorRender.html === html) return;
    view.render(body, html, scope);
    view.write('flow-selection:' + state.issueId, { blockId: state.blockId, tab: state.tab });
    inspectorRender = { scope, html };
  }

  function renderPlayback(blocks) {
    const playback = state.view?.autoplay;
    const playing = playback?.mode === 'playing' || playback?.mode === 'waiting';
    const mode = playbackAction(blocks);
    const waiting = blocks.find((block) => playback?.mode === 'waiting' && playback.blockId === block.id);
    const labels = { start: 'Start', resume: 'Resume', pause: 'Pause', close: 'Close', archive: 'Archive' };
    $('issue-playback').textContent = labels[mode] || 'Start';
    $('issue-playback').setAttribute('aria-label', labels[mode] ? labels[mode] + ' issue' : 'Start issue');
    const waitingButton = $('waiting-block');
    waitingButton.hidden = !waiting;
    waitingButton.textContent = waiting ? waiting.label + ' needs confirmation' : '';
    waitingButton.dataset.block = waiting?.id || '';
    const input = state.view?.humanInput;
    $('playback-status').textContent = input
      ? 'Needs your input'
      : waiting
        ? 'Waiting for confirmation'
        : playing
          ? 'Running'
          : 'Paused';
    const result = state.view?.flow?.closing?.error || input?.message || playback?.reason || '';
    $('issue-results').hidden = !state.view?.issue || !result;
    $('issue-results-title').textContent = input ? 'Needs your input' : 'Results';
    $('issue-results').classList.toggle('needs-input', Boolean(input));
    $('issue-results-message').textContent = result;
    $('issue-input-actions').hidden = !input;
    $('issue-input-continue').textContent = input?.kind === 'agent' ? 'Open request' : 'Continue';
    const url = safeUrl(input?.url);
    $('issue-input-link').hidden = !url;
    $('issue-input-link').href = url || '';
    $('issue-input-link').textContent = input?.actionLabel || 'Review PR';
  }

  function render() {
    renderSidebar();
    renderFolderWorkspace();
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
    const issueNumber = $('issue-number');
    issueNumber.hidden = issue?.issueNumber == null;
    issueNumber.textContent = issueNumber.hidden ? '' : `#${issue.issueNumber}`;
    $('issue-title').textContent = issue?.title || '';
    renderMergedIssueNotice(issue);
    if ($('rename-issue-form').dataset.issue !== issue?.id) closeRename();
    renderFlowPicker();
    renderIssueSettings();
    const blocks = state.view?.flow?.blocks || [];
    const running = blocks.find((block) => isRunning(block));
    const completed = blocks.filter((block) => ['completed', 'succeeded', 'success'].includes(status(block))).length;
    const issueStatus = state.view?.humanInput ? 'Needs your input' : words(issue?.status || 'new');
    $('issue-subtitle').textContent = issue
      ? `${issueStatus}${closureLabel(issue)} · ${blocks.length} blocks${completed ? ` · ${completed} completed` : ''}${running ? ` · ${running.label} running` : ''}`
      : '';
    renderPlayback(blocks);
    renderSharedQueue();
    $('flow-footer-label').textContent = running
      ? `${running.label} is running`
      : state.view
        ? 'Saved flow'
        : 'Changes are saved locally';
    renderEnvironment();
    renderIssueGrouping();
    renderGraph();
    const showHome = !state.issueId && !state.folder && !state.fileFolder;
    projectHome.setVisible(showHome);
    $('app').dataset.homeView = showHome ? 'open' : 'closed';
    if (showHome) {
      $('graph-scroll').hidden = true;
      document.querySelector('.inspector').hidden = true;
      $('flow-view-title').textContent = 'Project home';
    }
    checkOpenPublication();
    renderInspector();
    renderErrors();
    setBusy(state.pending);
    renderInvestigationPage();
  }

  function renderMergedIssueNotice(issue) {
    $('merged-issue-notice').hidden = !issue?.readOnly;
    $('merged-issue-notice').textContent = issue?.readOnly
      ? 'Merged. This issue is read-only. Close it when ready.'
      : '';
  }

  function renderInvestigationPage() {
    if (document.documentElement.dataset.projectIssueRequestEmbed === 'true') return;
    investigationControls.render(state.view);
    const investigation = state.view?.flow?.routeType === 'investigation';
    investigationUI.show(null);
    $('app').dataset.investigation = 'closed';
    if (investigation) {
      $('issue-type-label').textContent = 'Investigation ·';
      $('issue-subtitle').textContent = state.view.issue.reusable ? 'Reusable' : 'One-time';
      $('flow-view-title').textContent = 'Investigation';
    }
  }

  function renderSharedQueue() {
    const queue = state.view?.sharedQueue;
    const checkpoint = queue?.checkpoint;
    const warning = state.index.sharedQueueWarning;
    const unpublishedProposal = state.view?.issue?.state === 'needs-approval' && !queue?.published;
    const awaitingMerge = unpublishedProposal
      ? 'Merge the proposal’s queue PR before approving this issue.'
      : 'Issue update awaits merge of the queue PR.';
    const message =
      checkpoint?.error ||
      (checkpoint?.status === 'review' ? awaitingMerge : '') ||
      warning ||
      (queue?.claimed && !queue.local ? 'Another runner owns this issue.' : '');
    const review = $('shared-queue-review');
    const url = safeUrl(checkpoint?.url);
    review.hidden = checkpoint?.status !== 'review' || !url;
    if (url) review.href = url;
    const button = $('shared-queue-action');
    const route = ['failed', 'preparing', 'review'].includes(checkpoint?.status)
      ? 'retry'
      : queue?.canPublishDraft
        ? 'publish-draft'
        : '';
    button.hidden = !route;
    button.textContent =
      route === 'retry'
        ? checkpoint?.status === 'review'
          ? 'Refresh queue PR'
          : 'Retry report publication'
        : 'Publish report update';
    button.onclick = async () => {
      button.disabled = true;
      try {
        const result = await post('shared-queue-' + route, { issueId: state.issueId });
        if (result?.error) showError(result.error);
        await load(true);
      } catch (error) {
        showError(error.message);
      } finally {
        button.disabled = false;
      }
    };
    $('shared-queue-status').hidden = !message && button.hidden && review.hidden;
    $('shared-queue-message').textContent = message;
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

  async function openCapture(folder) {
    state.captureNote = null;
    if (!state.index.folders.length) await load(true);
    const selected =
      typeof folder === 'string'
        ? folder
        : state.folder ||
          (typeof state.index.defaultFolder === 'string'
            ? state.index.defaultFolder
            : state.index.defaultFolder?.name) ||
          '';
    const options = state.index.folders || [];
    $('capture-folder').innerHTML =
      '<option value="" disabled>Choose a folder</option>' +
      options.map((name) => `<option value="${escape(name)}">${escape(name)}</option>`).join('');
    $('capture-folder').value = options.includes(selected) ? selected : '';
    $('capture-error').textContent = !selected ? state.index.defaultFolderError || '' : '';
    $('capture-error').hidden = !$('capture-error').textContent;
    $('capture-dialog').showModal();
    void loadCaptureStore();
    if (!$('capture-folder').value) $('capture-folder').focus();
    else $('capture-description').focus();
  }

  async function loadCaptureStore() {
    const submit = $('capture-submit');
    submit.disabled = true;
    try {
      await issueStoreUI.fill($('capture-issue-store'), { folder: $('capture-folder').value });
      submit.disabled = !$('capture-issue-store').value;
    } catch (error) {
      $('capture-error').textContent = error.message;
      $('capture-error').hidden = false;
    }
  }

  async function refreshIssueStore(force = false) {
    const id = state.issueId;
    if (!id || (!force && state.storeSelection === id)) return;
    state.storeSelection = id;
    try {
      const data = await issueStoreUI.fill($('issue-store'), { issueId: id });
      if (id !== state.issueId) return;
      $('issue-store').dataset.saved = data.selected;
      $('issue-store-source').textContent = issueStoreUI.savedLabel(data);
      const pendingMove = data.pendingMigrations?.find(
        (item) => item.kind === 'move-issue' && item.issueIds.includes(id)
      );
      $('resume-issue-store').hidden = !pendingMove;
      $('resume-issue-store').dataset.operation = pendingMove?.operationId || '';
      $('move-issue-store').disabled = true;
    } catch (error) {
      state.storeSelection = null;
      $('issue-store-error').textContent = error.message;
      $('issue-store-error').hidden = false;
    }
  }

  async function moveIssueStore(storeId) {
    const options = await issueStoreUI.read({ issueId: state.issueId, migrationStorageProfile: storeId });
    const issueIds = options.moveGroup?.issueIds || [state.issueId];
    const subject =
      issueIds.length > 1
        ? options.moveGroup?.masterId
          ? `the master issue and its ${issueIds.length - 1} attached sub-issues (${issueIds.length} issues)`
          : `${issueIds.length} issues in the pending storage move`
        : 'this issue';
    const storeName = (id) => options.stores.find((store) => store.id === id)?.label || id;
    const target = options.targetStorage;
    if (!target) throw Error('Choose a valid Issue storage profile.');
    if (
      !confirm(
        `Move ${subject}? Issue records: ${storeName(target.storeId)}. Artifacts: ${storeName(target.artifactStoreId)}. Existing history and references are retained.`
      )
    )
      return false;
    await issueStoreUI.move(state.issueId, storeId, { issueIds, expectedStorage: target });
    await refreshIssueStore(true);
    toast('Issue storage profile move confirmed.');
    return true;
  }

  function openPalette() {
    if (!state.view) return;
    $('block-palette').innerHTML =
      (state.index.catalog || [])
        .filter((kind) => !['request', 'cleanup', 'verify'].includes(kind.kind))
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
    const result = await action('request', { wording, background: true });
    if (!result) return;
    state.drafts.delete(key);
    persistDrafts();
    renderInspector();
    if (result.accepted) await load(true);
  }

  function blockSkillChanges(values, promptMode) {
    if (!Object.hasOwn(draft(), 'skill') && !Object.hasOwn(draft(), 'prompt-mode')) return {};
    return { skill: promptMode === 'skill' ? values.get('skill') || null : null };
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
      prompt: promptMode === 'text' ? String(values.get('prompt') || '') : '',
      lane: Number(values.get('lane') || 0),
      ...blockSkillChanges(values, promptMode),
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
    persistDrafts();
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
      contents += noChangesCloseOffer(preview);
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

  function noChangesCloseOffer(preview) {
    return preview.suggestedResolution === 'cannot-reproduce'
      ? '<button class="small-button" type="button" data-close-no-changes>Close as Cannot Reproduce…</button>'
      : '';
  }

  $('publish-preview').addEventListener('click', (event) => {
    if (!event.target.closest('[data-close-no-changes]')) return;
    $('publish-dialog').close();
    openClosure('cannot-reproduce');
  });

  function closeRename() {
    $('rename-issue-form').hidden = true;
    $('issue-title').parentElement.hidden = false;
    delete $('rename-issue-form').dataset.issue;
  }

  function mergeApproval(block) {
    return block?.kind === 'merge' && status(block) === 'blocked' ? latest(block)?.result?.mergeConfirmation : null;
  }

  async function startBlock(name, block) {
    const nativeRecovery =
      name === 'continue' && /^(anthropic|google):/.test(state.view.issueSettings?.values?.model || '');
    if (
      nativeRecovery &&
      !confirm(
        'Inspect completed file changes, command results, and retained output before continuing. Confirm that you reviewed the partial work and the original agent has stopped.'
      )
    )
      return;
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
      confirmedAgentRecovery: nativeRecovery,
      ...investigationRunInput(block),
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
    if (!expected || state.issueId !== issueId) return;
    if (
      !confirm(
        `Delete this worktree and discard its uncommitted changes?\n\n${expected.path}\n\nThe issue branch will be kept.`
      )
    )
      return;
    if (await action('delete-worktree', { expected })) toast('Worktree deleted.');
  }

  async function blockAction(button) {
    const block = activeBlock();
    if (!block) return;
    const name = button.dataset.action;
    if (name === 'agent-answer') {
      const card = button.closest('[data-agent-approval]');
      const inputs = [...card.querySelectorAll('[data-agent-question]')];
      const response = inputs.length
        ? { answers: Object.fromEntries(inputs.map((input) => [input.dataset.agentQuestion, input.value])) }
        : { decision: button.dataset.decision };
      const result = await action(name, {
        blockId: block.id,
        requestId: card.dataset.agentApproval,
        attemptId: card.dataset.attemptId,
        response,
      });
      if (result) for (const input of inputs) agentQuestionDrafts.delete(input.dataset.agentQuestionKey);
      return result;
    }
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
    if (result && name === 'remove') state.deleteBlockId = null;
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
    persistDrafts();
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

  function followFolderLink(event) {
    const link = event.target.closest('[data-open-folder-issue]');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    event.preventDefault();
    selectIssue(link.dataset.openFolderIssue);
    return true;
  }

  $('issue-list').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.folder) return selectFolder(button.dataset.folder);
    if (!button.dataset.toggleFolder) return;
    const folder = button.dataset.toggleFolder;
    const collapsedFolders = sidebarCollapsedFolders();
    const expanded = collapsedFolders.delete(folder);
    if (!expanded) collapsedFolders.add(folder);
    if (!state.search) view.write('flow-collapsed-folders', [...collapsedFolders]);
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${folder}`);
    button.closest('.issue-folder').querySelector('.folder-items').hidden = !expanded;
  });

  $('folder-workspace').addEventListener('click', (event) => {
    if (followFolderLink(event)) return;
    const button = event.target.closest('[data-folder-command]');
    if (button && !button.disabled && folderCommands[button.dataset.folderCommand])
      void folderCommands[button.dataset.folderCommand]();
  });

  $('issue-grouping').addEventListener('click', (event) => {
    if (followFolderLink(event)) return;
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.detachSubIssue)
      return void action('folder-detach', { subIssueId: button.dataset.detachSubIssue });
    if (button.hasAttribute('data-group-play') && state.view?.autoplay?.mode === 'paused') $('issue-playback').click();
  });

  document.addEventListener(
    'click',
    () => {
      state.deleteBlockId = null;
    },
    true
  );

  document.addEventListener('click', (event) => {
    const skillPicker = event.target.closest('[data-skill-picker]');
    if (skillPicker) return void openBlockSkillPicker(skillPicker.dataset.skillPicker);
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-destination-open')) {
      $('destination-heading').textContent = button.dataset.destinationLabel || 'Destination branch';
      $('destination-message').textContent = 'Checking branches…';
      for (const id of ['retry-branches', 'destination-choices', 'save-destination']) $(id).hidden = true;
      $('destination-dialog').showModal();
      return void loadDestinationBranches();
    }
    if (button.dataset.acceptBase) {
      return void action('accept-pr-base', { branch: button.dataset.acceptBase });
    }
    if (button.dataset.cleanupRetry) return void action('retry-closure', { resourceId: button.dataset.cleanupRetry });
    if (button.dataset.createFolderIssue) return openCapture(button.dataset.createFolderIssue);
    if (button.hasAttribute('data-open-project-issues')) return projectHome.openIssuesTab();
    if (button.dataset.issue) return selectIssue(button.dataset.issue);
    if (button.dataset.block) {
      state.blockId = button.dataset.block;
      if ($('graph').contains(button)) state.deleteBlockId = state.blockId;
      state.graphScrollIntent = { nodeId: state.blockId, mode: 'reveal' };
      renderGraph();
      renderInspector();
      setBusy(state.pending);
      return;
    }
    if (button.dataset.tab) {
      state.tab = button.dataset.tab;
      renderInspector();
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

  $('merge-state-menu').addEventListener('change', async (event) => {
    const operation = event.target.value;
    event.target.value = '';
    if (operation === 'abort' && (await action('abort-merge', { merge: state.view.environment.merge }))) {
      toast('Merge aborted. Saved issue commits are preserved.');
    }
  });

  $('target-update-menu').addEventListener('change', async (event) => {
    const menu = event.target;
    const operation = menu.value;
    menu.value = '';
    if (operation === 'update') return updateBranch();
    if (operation === 'add' && (await action('add', { kind: 'update-branch' }))) toast('Update Branch block added.');
  });

  document.addEventListener('change', async (event) => {
    const field = event.target;
    if (['retro-setting', 'auto-close-setting', 'full-regression-setting'].includes(field.id)) {
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
      const ref = field.value;
      field.blur();
      if (state.view.environment?.worktreeExists) {
        field.value = field.querySelector('option[selected]')?.value ?? '';
        openStartingBranchMove(ref);
      } else void action('starting-point', { ref }).then(() => load(true));
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
      void action('folder', { folder: new FormData(event.target).get('folder') }).then((result) => {
        if (!result) return;
        const saved = state.drafts.get(key) || {};
        delete saved.folder;
        state.drafts.set(key, saved);
        persistDrafts();
        return load(true);
      });
    }
  });

  $('open-sidebar-folder').addEventListener('click', async () => {
    try {
      await post('folder-settings', { ...folderLocation(), action: 'open' });
    } catch (error) {
      showError(error.message);
    }
  });
  $('folder-issue-view').addEventListener('change', (event) => {
    folderSelection = { ...emptyFolderSelection(), view: event.target.value };
    $('folder-search-form').reset();
    $('folder-search-status').hidden = true;
    renderFolderWorkspace();
  });
  $('folder-select-all').addEventListener('change', (event) => {
    const ids = new Set(folderSelection.issueIds);
    for (const issue of folderMembers()) {
      if (event.target.checked) ids.add(issue.id);
      else ids.delete(issue.id);
    }
    updateFolderSelection(ids);
  });
  $('folder-search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    folderSelection.query = $('folder-search-query').value.trim();
    folderSelection.matches = null;
    folderSelection.bulk = null;
    $('folder-search-status').hidden = true;
    renderFolderWorkspace();
  });
  $('folder-search-query').addEventListener('input', (event) => {
    if (event.target.value) return;
    folderSelection.query = '';
    folderSelection.matches = null;
    $('folder-search-status').hidden = true;
    renderFolderWorkspace();
  });
  $('folder-ai-search').addEventListener('click', () => void searchFolderAI());
  $('folder-selection-strategy').addEventListener('change', () => void changeFolderStrategy(false));
  $('copy-folder-strategy').addEventListener('click', () => void changeFolderStrategy(true));
  $('issue-settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await action(
      'issue-settings',
      { changes: Object.fromEntries(new FormData(event.target)) },
      { errorId: 'issue-settings-error' }
    );
    if (result) {
      $('issue-settings-error').hidden = true;
      toast('Issue settings saved.');
      await load(true);
    }
  });

  $('folder-member-list').addEventListener('change', (event) => {
    const { value, checked } = event.target;
    const ids = new Set(folderSelection.issueIds);
    if (checked) ids.add(value);
    else ids.delete(value);
    updateFolderSelection(ids);
  });
  $('folder-scan-list').addEventListener('change', renderFolderButtons);
  $('folder-scan-form').addEventListener('submit', (event) => void scanForFolderIssues(event));
  $('folder-scan-review').addEventListener('submit', (event) => void moveReviewedIssues(event));
  $('folder-group-form').addEventListener('submit', (event) => void createFolderMaster(event));
  document.addEventListener('change', async (event) => {
    const field = event.target;
    if (field.id !== 'issue-folder-locked') return;
    const locked = field.checked;
    if (!(await action('folder-lock', { locked })) && field.isConnected) field.checked = !locked;
  });

  window.openFlowCapture = openCapture;
  window.openFlowCaptureFromNote = (note) => {
    openCapture();
    state.captureNote = note;
    state.captureId = null;
    $('capture-description').value = note.text;
  };
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
  const startingBranchDialog = $('starting-branch-dialog');
  function openStartingBranchMove(ref) {
    const branch = state.view.branches.find((option) => option.ref === ref);
    startingBranchDialog.dataset.ref = ref;
    startingBranchDialog.dataset.issue = state.issueId;
    $('starting-branch-target').textContent = 'Move this issue to ' + (branch?.name ?? ref) + '?';
    $('starting-branch-error').hidden = true;
    startingBranchDialog.showModal();
  }
  $('move-starting-branch').addEventListener('click', async () => {
    const { ref, issue } = startingBranchDialog.dataset;
    if (issue !== state.issueId) return startingBranchDialog.close();
    $('starting-branch-error').hidden = true;
    const result = await action('starting-point', { ref, confirmed: true }, { errorId: 'starting-branch-error' });
    if (result) {
      startingBranchDialog.close();
      toast('Moved the issue to the selected starting branch.');
    }
    await load(true);
  });
  $('destination-dialog')
    .querySelector('form')
    .addEventListener('submit', async (event) => {
      if (event.submitter?.id !== 'save-destination') return;
      event.preventDefault();
      const branch = $('destination-branch').value || null;
      const storeId = $('destination-issue-store').value;
      if (storeId && storeId !== $('destination-issue-store').dataset.saved) {
        try {
          if (!(await moveIssueStore(storeId))) return;
        } catch (error) {
          $('destination-message').textContent = error.message;
          return;
        }
      }
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
  $('project-settings').addEventListener('click', () => projectSettingsUI.open());
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

  async function archiveIssueWithUiState(issueId) {
    if (!issueId || state.pending) return;
    state.pending = true;
    setBusy(true);
    try {
      await archiveIssue(issueId);
    } catch (error) {
      showError(error.message);
    } finally {
      state.pending = false;
      setBusy(false);
      void load(true);
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
    if (operation === 'archive') return void archiveIssueWithUiState(issueId);
    state.pending = true;
    setBusy(true);
    try {
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

  function openClosure(suggestedResolution) {
    const { issue, flow } = state.view;
    void closureDialog.open(async () => ({
      ...(await json('/api/issue-closure?issue=' + encodeURIComponent(issue.id))),
      kind: 'close',
      flowRevision: flow.revision,
      offerClosureRetro: flow.blocks.some((block) => block.kind === 'retro'),
      suggestedResolution,
    }));
  }
  $('close-with-reason').addEventListener('click', () => openClosure());
  $('issue-pr-menu').addEventListener('click', (event) => {
    if (event.target.closest('a')) $('issue-pr-menu').open = false;
  });
  $('retry-closure').addEventListener('click', () => void action('retry-closure'));
  $('skip-retro').addEventListener('click', () => {
    if (confirm('Continue to Cleanup without a completed retro?')) void action('skip-retro');
  });
  $('approve-issue').addEventListener('click', async () => {
    if (await action('approve-issue')) void load(true);
  });
  $('delete-pending-issue').addEventListener('click', async () => {
    const issue = state.view?.issue;
    if (issue?.state !== 'needs-approval') return;
    const result = await action('delete-pending-issue', { title: issue.title });
    if (!result) return;
    if (result.publication) {
      toast(
        result.publication.status === 'review' ? 'Deletion awaits merge of the queue PR.' : result.publication.error
      );
    } else if (state.issueId === issue.id) {
      selectIssue(null);
      return;
    }
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
          ? 'Saved locally. The queue PR is awaiting merge.'
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
    const mode = playbackAction(state.view?.flow?.blocks || []);
    if (mode === 'pause') return void action('pause');
    if (mode === 'close') return openClosure();
    if (mode === 'archive') return void archiveIssueWithUiState(state.view.issue.id);
    if (!['start', 'resume'].includes(mode)) return;
    const hasDraft = [...state.drafts].some(
      ([key, values]) =>
        key.startsWith(state.issueId + '/') &&
        Object.keys(values).some((field) => !['comment', 'newEdit'].includes(field))
    );
    if (hasDraft) return showError('Save your block settings before starting or resuming. Your drafts are still here.');
    void action('play');
  });
  document.addEventListener('factory-actions-paused', ({ detail }) => {
    state.newActionsPaused = detail;
    setBusy(state.pending);
    if (state.folder) {
      renderFolderRun();
      renderFolderButtons();
    }
  });
  $('issue-input-continue').addEventListener('click', () => {
    const block = state.view?.flow.blocks.find((block) => block.id === state.view.humanInput?.blockId);
    if (!block) return;
    state.blockId = block.id;
    if (state.view.humanInput.kind === 'agent') {
      state.tab = 'details';
      render();
      return;
    }
    render();
    void startBlock('continue', block);
  });
  $('refresh').addEventListener('click', () => {
    if (projectHome.isVisible()) {
      void projectHome.refresh(true);
      return;
    }
    void load(true, true);
    if (state.folder || state.fileFolder)
      void folderSettingsUI.refresh().catch((failure) => showError(failure.message));
  });
  $('dismiss-error').addEventListener('click', () => {
    state.error = '';
    state.connectionError = '';
    renderErrors();
  });
  $('issue-search').addEventListener('input', (event) => {
    state.search = event.target.value;
    state.collapsedSearchFolders.clear();
    renderSidebar();
  });
  $('new-folder').addEventListener('click', () => {
    $('folder-error').hidden = true;
    $('folder-dialog').showModal();
    $('folder-name').focus();
  });

  $('capture-folder').addEventListener('change', () => void loadCaptureStore());
  $('resume-issue-store').addEventListener('click', async () => {
    if (state.pending) return;
    $('issue-store-error').hidden = true;
    try {
      $('issue-store-form').inert = true;
      await issueStoreUI.resumeMove(state.issueId, $('resume-issue-store').dataset.operation);
      await refreshIssueStore(true);
      toast('Issue storage move confirmed.');
    } catch (error) {
      $('issue-store-error').textContent = error.message;
      $('issue-store-error').hidden = false;
    } finally {
      $('issue-store-form').inert = false;
    }
  });
  $('issue-store').addEventListener('change', () => {
    $('move-issue-store').disabled =
      !$('issue-store').value || $('issue-store').value === $('issue-store').dataset.saved;
  });
  $('issue-store-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.pending || !$('issue-store').value) return;
    $('issue-store-error').hidden = true;
    try {
      $('issue-store-form').inert = true;
      await moveIssueStore($('issue-store').value);
    } catch (error) {
      $('issue-store-error').textContent = error.message;
      $('issue-store-error').hidden = false;
    } finally {
      $('issue-store-form').inert = false;
    }
  });

  $('capture-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const description = $('capture-description').value.trim();
    if (!description || !$('capture-folder').value || !$('capture-issue-store').value || state.pending) return;
    state.captureId ||= crypto.randomUUID();
    $('capture-error').hidden = true;
    const result = await action(
      'capture',
      {
        requestId: state.captureId,
        description,
        type: $('capture-type').value,
        folder: $('capture-folder').value,
        storageProfile: $('capture-issue-store').value,
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
    if (id && state.captureNote) {
      const note = state.captureNote;
      state.captureNote = null;
      try {
        await window.localNotesUI.issueCreated(note, id);
      } catch (error) {
        toast('Issue created. Open it from Local notes. Discussion could not be prepared: ' + error.message);
      }
      return;
    }
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

  $('migrate-issue-folders').addEventListener('click', async () => {
    const result = await action('migrate-folders', {}, { global: true });
    if (!result) return;
    window.dispatchEvent(new CustomEvent('factory-issue-folders-migrated'));
    toast('Moved existing issue folders.');
  });

  $('folder-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('folder-name').value.trim();
    if (!name || state.pending) return;
    $('folder-error').hidden = true;
    const result = await action('create-folder', { name }, { global: true, errorId: 'folder-error' });
    if (!result) return;
    window.dispatchEvent(new CustomEvent('factory-issue-folder-created', { detail: name }));
    $('folder-name').value = '';
    $('folder-dialog').close();
    toast('Folder created.');
    await load(true);
  });

  document.addEventListener('focusin', (event) => {
    if (!$('graph').contains(event.target)) state.deleteBlockId = null;
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') state.deleteBlockId = null;
    if (
      ['Delete', 'Backspace'].includes(event.key) &&
      !event.repeat &&
      !event.isComposing &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') &&
      !document.querySelector('dialog[open]') &&
      state.deleteBlockId &&
      state.deleteBlockId === state.blockId &&
      !$('delete-block').disabled
    ) {
      event.preventDefault();
      void blockAction($('delete-block'));
      return;
    }
    if (
      !window.FactoryHotkeys.matches(event, 'newIssue') ||
      event.target.closest('input, textarea, select, [contenteditable="true"]') ||
      document.querySelector('dialog[open]')
    )
      return;
    event.preventDefault();
    openCapture();
  });
  window.addEventListener('resize', resizeColumns);
  let graphScrollIdleTimer;
  $('graph-scroll').addEventListener(
    'scroll',
    () => {
      $('graph-scroll').dataset.scrolling = '';
      clearTimeout(graphScrollIdleTimer);
      graphScrollIdleTimer = setTimeout(() => delete $('graph-scroll').dataset.scrolling, 700);
    },
    { passive: true }
  );
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
