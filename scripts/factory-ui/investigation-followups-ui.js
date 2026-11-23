(() => {
  'use strict';
  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

  window.createInvestigationFollowupsUI = ({ request, folders, changed }) => {
    const dialog = document.getElementById('investigation-followups-dialog');
    const body = dialog.querySelector('[data-followups-body]');
    const message = dialog.querySelector('[data-followups-message]');
    const submit = dialog.querySelector('[data-followups-create]');
    let review;
    let source;
    let busy = false;
    const drafts = new Map();
    const issueStores = window.createIssueStoreUI({});
    const post = (action, data = {}) => request('flow-action', { ...source, action, ...data });

    function selection() {
      return [...body.querySelectorAll('[data-proposal]')].filter(
        (row) => row.querySelector('[name="selected"]').checked && !row.disabled
      );
    }
    function updateButton() {
      submit.disabled = busy || selection().length === 0 || !body.querySelector('[data-followups-store]')?.value;
      submit.textContent = `Create selected issues${selection().length ? ` (${selection().length})` : ''}`;
    }
    function collect() {
      for (const row of body.querySelectorAll('[data-proposal]')) {
        const data = Object.fromEntries(
          [...row.querySelectorAll('[name]')].map((field) => [
            field.name,
            field.type === 'checkbox' ? field.checked : field.value,
          ])
        );
        drafts.set(row.dataset.proposal, data);
      }
    }
    function render() {
      const choices = [...new Set([...folders(), review.folder])];
      body.innerHTML = `<label class="field">Issue folder<select data-followups-folder>${choices.map((folder) => `<option${folder === review.folder ? ' selected' : ''}>${escape(folder)}</option>`).join('')}</select></label><label class="field">Issue storage profile<select data-followups-store required></select></label>${
        review.proposals.length
          ? review.proposals
              .map((proposal) => {
                const draft = drafts.get(proposal.id) ?? { selected: true, ...(proposal.draft ?? proposal) };
                const fields = [
                  ['title', 'Title'],
                  ['description', 'Request'],
                  ['reason', 'Why'],
                  ['verification', 'Requested proof'],
                ]
                  .map(
                    ([name, label]) =>
                      `<label class="field">${label}${name === 'title' ? `<input name="${name}" maxlength="160" value="${escape(draft[name])}" required />` : `<textarea name="${name}" rows="3" required>${escape(draft[name])}</textarea>`}</label>`
                  )
                  .join('');
                return `<fieldset class="followup-proposal" data-proposal="${escape(proposal.id)}"${proposal.result || proposal.identity ? ' disabled' : ''}><legend><label><input type="checkbox" name="selected"${draft.selected ? ' checked' : ''} /> Follow-up issue</label></legend>${fields}<label class="field">Type<select name="type">${['bug', 'feature', 'investigation'].map((type) => `<option${type === draft.type ? ' selected' : ''}>${type}</option>`).join('')}</select></label></fieldset>${proposal.result ? `<p class="muted">${proposal.result.deleted ? 'This proposal was removed.' : `Created · <a href="/?issue=${encodeURIComponent(proposal.result.issueId)}">Open issue</a> · Needs approval`}</p>` : proposal.error ? `<p role="alert">${escape(proposal.error)}</p><button type="button" class="small-button" data-followups-retry="${escape(proposal.id)}">Retry this issue</button>` : ''}`;
              })
              .join('')
          : '<p class="muted">No new follow-up work was identified. You can use the findings directly or create an issue from your own request.</p>'
      }`;
      updateButton();
      void refreshStores();
    }
    async function refreshStores() {
      try {
        await issueStores.fill(body.querySelector('[data-followups-store]'), {
          folder: body.querySelector('[data-followups-folder]').value,
          selected: review.storageProfile,
        });
        updateButton();
      } catch (error) {
        message.textContent = error.message;
      }
    }
    async function perform(operation) {
      if (busy) return;
      busy = true;
      dialog.querySelector('[data-followups-close]').disabled = true;
      body.inert = true;
      updateButton();
      message.textContent = '';
      try {
        await operation();
      } catch (error) {
        message.textContent = error.message;
      } finally {
        busy = false;
        body.inert = false;
        dialog.querySelector('[data-followups-close]').disabled = false;
        updateButton();
      }
    }
    async function create(items, folder) {
      const storageProfile = body.querySelector('[data-followups-store]').value;
      review = await post('investigation-followups-create', {
        basis: review.source.basis,
        folder,
        storageProfile,
        items,
      });
      render();
      const created = review.proposals.filter((item) => item.result && !item.result.deleted).length;
      message.textContent = `${created} follow-up ${created === 1 ? 'issue' : 'issues'} created. Review and approve them before starting work.`;
      await changed();
    }
    body.addEventListener('change', (event) => {
      if (event.target.matches('[data-followups-folder]')) void refreshStores();
      updateButton();
    });
    body.addEventListener('click', (event) => {
      const retry = event.target.closest('[data-followups-retry]');
      if (!retry) return;
      const item = review.proposals.find(({ id }) => id === retry.dataset.followupsRetry);
      void perform(() => create([{ ...item.draft, id: item.id }], item.folder));
    });
    submit.addEventListener('click', () => {
      collect();
      const items = selection().map((row) => ({ ...drafts.get(row.dataset.proposal), id: row.dataset.proposal }));
      const folder = body.querySelector('[data-followups-folder]').value;
      void perform(() => create(items, folder));
    });
    dialog.querySelector('[data-followups-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', (event) => {
      if (busy) event.preventDefault();
    });
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-investigation-followups]');
      if (!button || busy) return;
      source = { issueId: button.dataset.sourceIssue, blockId: button.dataset.investigationFollowups };
      review = null;
      drafts.clear();
      body.textContent = 'Preparing follow-up proposals from the saved findings…';
      dialog.showModal();
      void perform(async () => {
        review = await post('investigation-followups-preview');
        render();
      });
    });
  };
})();
