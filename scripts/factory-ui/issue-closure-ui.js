(() => {
  'use strict';

  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

  window.confirmProposalDeletion = (title, number) =>
    confirm(
      `Permanently delete ${number ? '#' + number + ' ' : ''}“${title}” and any evidence Factory verifies is no longer referenced? Evidence still in use is kept. This cannot be undone.`
    );

  window.createIssueClosureDialog = ({ dialog, panel, approve, error, request }) => {
    let current;
    const selectedItems = () =>
      new Set(
        [...panel.querySelectorAll('[data-cleanup-choice]:checked:not(:disabled)')].map(
          (input) => input.dataset.cleanupChoice
        )
      );
    const showing = (session) => dialog.open && current === session && panel.contains(session.heading);
    const showError = (session, failure) => {
      if (showing(session)) error.textContent = failure.message;
    };

    async function open(getContext) {
      const session = { heading: document.createElement('h2'), resources: null };
      current = session;
      session.heading.id = 'issue-closure-heading';
      session.heading.textContent = 'Close this issue';
      const loading = document.createElement('p');
      loading.setAttribute('role', 'status');
      loading.textContent = 'Loading issue details…';
      panel.replaceChildren(session.heading, loading);
      error.textContent = '';
      approve.textContent = 'Close issue';
      approve.disabled = true;
      dialog.showModal();
      try {
        const { closureReasons, sharedQueue, subIssues, groupProof, ...decision } = await getContext();
        if (!showing(session)) return;
        session.decision = decision;
        if (decision.cleanupOnly) {
          session.heading.textContent = 'Clean up this issue';
          approve.textContent = 'Run Cleanup';
        }
        initializeFields(session, closureReasons, sharedQueue);
        session.heading.insertAdjacentHTML('afterend', subIssueSummary(subIssues, groupProof));
      } catch (failure) {
        showError(session, failure);
      } finally {
        loading.remove();
      }
    }

    function initializeFields(session, reasons, sharedQueue) {
      const explanation = sharedQueue
        ? sharedExplanation
        : session.decision.cleanupOnly
          ? 'Review the resources before running Cleanup.'
          : 'Fixed requires the existing acceptance checks.';
      const options = reasons.map(reasonOption).join('');
      session.heading.insertAdjacentHTML(
        'afterend',
        `<p>${explanation}</p>
        <label>Reason<select class="closure-reason" id="closure-reason" aria-label="Reason">${options}</select></label>
        <label>Details or related issue (optional)<textarea id="reopen-reason" maxlength="4000"></textarea></label>`
      );
      const reason = panel.querySelector('#closure-reason');
      selectSuggestedReason(reason, reasons, session.decision.suggestedResolution);
      addRetroChoice(session, reason);
      if (session.decision.cleanupOnly) {
        reason.closest('label').hidden = true;
        panel.querySelector('#reopen-reason').closest('label').hidden = true;
        reason.value = session.decision.resolution || reason.value;
      }
      if (!session.decision.cleanupOnly || !reason.value) {
        approve.disabled = !reason.value;
        return;
      }
      panel.insertAdjacentHTML('beforeend', '<fieldset id="cleanup-options"></fieldset>');
      reason.onchange = () => void loadCleanup(session, reason.value, selectedItems());
      void loadCleanup(session, reason.value);
    }

    function selectSuggestedReason(select, reasons, suggestion) {
      if (reasons.some((item) => item.id === suggestion)) select.value = suggestion;
    }

    function addRetroChoice(session, reason) {
      const { fixedRetroDefault } = session.decision;
      if (fixedRetroDefault === undefined) return;
      reason
        .closest('label')
        .insertAdjacentHTML(
          'afterend',
          '<label data-closure-retro-choice><input type="checkbox" id="run-closure-retro"> Run Retro before Cleanup</label>'
        );
      const retro = panel.querySelector('#run-closure-retro');
      const updateRetro = () => {
        retro.checked = reason.value === 'fixed' && fixedRetroDefault;
      };
      reason.addEventListener('change', updateRetro);
      updateRetro();
    }

    async function loadCleanup(session, resolution, selections) {
      const preview = { resolution };
      session.preview = preview;
      session.resources = null;
      approve.disabled = true;
      error.textContent = '';
      panel.querySelector('#cleanup-options').innerHTML =
        '<legend>Optional cleanup</legend><p>Checking linked resources…</p>';
      const isCurrent = () => showing(session) && session.preview === preview;
      const issueId = session.decision.issueId;
      try {
        const { resources } = await request('issue-cleanup-identities', { issueId, resolution });
        if (!isCurrent()) return;
        const flow = session.decision.flowRevision !== undefined;
        session.resources = cleanupSelections(
          flow
            ? resources
                .filter((item) => item.kind !== 'chat')
                .map((item) => ({ ...item, defaultSelected: false, mandatory: item.kind === 'workspace' }))
            : resources,
          selections
        );
        renderCleanup(session.resources);
        approve.disabled = false;
        session.resources.forEach((item) => void checkResource(item));
      } catch (failure) {
        if (isCurrent()) showError(session, failure);
      }

      async function checkResource(item) {
        try {
          const { resource } = await request('issue-cleanup-resource', { issueId, resourceId: item.id, resolution });
          updateResource(resource);
          if (isCurrent()) void loadWorkspaceSize(issueId, resource, updateResource);
        } catch (failure) {
          updateResource({
            ...item,
            state: 'unknown',
            eligible: false,
            reason: `Status unknown; preserved. ${failure.message}`,
          });
        }
      }

      function updateResource(resource) {
        if (!isCurrent()) return;
        const selected = selectedItems();
        session.resources = session.resources.map((item) =>
          item.id === resource.id ? { ...item, ...resource, defaultSelected: selected.has(item.id) } : item
        );
        renderCleanup(session.resources);
      }
    }

    async function loadWorkspaceSize(issueId, resource, updateResource) {
      if (resource.kind !== 'workspace' || resource.sizeStatus !== 'pending') return;
      const updateSize = ({ estimatedBytes, sizeStatus }) =>
        updateResource({ id: resource.id, estimatedBytes, sizeStatus });
      await request('issue-cleanup-workspace-size', { issueId, resourceId: resource.id })
        .then(({ resource: size }) => updateSize(size))
        .catch(() => updateSize({ estimatedBytes: null, sizeStatus: 'unavailable' }));
    }

    function renderCleanup(resources) {
      panel.querySelector('#cleanup-options').innerHTML =
        `<legend>Optional cleanup</legend><p>Selected resources are rechecked before each action. Issue closure remains saved if cleanup is incomplete.</p>${resources.map(cleanupChoice).join('') || '<p>No linked resources were found.</p>'}`;
    }

    function decision() {
      const resolution = panel.querySelector('#closure-reason').value;
      const selected = [...selectedItems()];
      const { fixedRetroDefault, suggestedResolution, ...decision } = current.decision;
      return {
        ...decision,
        reason: panel.querySelector('#reopen-reason').value,
        resolution,
        ...(fixedRetroDefault !== undefined
          ? { runClosureRetro: panel.querySelector('#run-closure-retro').checked }
          : {}),
        cleanup: current.resources
          ? {
              basis: null,
              resolution,
              selected,
              selectedResources: current.resources.filter((item) => selected.includes(item.id)),
            }
          : null,
      };
    }

    return { open, decision };
  };

  const sharedExplanation = 'The factory prepares a queue PR for the report. Local work is preserved.';
  const verdictLabels = { missing: 'Missing', failed: 'Failed', passed: 'Passed' };

  function subIssueSummary(subIssues, groupProof) {
    if (!subIssues?.length) return '';
    const proof = new Map(groupProof?.children.map((row) => [row.id, row]));
    const rows = subIssues.map((child) => subIssueRow(child, proof.get(child.id))).join('');
    return `<section aria-labelledby="closure-sub-issues"><h3 id="closure-sub-issues">Sub-issues</h3><p>Closing as Fixed also closes the attached sub-issues.</p>${candidateTree(groupProof)}<ul>${rows}</ul></section>`;
  }

  function candidateTree(groupProof) {
    if (!groupProof) return '';
    return `<p>Candidate tree <code>${esc(groupProof.candidate.tree || 'Unavailable')}</code></p>`;
  }

  function subIssueRow({ title, number, removed }, proof) {
    const label = number == null ? title : '#' + number + ' ' + title;
    return `<li>${esc(label)} · ${removed ? 'Removed' : 'Attached'}${proof ? subIssueProof(proof) : ''}</li>`;
  }

  function proofVerdict({ status, tree } = {}) {
    const label = verdictLabels[status] ?? verdictLabels.missing;
    return tree ? `${label} · Proof tree <code>${esc(tree)}</code>` : label;
  }

  function subIssueProof({ verdict, applicability, outstandingProof, browserReplay }) {
    const outstanding = outstandingProof ? `<p>Outstanding proof · ${esc(outstandingProof)}</p>` : '';
    return `<p>Latest verdict · ${proofVerdict(verdict ?? undefined)}</p><p>${esc(applicability)}</p>${replaySummary(browserReplay)}${outstanding}`;
  }

  function replaySummary(replay) {
    if (!replay) return '';
    const label = replay.shared ? 'Shared final browser replay' : 'Final browser replay';
    const qualification = replay.qualification ? ` <span>${esc(replay.qualification)}</span>` : '';
    return `<p>${label} · <code>${esc(replay.command.join(' '))}</code> · Exit ${esc(replay.exit)}${qualification}</p>`;
  }

  function reasonOption(choice) {
    const selected = choice.id === 'fixed' ? ' selected' : '';
    return `<option value="${esc(choice.id)}"${selected}>${esc(choice.label)} — ${esc(choice.description)}</option>`;
  }

  function cleanupSelections(resources, selections) {
    if (!selections) return resources;
    return resources.map((item) => ({ ...item, defaultSelected: selections.has(item.id) }));
  }

  const resourceState = {
    'already-deleted': 'Already deleted',
    'already-archived': 'Already archived',
    unknown: 'Status unknown; preserved',
  };
  const resourceLabel = {
    workspace: (resource) => `Workspace ${resource.name} · ${workspaceEstimate(resource)}`,
    'remote-branch': (resource) => `Remote branch ${resource.repository}:${resource.name}`,
    chat: (resource) => `Thread ${resource.threadId}`,
  };

  function cleanupChoice(resource) {
    const label = (resourceLabel[resource.kind] ?? localBranchLabel)(resource);
    const state = resourceState[resource.state] ?? resource.reason;
    const detail = resource.discardCount
      ? `<small>Deleting discards ${esc(resource.discardCount)} unmerged commits. ${esc(resource.discard.join(', '))}</small>`
      : '';
    const checkbox = resource.mandatory ? '' : cleanupCheckbox(resource);
    return `<label class="cleanup-choice">${checkbox}<span><strong>${esc(label)}</strong>${state ? `<small>${esc(state)}</small>` : ''}${detail}${workspaceChats(resource)}</span></label>`;
  }

  function localBranchLabel(resource) {
    return `Local branch ${resource.name}`;
  }

  function cleanupCheckbox(resource) {
    const disabled = !resource.eligible || resource.state.startsWith('already-');
    return `<input type="checkbox" data-cleanup-choice="${esc(resource.id)}" ${resource.defaultSelected ? 'checked' : ''} ${disabled ? 'disabled' : ''}>`;
  }

  function workspaceChats(resource) {
    if (resource.kind !== 'workspace' || !resource.chats?.length) return '';
    const count = resource.chats.length;
    return `<small>Linked issue chats (${count}).</small>`;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const tier = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** tier).toFixed(tier ? 1 : 0)} ${units[tier]}`;
  }
  function workspaceEstimate(resource) {
    if (Number.isFinite(resource.estimatedBytes)) return `about ${formatBytes(resource.estimatedBytes)}`;
    return resource.sizeStatus === 'pending' ? 'size estimate pending' : 'size estimate unavailable';
  }
})();
