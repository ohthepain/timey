(() => {
  'use strict';

  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
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
      panel.replaceChildren(session.heading);
      error.textContent = '';
      approve.textContent = 'Close issue';
      approve.disabled = true;
      dialog.showModal();
      try {
        const { closureReasons, sharedQueue, ...decision } = await getContext();
        if (!showing(session)) return;
        session.decision = decision;
        if (decision.cleanupOnly) {
          session.heading.textContent = 'Clean up this issue';
          approve.textContent = 'Run Cleanup';
        }
        initializeFields(session, closureReasons, sharedQueue);
      } catch (failure) {
        showError(session, failure);
      }
    }

    function initializeFields(session, reasons, sharedQueue) {
      const flow = session.decision.flowRevision !== undefined;
      const explanation = sharedQueue
        ? sharedExplanation
        : flow
          ? 'Cleanup removes the eligible worktree. Select a branch only if you want it deleted. Fixed requires the existing acceptance checks.'
          : localExplanation;
      const options = reasons.map(reasonOption).join('');
      session.heading.insertAdjacentHTML(
        'afterend',
        `<p>${explanation}</p>
        <label>Reason<select class="closure-reason" id="closure-reason" aria-label="Reason">${options}</select></label>
        <label>Details or related issue (optional)<textarea id="reopen-reason" maxlength="4000"></textarea></label>`
      );
      const reason = panel.querySelector('#closure-reason');
      if (session.decision.cleanupOnly) {
        reason.closest('label').hidden = true;
        panel.querySelector('#reopen-reason').closest('label').hidden = true;
        reason.value = session.decision.resolution || reason.value;
      }
      if ((sharedQueue && !session.decision.cleanupOnly) || !reason.value) {
        approve.disabled = !reason.value;
        return;
      }
      panel.insertAdjacentHTML('beforeend', '<fieldset id="cleanup-options"></fieldset>');
      reason.onchange = () => void loadCleanup(session, reason.value, selectedItems());
      void loadCleanup(session, reason.value);
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
        resources.forEach((item) => void checkResource(item));
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
      return {
        ...current.decision,
        reason: panel.querySelector('#reopen-reason').value,
        resolution,
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

  const sharedExplanation = 'The factory prepares a report PR for human review. Local work is preserved.';
  const localExplanation =
    'Fixed still requires the existing acceptance checks. Unmerged work is preserved by default. Select a branch or workspace only if you want it removed.';

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
    return `<small>Also archives linked issue chats (${count}).</small>`;
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
