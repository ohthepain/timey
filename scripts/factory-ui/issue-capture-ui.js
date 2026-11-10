const issueCaptureUI = (() => {
  const dialog = document.createElement('dialog');
  dialog.id = 'create-issue-dialog';
  dialog.setAttribute('aria-labelledby', 'create-issue-heading');
  dialog.innerHTML = `<form id="capture-form">
    <header class="capture-header"><span class="capture-eyebrow">A little idea. A big next step.</span><h2 id="create-issue-heading">Make something better<span aria-hidden="true">.</span></h2><p>Describe the change. Choose how far to take it.</p></header>
    <section class="capture-body"><label for="capture-description">Description</label><textarea id="capture-description" required maxlength="24000" rows="5" placeholder="What would you like to build, improve, or fix?"></textarea>
    <div class="capture-model-card"><label for="capture-model">Your model</label><select id="capture-model"><option value="">Use project default</option></select><p id="capture-model-hint">Used for new work on the issues you create.</p></div>
    <div class="capture-options"><label class="capture-option"><input id="capture-merge" type="checkbox" role="switch"><span><strong>Merge</strong><small id="capture-merge-hint">Full Stop · Leave a merge-ready PR for review.</small></span></label>
    <label class="capture-option"><input id="capture-grill" type="checkbox" role="switch" aria-label="Grill me after creation"><span><strong>Grill me after creation</strong><small>Explore the idea together before starting work.</small></span></label></div>
    <p class="capture-note" id="capture-intent">Go creates the issues and starts work on each. Save keeps them for later.</p><p class="capture-note">Descriptions go to the configured capture model to derive titles and separate issues.</p>
    <p id="capture-error" role="alert"></p><p id="capture-status" role="status"></p></section>
    <footer class="capture-footer"><button id="capture-cancel" type="button">Cancel</button><div class="actions"><button id="capture-save" type="submit">Save</button><button id="capture-go" type="submit" class="capture-primary">Go <span aria-hidden="true">↗</span></button></div></footer></form>`;
  document.body.append(dialog);
  const toast = document.createElement('aside');
  toast.id = 'capture-toast';
  toast.hidden = true;
  toast.setAttribute('aria-label', 'Captured issues');
  toast.style.cssText =
    'position:fixed;bottom:20px;right:20px;max-width:min(440px,90vw);max-height:40vh;overflow:auto;background:#fffef9;border:2px solid #245bcc;border-radius:8px;padding:16px;z-index:40;box-shadow:0 2px 12px #0003';
  document.body.append(toast);
  const field = dialog.querySelector('textarea');
  const grilling = dialog.querySelector('#capture-grill');
  const model = dialog.querySelector('#capture-model');
  const merge = dialog.querySelector('#capture-merge');
  const go = dialog.querySelector('#capture-go');
  const error = dialog.querySelector('#capture-error');
  const status = dialog.querySelector('#capture-status');
  let reading = { x: 0, y: 0 };
  let saving = false,
    requestId = null,
    request,
    refresh;
  try {
    const draft = JSON.parse(sessionStorage.getItem('factory-capture-draft'));
    if (draft) {
      field.value = draft.description;
      grilling.checked = draft.grill === true;
      requestId = draft.requestId;
      model.dataset.draft = draft.model || '';
      merge.checked = draft.merge === true;
    }
  } catch {}
  function updateChoices() {
    const unavailable = saving || grilling.checked;
    go.disabled = unavailable;
    merge.disabled = unavailable;
    dialog.querySelector('#capture-merge-hint').textContent = merge.checked
      ? 'Full Send · Enable protected merge after required checks.'
      : 'Full Stop · Leave a merge-ready PR for review.';
    dialog.querySelector('#capture-intent').textContent = grilling.checked
      ? 'Save creates the issues and starts grilling. Turn grilling off to Go straight to work.'
      : 'Go creates the issues and starts work on each. Save keeps them for later.';
  }
  grilling.onchange = updateChoices;
  merge.onchange = updateChoices;
  async function startWork(issues) {
    for (const issue of issues) {
      try {
        const snapshot = await request('queue?issue=' + encodeURIComponent(issue.id));
        const saved = snapshot.issues.find((item) => item.id === issue.id);
        await request('issue-strategy-start', {
          issueId: issue.id,
          basis: saved.strategy.basis,
          strategy: merge.checked ? 'full-send' : 'full-stop',
          solRounds: 0,
          approved: true,
          operation: 'work',
          instruction: '',
        });
      } catch (failure) {
        const notice = document.createElement('p');
        notice.textContent =
          issue.title +
          ': saved, but start could not be confirmed. Open the issue to check its status and Continue. ' +
          failure.message;
        toast.append(notice);
      }
    }
  }
  function clearDraft() {
    field.value = '';
    grilling.checked = false;
    requestId = null;
    model.value = '';
    delete model.dataset.draft;
    merge.checked = false;
    updateChoices();
    try {
      sessionStorage.removeItem('factory-capture-draft');
    } catch {}
  }
  function restoreReading() {
    window.scrollTo(reading.x, reading.y);
  }
  function close() {
    dialog.close();
    restoreReading();
    document.getElementById('create-issue')?.focus({ preventScroll: true });
    void refresh?.();
  }
  dialog.querySelector('#capture-cancel').onclick = () => {
    if (!saving) {
      clearDraft();
      close();
    }
  };
  dialog.addEventListener('cancel', (event) => {
    if (saving) event.preventDefault();
    else {
      clearDraft();
      queueMicrotask(() => {
        restoreReading();
        void refresh?.();
      });
    }
  });
  function feedback(issues) {
    toast.replaceChildren();
    const message = document.createElement('p');
    message.setAttribute('role', 'status');
    message.textContent = issues.length === 1 ? 'Issue captured.' : `${issues.length} issues captured.`;
    toast.append(message);
    for (const issue of issues) {
      const link = document.createElement('a');
      link.href = '#/issue/' + encodeURIComponent(issue.issueNumber);
      link.textContent = '#' + issue.issueNumber + ' · ' + issue.title;
      link.style.display = 'block';
      toast.append(link);
    }
    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    dismiss.onclick = () => {
      toast.hidden = true;
    };
    toast.append(dismiss);
    toast.hidden = false;
  }
  function grillingFeedback(result) {
    for (const item of result.grilling || [])
      if (item.error) {
        const notice = document.createElement('p');
        notice.textContent = 'Issue saved. Grilling could not start: ' + item.error;
        toast.append(notice);
      }
  }
  async function finishCapture(result, openIssue) {
    grillingFeedback(result);
    clearDraft();
    dialog.close();
    restoreReading();
    try {
      await refresh();
    } catch (failure) {
      const notice = document.createElement('p');
      notice.textContent = 'Captured successfully. The list could not refresh: ' + failure.message;
      toast.append(notice);
    }
    if (openIssue && result.issues.length) {
      location.hash = '#/issue/' + encodeURIComponent(result.issues[0].id);
      window.scrollTo(0, 0);
    } else {
      restoreReading();
      document.getElementById('create-issue')?.focus({ preventScroll: true });
    }
  }
  dialog.querySelector('form').onsubmit = async (event) => {
    event.preventDefault();
    if (saving) return;
    if (!field.value.trim()) {
      error.textContent = 'Description is required.';
      field.focus();
      return;
    }
    const start = event.submitter === go;
    if (start && grilling.checked) return;
    requestId ||= crypto.randomUUID();
    const input = {
      description: field.value,
      requestId,
      ...(grilling.checked ? { grill: true } : {}),
      ...(model.value ? { model: model.value } : {}),
    };
    try {
      sessionStorage.setItem('factory-capture-draft', JSON.stringify({ ...input, merge: merge.checked }));
    } catch {}
    saving = true;
    error.textContent = '';
    status.textContent = 'Saving…';
    dialog.setAttribute('aria-busy', 'true');
    dialog.querySelectorAll('button,textarea,input,select').forEach((node) => {
      node.disabled = true;
    });
    try {
      const result = await request('issue-capture', input);
      feedback(result.issues);
      if (start) {
        status.textContent = 'Issues saved. Starting work…';
        await startWork(result.issues);
      }
      await finishCapture(result, input.grill || start);
    } catch (failure) {
      error.textContent = failure.message + ' Retry Save with this draft; the submission identity is retained.';
    } finally {
      saving = false;
      status.textContent = '';
      dialog.removeAttribute('aria-busy');
      dialog.querySelectorAll('button,textarea,input,select').forEach((node) => {
        node.disabled = false;
      });
      updateChoices();
    }
  };
  function populateModels(settings) {
    const selected = model.dataset.draft || model.value;
    const defaultChoice = settings.models.find((item) => item.id === settings.defaults.model);
    model.replaceChildren(new Option('Use default · ' + defaultChoice.name, ''));
    for (const item of settings.models) model.add(new Option(item.name, item.id));
    model.value = selected;
    delete model.dataset.draft;
  }
  return {
    bind(send, update, settings) {
      if (settings && !dialog.open) populateModels(settings);
      updateChoices();
      request = send;
      refresh = update;
      const button = document.getElementById('create-issue');
      if (button)
        button.onclick = () => {
          error.textContent = '';
          reading = { x: window.scrollX, y: window.scrollY };
          dialog.showModal();
          field.focus();
        };
    },
  };
})();
