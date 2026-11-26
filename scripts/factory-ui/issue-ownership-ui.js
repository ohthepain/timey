(() => {
  'use strict';
  window.createIssueOwnershipUI = ({ request, post, changed }) => {
    const release = document.getElementById('release-issue-claim');
    const settings = document.getElementById('issue-settings');
    const form = document.getElementById('issue-ownership-form');
    const description = document.getElementById('issue-ownership-description');
    const controls = document.getElementById('issue-ownership-controls');
    const reason = document.getElementById('issue-ownership-reason');
    const confirmed = document.getElementById('issue-ownership-confirmed');
    const error = document.getElementById('issue-ownership-error');
    let current;
    let key;
    let pending;
    release.addEventListener('click', () => {
      settings.open = true;
      reason.focus();
    });
    async function render(issue, unavailable) {
      const next = JSON.stringify([issue.id, issue.ownership?.token, issue.localOwner, unavailable]);
      if (key === next) return;
      key = next;
      current = null;
      release.hidden = true;
      controls.hidden = true;
      form.hidden = !issue.ownership;
      if (form.hidden) return;
      const view = await request('/api/issue-store-recovery?issueId=' + encodeURIComponent(issue.id));
      if (key !== next) return;
      current = view;
      pending = null;
      if (!view.ownership) {
        form.hidden = true;
        return;
      }
      controls.hidden = !view.canRecover;
      release.hidden = controls.hidden;
      description.textContent =
        view.reason ||
        'Ownership is held by runner ' +
          view.ownership.runnerId +
          '. It remains held until the attempt finishes or is explicitly recovered.';
      document.getElementById('issue-ownership-confirmation').textContent = view.confirmation;
      reason.value = '';
      confirmed.checked = false;
      error.hidden = true;
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!current?.canRecover || !confirmed.checked || !reason.value.trim()) return;
      const input = { issueId: current.issueId, ...current.ownership, reason: reason.value.trim(), confirmed: true };
      if (pending && pending.reason !== input.reason) {
        error.textContent = 'Retry the saved recovery reason before starting a different recovery.';
        error.hidden = false;
        return;
      }
      pending ||= { ...input, operationId: crypto.randomUUID() };
      controls.disabled = true;
      try {
        await post('issue-store-recovery', pending);
        pending = null;
        key = null;
        await changed();
      } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
      } finally {
        controls.disabled = false;
      }
    });
    return { render };
  };
})();
