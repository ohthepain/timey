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
    skills: new Map(),
    loading: false,
    pending: false,
    sequence: 0,
    controller: null,
    error: '',
    connectionError: '',
    captureId: null,
    toastTimer: null,
  };
  const kinds = {
    request: { icon: '○', color: '#aaa49b', description: 'The goal and the evidence that will show it is done.' },
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
    'merge-target': { icon: '⑂', color: '#7c9acb', description: 'Bring target branch changes into the issue.' },
    retro: { icon: '↶', color: '#aaa0ca', description: 'Record lessons and suggested follow-up work.' },
    close: { icon: '⊙', color: '#999999', description: 'Record the decision to close this issue.' },
    'delete-worktree': {
      icon: '⌫',
      color: '#999999',
      description: 'Remove the issue checkout after reviewing its records.',
    },
  };
  const requestFields = [
    ['goal', 'The goal', 'What is wrong, or what do you want?'],
    ['doneCheck', 'The done check', 'What must pass or fail?'],
    ['proof', 'The proof', 'What output, recording or stored value should we retain?'],
    ['knownFacts', 'What you already know', 'A symptom, a reproduction step, a log line or a link.'],
    ['constraints', 'The real constraints', 'What should the work respect?'],
  ];
  const runningStatuses = new Set(['running', 'starting', 'stopping', 'in-progress']);
  let projectSettings = null;

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
    return kinds[kind] || { icon: '□', color: '#999999', description: 'An explicit step in this issue.' };
  }

  function latest(block) {
    return block?.attempts?.at(-1) || null;
  }

  function status(block) {
    return latest(block)?.status || (block?.suggested ? 'suggested' : 'ready');
  }

  function isRunning(block) {
    return runningStatuses.has(status(block));
  }

  function statusIcon(value) {
    const normalized = String(value || 'new').replaceAll('_', '-');
    const icons = {
      running: '◌',
      'in-progress': '◌',
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
    const message = state.error || state.connectionError;
    $('error-banner').hidden = !message;
    $('error-message').textContent = message;
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
          result.issue.location === 'closed' || result.issue.state === 'closed'
            ? { nodeId: '__destination', mode: 'end' }
            : attempted.length === 0
              ? { nodeId: '__base', mode: 'start' }
              : { nodeId: state.blockId, mode: 'center' };
      }
      if (Array.isArray(result.availableSkills)) state.skills.set(state.issueId, result.availableSkills);
    }
    if (result.error) state.error = result.error;
    render();
  }

  async function load(force = false) {
    if (state.pending || (state.loading && !force)) return;
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
      if (sequence !== state.sequence || selected !== state.issueId) return;
      state.connectionError = '';
      $('connection-status').className = 'connection';
      $('connection-status').innerHTML = '<span class="connection-dot"></span> Live · 2s';
      applyView(result);
    } catch (error) {
      if (error.name === 'AbortError' || sequence !== state.sequence) return;
      state.connectionError = `Unable to refresh. ${error.message} The last saved view remains visible.`;
      $('connection-status').className = 'connection offline';
      $('connection-status').innerHTML = '<span class="connection-dot"></span> Reconnecting';
      renderErrors();
    } finally {
      if (sequence === state.sequence) state.loading = false;
    }
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
      const result = await json('/api/flow-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-factory-action': 'manual' },
        body: JSON.stringify({ action: name, ...(options.global ? {} : { issueId: selected, revision }), ...fields }),
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
      .querySelectorAll('[data-action], [data-add-kind], #capture-submit, #folder-form button[type="submit"]')
      .forEach((button) => {
        button.disabled = busy || (button.dataset.action === 'remove' && isRunning(activeBlock()));
      });
    document
      .querySelectorAll('#inspector-body input, #inspector-body select, #inspector-body textarea')
      .forEach((field) => {
        field.disabled = busy;
      });
    $('continue-block').disabled =
      busy || !activeBlock() || activeBlock().readOnly || state.view.flow.blocks.some(isRunning);
    const startingBranch = $('starting-branch');
    if (startingBranch)
      startingBranch.disabled = busy || !state.view.startingPointEditable || !state.view.branches?.length;
    const worktreeMenu = $('worktree-menu');
    if (worktreeMenu) worktreeMenu.disabled = busy;
  }

  function selectIssue(id) {
    if (state.issueId === id && state.view) return;
    state.issueId = id;
    state.blockId = null;
    state.graphScrollIntent = null;
    state.view = null;
    state.error = '';
    const url = new URL(location.href);
    url.searchParams.set('issue', id);
    history.replaceState(null, '', url);
    render();
    void load(true);
  }

  function renderSidebar() {
    const project = state.index.project;
    $('project-label').textContent =
      typeof project === 'string'
        ? project.split('/').filter(Boolean).at(-1) || project
        : project?.name || 'Local workspace';
    $('project-label').title = typeof project === 'string' ? project : project?.path || '';
    const issues = (state.index.issues || []).filter((issue) =>
      `${issue.title} ${issue.issueNumber || ''}`.toLowerCase().includes(state.search.toLowerCase())
    );
    const folders = [
      ...new Set([...(state.index.folders || []), ...issues.map((issue) => issue.folder).filter(Boolean)]),
    ];
    const row = (issue) =>
      `<button class="issue-row${issue.id === state.issueId ? ' selected' : ''}" data-issue="${escape(issue.id)}" title="${escape(issue.title)}"${issue.id === state.issueId ? ' aria-current="page"' : ''}>${statusIcon(issue.status)}<span class="issue-name">${issue.issueNumber ? `#${escape(issue.issueNumber)} - ` : ''}${escape(issue.title)}</span></button>`;
    const ungrouped = issues
      .filter((issue) => !issue.folder && issue.status !== 'closed')
      .map(row)
      .join('');
    const groups = folders
      .map((folder) => {
        const children = issues.filter((issue) => issue.folder === folder && issue.status !== 'closed');
        if (state.search && children.length === 0) return '';
        const collapsed = state.folders.has(folder) && !state.search;
        return `<section class="issue-folder"><button class="folder-toggle" data-folder="${escape(folder)}" aria-expanded="${!collapsed}"><span class="folder-chevron" aria-hidden="true">${collapsed ? '›' : '⌄'}</span><span aria-hidden="true">▱</span><span>${escape(folder)}</span><span class="folder-count">${children.length}</span></button><div class="folder-items"${collapsed ? ' hidden' : ''}>${children.map(row).join('') || '<p class="sidebar-empty">No issues yet.</p>'}</div></section>`;
      })
      .join('');
    $('issue-list').innerHTML =
      ungrouped +
        groups +
        (issues.some((issue) => issue.status === 'closed')
          ? `<details class="issue-folder"${state.search ? ' open' : ''}><summary class="folder-toggle">Closed issues <span class="folder-count">${issues.filter((issue) => issue.status === 'closed').length}</span></summary><div class="folder-items">${issues
              .filter((issue) => issue.status === 'closed')
              .map(row)
              .join('')}</div></details>`
          : '') ||
      `<p class="sidebar-empty">${state.search ? 'No matching issues.' : 'Your issues will appear here.'}</p>`;
  }

  function renderEnvironment() {
    const environment = state.view?.environment;
    if (
      environment?.worktreeExists === true &&
      document.activeElement === $('worktree-menu') &&
      $('environment').dataset.issue === state.issueId
    )
      return;
    $('environment').hidden = !environment;
    $('environment').dataset.issue = state.issueId || '';
    if (!environment) return;
    const chips = [];
    if (environment.branch)
      chips.push(`<span class="environment-chip" title="Current issue branch">⑂ ${escape(environment.branch)}</span>`);
    if (environment.dirty === true) chips.push('<span class="environment-chip warning">● Uncommitted changes</span>');
    if (environment.worktreeExists === false) chips.push('<span class="environment-chip">No checkout</span>');
    if (environment.behind > 0)
      chips.push(
        `<button class="environment-chip warning" data-sync-target title="Add a block to merge changes from the target branch">↙ Target ahead by ${escape(environment.behind)}</button>`
      );
    if (environment.ahead > 0) chips.push(`<span class="environment-chip">↑ ${escape(environment.ahead)} ahead</span>`);
    if (environment.worktreeExists === true)
      chips.push(
        '<select class="environment-chip" id="worktree-menu" aria-label="Worktree"><option value="" disabled selected>Worktree</option><option value="open">Open</option><option value="update">Update</option></select>'
      );
    if (environment.pr) {
      const pr = environment.pr;
      const url = safeUrl(pr.url);
      chips.push(
        url
          ? `<a class="environment-chip${pr.mergedAt ? ' good' : ''}" href="${escape(url)}" target="_blank" rel="noopener noreferrer">PR #${escape(pr.number)} · ${escape(pr.mergedAt ? 'merged' : words(pr.state))} ↗</a>`
          : `<span class="environment-chip">PR #${escape(pr.number)} · ${escape(words(pr.state))}</span>`
      );
    }
    if (environment.error || environment.remoteError)
      chips.push(
        `<span class="environment-chip warning" title="${escape(environment.error || environment.remoteError)}">Environment check incomplete</span>`
      );
    $('environment').innerHTML = chips.join('');
    $('environment').title = environment.observedAt ? `Git observed ${date(environment.observedAt)}` : '';
  }

  function safeUrl(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
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

  function blockCard(block) {
    const style = blockStyle(block.kind);
    const attempt = latest(block);
    const currentStatus = status(block);
    const hasEvidence = attempt?.evidence?.length || 0;
    const description = attempt?.summary || block.prompt || style.description;
    return `<button class="block-card${state.blockId === block.id ? ' selected' : ''}${block.suggested ? ' suggested' : ''}" style="--block-color:${style.color}" data-block="${escape(block.id)}" data-node="${escape(block.id)}" aria-pressed="${state.blockId === block.id}"><span class="block-port top"></span><span class="block-topline"><span class="block-icon" aria-hidden="true">${style.icon}</span>${escape(words(block.kind))}<span class="block-status${isRunning(block) ? ' running' : ''}">${escape(words(currentStatus))}</span></span><span class="block-label">${escape(block.label || words(block.kind))}</span><span class="block-description">${escape(description)}</span><span class="block-bottomline"><span>${escape(block.skill || (block.suggested ? 'Suggested next step' : 'Choose a skill'))}</span><span>${hasEvidence ? `${hasEvidence} evidence` : attempt ? `Attempt ${block.attempts.length}` : block.lane > 0 ? `Lane ${block.lane + 1}` : 'View details ↗'}</span></span><span class="block-port bottom"></span></button>`;
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
    const point = flow.startingPoint;
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
          ? 'Used as the default for new issues.'
          : 'Starting point is fixed after work begins.');
    const layers = graphLayers(blocks);
    const destination = `<div class="graph-terminal destination" data-node="__destination"><span class="terminal-label">Destination</span><span class="terminal-branch">⑂ ${escape(branch)}</span><span class="terminal-note">${escape(target.remote || 'local target')}</span></div>`;
    const baseNode = `<div class="graph-terminal base" data-node="__base"><span class="terminal-label">Starting point</span><label class="starting-branch-label" for="starting-branch">Starting branch</label><select id="starting-branch" aria-describedby="starting-branch-note" title="Used as the default for new issues.">${options.join('')}</select>${pinnedCommit ? `<span class="terminal-note starting-commit" title="${escape(pinnedCommit)}">Base ${escape(pinnedCommit.slice(0, 12))}</span>` : ''}${flow.workspace?.branch ? `<span class="terminal-note">${escape(flow.workspace.branch)}</span>` : ''}<span class="terminal-note" id="starting-branch-note">${escape(startingNote)}</span></div>`;
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

  function typeOptions(type) {
    return [
      ['feature', 'Feature'],
      ['bug', 'Bug fix'],
      ['investigation', 'Investigation'],
    ]
      .map(([value, label]) => `<option value="${value}"${type === value ? ' selected' : ''}>${label}</option>`)
      .join('');
  }

  function saveRow() {
    const dirty = Object.keys(draft()).length > 0;
    return `<div class="save-row"><span id="draft-note" class="${dirty ? 'draft-note' : 'saved-note'}">${dirty ? 'Unsaved changes' : 'Saved locally'}</span><button type="submit" class="small-button" data-action="save"${state.pending ? ' disabled' : ''}>Save changes</button></div>`;
  }

  function requestDetails() {
    const flow = state.view.flow;
    const request = flow.request || {};
    const values = { ...request, type: flow.type, ...draft() };
    const folders = [...new Set([...(state.index.folders || []), ...(flow.folder ? [flow.folder] : [])])];
    return `<section class="detail-section"><div class="section-label">Original request</div><form id="request-form">${formField('wording', 'Your words', values.wording, 'The original request.', 4)}<label class="field">Issue type<select name="type" data-field="type">${typeOptions(values.type)}</select></label>${requestFields.map(([name, label, hint]) => formField(name, label, values[name], hint)).join('')}${saveRow()}</form></section><section class="detail-section"><div class="section-label">Organization</div><form id="issue-folder-form"><label class="field">Folder<select id="issue-folder" name="folder" data-field="folder"><option value="">No folder</option>${folders.map((folder) => `<option value="${escape(folder)}"${(values.folder ?? flow.folder) === folder ? ' selected' : ''}>${escape(folder)}</option>`).join('')}</select></label><button type="submit" class="small-button" data-action="folder"${state.pending ? ' disabled' : ''}>Move issue</button></form></section><section class="detail-section"><p class="detail-copy">Save your request, then select or add the next block. Every operation starts with your click.</p></section>`;
  }

  function skillOptions(block, selected) {
    const catalog = state.index.catalog.find((entry) => entry.kind === block.kind);
    const available = state.skills.get(state.issueId) || [];
    const skills = new Set([
      ...(catalog?.skills || []),
      ...available.map((skill) => (typeof skill === 'string' ? skill : skill.name)),
      ...(selected ? [selected] : []),
    ]);
    return `<option value="">Use block default</option>${[...skills]
      .filter(Boolean)
      .map(
        (skill) => `<option value="${escape(skill)}"${skill === selected ? ' selected' : ''}>${escape(skill)}</option>`
      )
      .join('')}`;
  }

  function evidenceLinks(attempt) {
    return (attempt?.evidence || [])
      .map(
        (evidence) =>
          `<button class="evidence-link" data-open-file="${escape(evidence.path)}"><span aria-hidden="true">▤</span><span>${escape(evidence.label || evidence.path)}</span></button>`
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
    return `<div class="block-progress"><div class="progress-heading"><span>${statusIcon(attempt.status)} ${escape(words(attempt.status))}</span><span class="progress-meta">Attempt ${index + 1}</span></div><p class="detail-copy">${escape(summary)}</p><p class="progress-meta" style="margin-top:9px">${escape(date(attempt.startedAt))}${attempt.endedAt ? ` · ended ${escape(date(attempt.endedAt))}` : ''}</p>${attempt.output ? `<pre class="attempt-output">${escape(attempt.output)}</pre>` : ''}${result && result !== summary ? `<pre class="attempt-output">${escape(result)}</pre>` : ''}${evidenceLinks(attempt)}</div>`;
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

  function blockDetails(block) {
    if (block.readOnly)
      return `<section class="detail-section"><p class="detail-copy">This operation started through the existing issue controls. Inspect or stop it there before starting a new flow block.</p><a href="/classic?issue=${encodeURIComponent(state.issueId)}">Open its original controls</a>${block.attempts.map(attemptCard).join('')}</section>`;
    if (block.kind === 'request') return requestDetails();
    const changes = draft();
    const values = { ...block, ...changes };
    const attempts = block.attempts || [];
    const last = latest(block);
    const intent =
      block.kind === 'verify' || block.kind === 'benchmark'
        ? 'Verification intent'
        : block.kind === 'prototype'
          ? 'Prototype intent'
          : 'Instructions';
    const running = isRunning(block);
    const locked = state.pending ? ' disabled' : '';
    return `<section class="detail-section"><div class="section-label">${running ? 'Current progress' : 'Progress'}<span>${escape(words(status(block)))}</span></div>${last ? attemptCard(last, attempts.length - 1) : '<p class="inline-empty">This block has not run yet. Choose a skill and review its instructions before starting.</p>'}${attempts.length > 1 ? `<details class="attempt-history"><summary>${attempts.length - 1} earlier ${attempts.length === 2 ? 'attempt' : 'attempts'}</summary>${attempts.slice(0, -1).map(attemptCard).join('')}</details>` : ''}<div class="block-actions">${running ? `<button class="small-button danger-button" data-action="stop"${locked}>■ Stop block</button>` : `<button class="primary-button" data-action="start"${locked}>▷ ${block.kind === 'prototype' ? (last ? 'Run prototype again' : 'Run prototype') : last ? 'Retry block' : block.suggested ? 'Start this step' : 'Start block'}</button>${last ? `<button class="small-button" data-action="continue"${locked}>Continue</button>` : ''}`}</div></section><form id="block-form"><section class="detail-section" style="margin-top:23px;padding-top:22px;border-top:1px solid var(--line)"><div class="section-label">Block settings<button class="small-button" type="button" data-refresh-skills${locked}>↻ Skills</button></div><label class="field">Name<input name="label" data-field="label" value="${escape(values.label || '')}" /></label><label class="field">Skill<select name="skill" data-field="skill">${skillOptions(block, values.skill)}</select><small>Refresh skills to read the installed project catalog.</small></label>${formField('prompt', intent, values.prompt, blockStyle(block.kind).description, 4)}<div class="field-row"><label class="field">Parallel lane<select name="lane" data-field="lane">${[0, 1, 2, 3].map((lane) => `<option value="${lane}"${Number(values.lane || 0) === lane ? ' selected' : ''}>${lane === 0 ? 'Main lane' : `Parallel lane ${lane + 1}`}</option>`).join('')}</select></label>${block.kind === 'sol' ? `<label class="field">Iterations<input type="number" name="iterations" data-field="iterations" min="1" max="20" value="${escape(values.iterations || 1)}" /></label>` : ''}</div></section>${editChecklist(block, changes)}${saveRow()}</form><section class="detail-section"><div class="section-label">Sequence</div><p class="detail-copy">Move this step toward the destination or toward the starting point.</p><div class="block-actions"><button class="small-button" data-action="move" data-direction="down"${locked}>↑ Earlier</button><button class="small-button" data-action="move" data-direction="up"${locked}>↓ Later</button><button class="small-button danger-button" data-action="remove"${running || state.pending ? ' disabled' : ''}>Remove</button></div></section>${comments(block)}`;
  }

  function renderConversation(block) {
    const messages = state.view?.conversation || [];
    return `<p class="conversation-context">One conversation belongs to this issue. Notes and output retain the block they came from.</p>${messages.length ? `<div class="timeline">${messages.map((message) => `<article class="message"><div class="message-meta"><span class="message-author">${escape(message.actor || message.role || 'Factory')}${message.blockId ? ` · ${escape(state.view.flow.blocks.find((entry) => entry.id === message.blockId)?.label || 'Block')}` : ''}</span><time>${escape(date(message.at))}</time></div><p class="message-body">${escape(message.body)}</p></article>`).join('')}</div>` : '<p class="inline-empty">No conversation entries yet. Starting a block will retain its activity here.</p>'}${block ? commentForm(block) : ''}`;
  }

  function renderArtifacts() {
    const artifacts = state.view?.artifacts || [];
    return `<p class="conversation-context">Saved records for this issue. Inspect an artifact before deciding to remove it.</p>${artifacts.length ? artifacts.map((artifact) => `<article class="artifact"><div class="artifact-header"><h3>${escape(artifact.label)}</h3><span class="artifact-kind">${escape(words(artifact.kind))}</span></div><p class="artifact-path">${escape(artifact.path)}</p><div class="artifact-actions">${artifact.exists ? `<button class="small-button" data-open-file="${escape(artifact.path)}">Inspect ↗</button>` : '<span class="progress-meta">Not present</span>'}${artifact.deletable && artifact.exists ? `<button class="small-button danger-button" data-delete-artifact="${escape(artifact.id)}"${state.pending ? ' disabled' : ''}>Delete</button>` : ''}</div></article>`).join('') : '<p class="inline-empty">No retained artifacts yet. Evidence and records will appear here as work is saved.</p>'}`;
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
    const openHistory = body.querySelector('.attempt-history')?.open;
    renderBody();
    if (key) {
      const replacement = [...body.querySelectorAll('[data-field], [id], [data-edit]')].find(
        (element) => (element.dataset.field || element.id || element.dataset.edit) === key
      );
      if (replacement) {
        replacement.focus({ preventScroll: true });
        if (selection && replacement.setSelectionRange) replacement.setSelectionRange(...selection);
      }
    }
    if (openHistory && body.querySelector('.attempt-history')) body.querySelector('.attempt-history').open = true;
    body.scrollTop = scroll;
    if (outputScroll != null && body.querySelector('.attempt-output'))
      body.querySelector('.attempt-output').scrollTop = outputScroll;
  }

  function renderInspector() {
    const block = activeBlock();
    const style = blockStyle(block?.kind);
    $('inspector-kind').textContent = block ? words(block.kind) : 'Block details';
    $('inspector-title').style.setProperty('--block-color', style.color);
    $('inspector-title').innerHTML =
      `<span class="inspector-symbol" aria-hidden="true">${block ? style.icon : '◇'}</span><h2>${escape(block?.label || 'Select a block')}</h2>`;
    $('artifact-count').textContent = state.view?.artifacts?.length || '';
    for (const button of document.querySelectorAll('[data-tab]'))
      button.setAttribute('aria-selected', String(button.dataset.tab === state.tab));
    $('inspector-body').setAttribute('aria-labelledby', `tab-${state.tab}`);
    preserveEditor(() => {
      $('inspector-body').innerHTML = !state.view
        ? '<div class="inspector-empty"><span aria-hidden="true">↖</span><p>Select an issue and a block to inspect its intent, progress and evidence.</p></div>'
        : state.tab === 'artifacts'
          ? renderArtifacts()
          : state.tab === 'conversation'
            ? renderConversation(block)
            : block
              ? blockDetails(block)
              : '<p class="inline-empty">Add a block to begin this issue.</p>';
    });
  }

  function render() {
    renderSidebar();
    const issue = state.view?.issue;
    $('issue-heading').hidden = !issue;
    $('issue-type-label').textContent = issue ? words(state.view.flow.type || issue.type || 'Issue') : 'Workspace';
    $('issue-number').textContent = issue?.issueNumber ? `#${issue.issueNumber}` : issue ? 'Issue flow' : 'Issue flow';
    $('issue-title').textContent = issue?.title || '';
    const blocks = state.view?.flow?.blocks || [];
    const running = blocks.find((block) => isRunning(block));
    const completed = blocks.filter((block) => ['completed', 'succeeded', 'success'].includes(status(block))).length;
    $('issue-subtitle').textContent = issue
      ? `${words(issue.status || 'new')} · ${blocks.length} blocks${completed ? ` · ${completed} completed` : ''}${running ? ` · ${running.label} running` : ''}`
      : '';
    $('flow-footer-label').textContent = running
      ? `${running.label} is running`
      : state.view
        ? 'Saved flow · only started blocks run'
        : 'Changes are saved locally';
    renderEnvironment();
    renderGraph();
    renderInspector();
    renderErrors();
    setBusy(state.pending);
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
        .filter((kind) => kind.kind !== 'request')
        .map((kind) => {
          const style = blockStyle(kind.kind);
          return `<button class="palette-item" style="--block-color:${style.color}" data-add-kind="${escape(kind.kind)}"${state.pending ? ' disabled' : ''}><strong><span class="block-icon" aria-hidden="true">${style.icon}</span>${escape(kind.label)}</strong><small>${escape(kind.description || style.description)}</small></button>`;
        })
        .join('') ||
      '<p class="inline-empty">The block catalog is unavailable. Refresh the workspace to try again.</p>';
    $('palette-dialog').showModal();
  }

  async function addBlock(kind) {
    const selected = activeBlock();
    const result = await action('add', { kind, ...(selected && !selected.suggested ? { afterId: selected.id } : {}) });
    if (!result) return;
    $('palette-dialog').close();
    toast('Block added. Choose its skill and start it when ready.');
    await load(true);
  }

  async function saveRequest(event) {
    event.preventDefault();
    const key = draftKey();
    const values = new FormData(event.target);
    const request = Object.fromEntries(
      ['wording', ...requestFields.map(([name]) => name)].map((name) => [name, String(values.get(name) || '')])
    );
    const result = await action('request', { request, type: values.get('type') });
    if (!result) return;
    state.drafts.delete(key);
    toast('Request saved.');
    await load(true);
  }

  async function saveBlock(event) {
    event.preventDefault();
    const block = activeBlock();
    if (!block) return;
    const key = draftKey();
    const values = new FormData(event.target);
    const changes = {
      label: String(values.get('label') || ''),
      skill: values.get('skill') || null,
      prompt: String(values.get('prompt') || ''),
      lane: Number(values.get('lane') || 0),
    };
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

  async function startBlock(name, block) {
    const unsaved = Object.keys(draft()).filter((key) => !['comment', 'newEdit'].includes(key));
    if (unsaved.length) {
      showError('Save your block settings before starting. Your draft is still here.');
      return;
    }
    if (
      block.kind === 'merge' &&
      !confirm(
        `Merge this issue into ${state.view.flow.target?.branch || 'the target branch'}? This changes the target branch.`
      )
    )
      return;
    if (
      block.kind === 'merge-target' &&
      !confirm(`Merge changes from ${state.view.flow.target?.branch || 'the target branch'} into this issue checkout?`)
    )
      return;
    if (
      block.kind === 'close' &&
      !confirm(`Close "${state.view.issue.title}"? This records your decision to end this issue.`)
    )
      return;
    if (
      block.kind === 'delete-worktree' &&
      !confirm(
        `Delete this issue checkout and its local conversation files?\n\n${state.view.flow.workspace?.checkout || 'No checkout path is recorded.'}\n\nReview the artifacts before proceeding.`
      )
    )
      return;
    if (
      block.kind === 'publish' &&
      !confirm(
        `Push this issue branch and publish its verified pull request?\n\n${state.view.flow.workspace?.branch || 'The saved issue branch'}`
      )
    )
      return;
    const confirmed = ['publish', 'merge', 'merge-target', 'close', 'delete-worktree'].includes(block.kind);
    const result = await action(name, { blockId: block.id, ...(confirmed ? { confirmed: true } : {}) });
    if (result) await load(true);
  }

  async function blockAction(button) {
    const block = activeBlock();
    if (!block) return;
    const name = button.dataset.action;
    if (['start', 'continue'].includes(name)) return startBlock(name, block);
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

  async function refreshSkills(button) {
    if (state.pending) return;
    const selected = state.issueId;
    button.disabled = true;
    button.textContent = 'Refreshing…';
    try {
      const result = await json(`/api/flow-skills?issue=${encodeURIComponent(selected)}`);
      if (result.error) throw new Error(result.error);
      state.skills.set(selected, result.skills || []);
      if (selected === state.issueId) renderInspector();
      toast(`${result.skills?.length || 0} installed skills loaded.`);
    } catch (error) {
      showError(error.message);
    } finally {
      button.disabled = false;
      button.textContent = '↻ Skills';
    }
  }

  async function inspectFile(path) {
    $('file-title').textContent = path;
    $('file-content').textContent = 'Reading artifact…';
    if (!$('file-dialog').open) $('file-dialog').showModal();
    try {
      const result = await json(`/api/shown-file?path=${encodeURIComponent(path)}`);
      if (result.error) throw new Error(result.error);
      if ($('file-title').textContent === path)
        $('file-content').textContent = result.content ?? result.file?.content ?? 'No text content returned.';
    } catch (error) {
      if ($('file-title').textContent === path) $('file-content').textContent = error.message;
    }
  }

  async function deleteArtifact(id) {
    const artifact = state.view?.artifacts?.find((item) => item.id === id);
    if (!artifact?.deletable) return;
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
      return;
    }
    if (button.dataset.tab) {
      state.tab = button.dataset.tab;
      $('inspector-body').scrollTop = 0;
      renderInspector();
      return;
    }
    if (button.dataset.closeDialog) return $(button.dataset.closeDialog).close();
    if (button.hasAttribute('data-open-palette')) return openPalette();
    if (button.dataset.addKind) return void addBlock(button.dataset.addKind);
    if (button.hasAttribute('data-sync-target')) return void addBlock('merge-target');
    if (button.dataset.openFile) return void inspectFile(button.dataset.openFile);
    if (button.dataset.deleteArtifact) return void deleteArtifact(button.dataset.deleteArtifact);
    if (button.hasAttribute('data-refresh-skills')) return void refreshSkills(button);
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
    if (button.dataset.action && !['save', 'comment', 'folder'].includes(button.dataset.action))
      void blockAction(button);
  });

  document.addEventListener('input', (event) => {
    const field = event.target;
    if (!field.dataset.field) return;
    setDraft(
      field.dataset.field,
      ['iterations', 'lane'].includes(field.dataset.field) ? Number(field.value) : field.value
    );
  });

  document.addEventListener('change', async (event) => {
    const field = event.target;
    if (field.id === 'worktree-menu') {
      const operation = field.value;
      field.value = '';
      if (operation === 'open') {
        if (await action('open-worktree')) toast('Opened the worktree in Finder.');
      } else if (operation === 'update') {
        const selected = state.issueId;
        const result = await action('update-worktree');
        if (result && selected === state.issueId) {
          state.blockId = result.blockId;
          state.tab = 'details';
          state.graphScrollIntent = { nodeId: result.blockId, mode: 'reveal' };
          await load(true);
        }
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

  $('new-issue').addEventListener('click', openCapture);
  $('project-settings').addEventListener('click', openProjectSettings);
  $('initialize-lifecycle').addEventListener('click', initializeLifecycle);
  $('empty-new-issue').addEventListener('click', openCapture);
  $('continue-block').addEventListener('click', () => {
    const block = activeBlock();
    if (block) void startBlock('continue', block);
  });
  $('refresh').addEventListener('click', () => {
    void load(true);
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
      { requestId: state.captureId, description, type: $('capture-type').value },
      { global: true, errorId: 'capture-error' }
    );
    if (!result) return;
    state.captureId = null;
    $('capture-description').value = '';
    $('capture-dialog').close();
    toast('Issue created. Its blocks are ready for you to choose.');
    const id = result.issue?.id || result.issueId;
    if (id) selectIssue(id);
    else await load(true);
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
  setInterval(() => {
    if (!document.hidden) void load();
  }, 2000);
  void load();
})();
