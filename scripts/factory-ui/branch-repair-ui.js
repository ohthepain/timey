(() => {
  const labels = {
    idle: 'Fix Branch',
    broken: 'Fix Branch',
    running: 'Fixing Branch',
    stopping: 'Stopping Branch Fix',
    ready: 'Approve Branch Fix',
    failed: 'Fix Branch',
    stopped: 'Fix Branch',
    interrupted: 'Review Branch Fix',
    stale: 'Recheck Branch Fix',
    passed: 'Branch Checks Passed',
    applied: 'Branch Fix Applied',
  };
  window.createBranchRepairUI = ({ button, action }) => {
    const dialog = document.getElementById('branch-repair-dialog');
    let view;
    let issueId;
    let pending = false;
    const find = (name) => dialog.querySelector(`[data-repair-${name}]`);
    const busy = (status) => ['running', 'stopping'].includes(status);
    function render() {
      const repair = view?.branchRepair || { status: 'idle' };
      const status = repair.status;
      const ineligible =
        !view?.environment?.worktreeExists ||
        view?.issue?.closure ||
        view?.issue?.status === 'closed' ||
        view?.issue?.state === 'needs-approval' ||
        view?.grouping?.master;
      button.hidden = !view?.issue || view.flow?.routeType === 'investigation';
      button.disabled = Boolean(pending || (ineligible && !busy(status)));
      button.dataset.repairState = status;
      renderButton(repair);
      renderDetails(repair);
      renderActions(repair, ineligible);
    }
    function renderButton(repair) {
      const status = repair.status;
      button.replaceChildren();
      if (busy(status)) {
        const spinner = document.createElement('span');
        spinner.className = 'status-icon active-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        button.append(spinner, ' ');
      }
      button.append(labels[status] || 'Fix Branch');
      button.title =
        repair.error ||
        repair.failure?.summary ||
        repair.step ||
        'Repair checks that prevent work on this issue branch.';
    }
    function renderDetails(repair) {
      const status = repair.status;
      find('status').textContent = statusMessage(repair);
      find('timing').textContent = repair.startedAt
        ? `${repair.branch || ''} · ${Math.max(0, Math.floor(((repair.endedAt ? Date.parse(repair.endedAt) : Date.now()) - Date.parse(repair.startedAt)) / 1000))}s elapsed${repair.lastActiveAt ? ' · Last activity ' + new Date(repair.lastActiveAt).toLocaleTimeString() : ''}`
        : '';
      find('error').textContent =
        repair.error ||
        (status === 'stale'
          ? 'The issue or repair candidate changed. Start a fresh check before approval.'
          : status === 'interrupted'
            ? 'The worker is no longer connected. Its candidate and logs are retained. Confirm the old worker has stopped before allowing a retry.'
            : '');
      find('error').hidden = !find('error').textContent;
      find('output').textContent = repair.output || 'No output collected yet.';
      find('review').hidden = status !== 'ready';
      find('diff').textContent = repair.diff || '';
      find('checks').textContent = (repair.checks || []).map(({ label }) => label).join('\n');
    }
    function renderActions(repair, ineligible) {
      const status = repair.status;
      find('command').hidden = busy(status) || status === 'interrupted';
      find('command').textContent = commandLabel(repair);
      find('command').disabled = Boolean(ineligible || pending);
      find('stop').hidden = !busy(status);
      find('stop').disabled = status === 'stopping' || pending;
      find('reconcile').hidden = status !== 'interrupted';
      find('reconcile').disabled = pending;
    }
    function statusMessage(repair) {
      return [
        view?.branchUpdateSummary,
        repair.step,
        repair.failure?.summary,
        'Run the blocking checks and prepare a branch repair for review.',
      ].find(Boolean);
    }
    function commandLabel(repair) {
      const command = nextCommand(repair);
      if (command === 'update-worktree') return 'Retry Update Branch';
      if (command === 'branch-repair-approve') return 'Approve Branch Fix';
      return ['stale', 'failed', 'stopped', 'passed', 'applied'].includes(repair.status)
        ? 'Recheck Branch'
        : 'Fix Branch';
    }
    function nextCommand(repair) {
      if (repair.failure?.kind === 'merge-conflict') return 'update-worktree';
      return repair.status === 'ready' ? 'branch-repair-approve' : 'branch-repair-start';
    }
    async function perform(command) {
      if (pending || view?.issue?.id !== issueId) return;
      pending = true;
      render();
      try {
        const repair = view.branchRepair;
        const result = await action(command, { repairId: repair?.id, candidateTree: repair?.candidateTree });
        if (result?.flow) update(result);
      } finally {
        pending = false;
        render();
      }
    }
    function update(next) {
      if (issueId && next?.issue?.id !== issueId) dialog.close();
      issueId = next?.issue?.id;
      view = next;
      render();
    }
    button.addEventListener('click', () => {
      render();
      dialog.showModal();
    });
    find('close').addEventListener('click', () => dialog.close());
    find('command').addEventListener('click', () => void perform(nextCommand(view.branchRepair || { status: 'idle' })));
    find('stop').addEventListener('click', () => void perform('branch-repair-stop'));
    find('reconcile').addEventListener('click', () => void perform('branch-repair-reconcile'));
    return { update };
  };
})();
