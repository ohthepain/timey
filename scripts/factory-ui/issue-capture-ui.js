function captureIntentText(grilling, go) {
  return {
    'true,true': 'Grilling starts first. Continue to work after you answer and approve a plan.',
    'true,false': 'Create the issues and start grilling.',
    'false,true': 'Create the issues and start work.',
    'false,false': 'Create issues only.',
  }[`${grilling},${go}`];
}

function captureStrategyHint(merge) {
  return merge
    ? 'Full Send · Enable protected merge after required checks.'
    : 'Full Stop · Leave a merge-ready PR for review.';
}

function readCaptureDraft() {
  try {
    return JSON.parse(sessionStorage.getItem('factory-capture-draft')) || {};
  } catch {
    return {};
  }
}

function captureDraftText(value) {
  return value ?? '';
}

function captureDraftRequestId(value) {
  return value ?? null;
}

function captureDraftMerge(draft) {
  return draft.strategy === 'full-send' || draft.merge === true;
}

async function startCaptureWork(issues, strategy, request, toast) {
  for (const issue of issues) {
    try {
      const snapshot = await request('queue?issue=' + encodeURIComponent(issue.id));
      const saved = snapshot.issues.find((item) => item.id === issue.id);
      await request('issue-strategy-start', {
        issueId: issue.id,
        basis: saved.strategy.basis,
        strategy,
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

function renderCaptureFeedback(issues, toast) {
  toast.replaceChildren();
  const message = document.createElement('p');
  message.setAttribute('role', 'status');
  message.textContent = issues.length === 1 ? 'Issue captured.' : `${issues.length} issues captured.`;
  toast.append(message);
  for (const issue of issues) {
    const link = document.createElement('a');
    link.href = '#/issue/' + encodeURIComponent(issue.issueNumber ?? issue.id);
    link.textContent = (issue.issueNumber == null ? '' : '#' + issue.issueNumber + ' · ') + issue.title;
    if (issue.publication && issue.publication.status !== 'published') {
      const status = document.createElement('small');
      status.textContent =
        issue.publication.status === 'review' ? ' Awaiting report review.' : ' Report publication needs attention.';
      link.append(status);
    }
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

function renderGrillingFeedback(result, toast) {
  for (const item of result.grilling || [])
    if (item.error) {
      const notice = document.createElement('p');
      notice.textContent = 'Issue saved. Grilling could not start: ' + item.error;
      toast.append(notice);
    }
}

async function refreshAfterCapture(refresh, toast) {
  try {
    await refresh();
  } catch (failure) {
    const notice = document.createElement('p');
    notice.textContent = 'Captured successfully. The list could not refresh: ' + failure.message;
    toast.append(notice);
  }
}

function openAfterCapture(openIssue, issues, restoreReading) {
  if (openIssue && issues.length) {
    location.hash = '#/issue/' + encodeURIComponent(issues[0].id);
    window.scrollTo(0, 0);
  } else {
    restoreReading();
    document.getElementById('create-issue')?.focus({ preventScroll: true });
  }
}

async function finishCapture(result, openIssue, context) {
  renderGrillingFeedback(result, context.toast);
  context.clearDraft();
  context.dialog.close();
  context.restoreReading();
  await refreshAfterCapture(context.refresh, context.toast);
  openAfterCapture(openIssue, result.issues, context.restoreReading);
}

function captureInput(context) {
  context.state.requestId ||= crypto.randomUUID();
  const input = {
    description: context.field.value,
    requestId: context.state.requestId,
    grill: context.grilling.checked,
    go: context.go.checked,
    strategy: context.merge.checked ? 'full-send' : 'full-stop',
    model: context.model.value || undefined,
  };
  return input;
}

function saveCaptureDraft(input) {
  try {
    sessionStorage.setItem('factory-capture-draft', JSON.stringify(input));
  } catch {}
}

function setCaptureBusy(context, busy) {
  context.state.saving = busy;
  context.status.textContent = busy ? 'Saving…' : '';
  if (busy) context.dialog.setAttribute('aria-busy', 'true');
  else context.dialog.removeAttribute('aria-busy');
  context.dialog.querySelectorAll('button,textarea,input,select').forEach((node) => {
    node.disabled = busy;
  });
  context.updateChoices();
}

async function submitCapture(event, context) {
  event.preventDefault();
  if (context.state.saving) return;
  if (!context.field.value.trim()) {
    context.error.textContent = 'Description is required.';
    context.field.focus();
    return;
  }
  const input = captureInput(context);
  await sendCapture(input, context);
}

async function sendCapture(input, context) {
  saveCaptureDraft(input);
  context.error.textContent = '';
  setCaptureBusy(context, true);
  try {
    const result = await context.request('issue-capture', input);
    renderCaptureFeedback(result.issues, context.toast);
    await startCaptureIfRequested(result.issues, input, context);
    await finishCapture(result, input.grill || input.go, context);
  } catch (failure) {
    context.error.textContent = failure.message + ' Retry Save with this draft; the submission identity is retained.';
  } finally {
    setCaptureBusy(context, false);
  }
}

async function startCaptureIfRequested(issues, input, context) {
  if (input.go && !input.grill) {
    context.status.textContent = 'Issues saved. Starting work…';
    await startCaptureWork(issues, input.strategy, context.request, context.toast);
  }
}

function populateCaptureModels(model, settings) {
  const selected = model.dataset.draft || model.value;
  const defaultChoice = settings.models.find((item) => item.id === settings.defaults.model);
  model.replaceChildren(new Option('Use default · ' + defaultChoice.name, ''));
  for (const item of settings.models) model.add(new Option(item.name, item.id));
  model.value = selected;
  delete model.dataset.draft;
}

function openCaptureDialog(context) {
  context.error.textContent = '';
  context.reading = { x: window.scrollX, y: window.scrollY };
  context.dialog.showModal();
  context.field.focus();
}

function bindCaptureUI(context, send, update, settings) {
  if (settings && !context.dialog.open) populateCaptureModels(context.model, settings);
  context.updateChoices();
  context.request = send;
  context.refresh = update;
  const button = document.getElementById('create-issue');
  if (button) button.onclick = () => openCaptureDialog(context);
}

function clearCaptureDraft(context) {
  context.field.value = '';
  context.grilling.checked = false;
  context.go.checked = false;
  context.state.requestId = null;
  context.model.value = '';
  delete context.model.dataset.draft;
  context.merge.checked = false;
  context.updateChoices();
  try {
    sessionStorage.removeItem('factory-capture-draft');
  } catch {}
}

function closeCaptureDialog(context) {
  context.dialog.close();
  context.restoreReading();
  document.getElementById('create-issue')?.focus({ preventScroll: true });
  void context.refresh?.();
}

function bindCaptureDismiss(context) {
  context.dialog.querySelector('#capture-cancel').onclick = () => {
    if (!context.state.saving) {
      clearCaptureDraft(context);
      closeCaptureDialog(context);
    }
  };
  context.dialog.addEventListener('cancel', (event) => {
    if (context.state.saving) event.preventDefault();
    else {
      clearCaptureDraft(context);
      queueMicrotask(() => {
        context.restoreReading();
        void context.refresh?.();
      });
    }
  });
}

const issueCaptureUI = (() => {
  const dialog = document.createElement('dialog');
  dialog.id = 'create-issue-dialog';
  dialog.setAttribute('aria-labelledby', 'create-issue-heading');
  dialog.innerHTML = `<form id="capture-form">
    <header class="capture-header"><span class="capture-eyebrow">A little idea. A big next step.</span><h2 id="create-issue-heading">Make something better<span aria-hidden="true">.</span></h2><p>Describe the change. Choose how far to take it.</p></header>
    <section class="capture-body"><label for="capture-description">Description</label><textarea id="capture-description" required maxlength="24000" rows="5" placeholder="What would you like to build, improve, or fix?"></textarea>
    <div class="capture-model-card"><label for="capture-model">Your model</label><select id="capture-model"><option value="">Use project default</option></select><p id="capture-model-hint">Used for new work on the issues you create.</p></div>
    <div class="capture-options" role="group" aria-label="What happens next">
      <label class="capture-option capture-option--grill"><span class="capture-option-copy"><strong>Grill me</strong><small>Talk through the idea together.</small></span><svg class="capture-illustration" viewBox="0 0 88 64" aria-hidden="true"><path d="M18 35h49l-5 17H23z" fill="#e85d32"/><path d="M22 34c1-8 8-13 20-13s19 5 20 13" fill="#ffb84d" stroke="#9a472f" stroke-width="3"/><path d="M28 48v10m29-10v10M30 39h25" fill="none" stroke="#713c35" stroke-width="3" stroke-linecap="round"/><path d="M35 16c-4-5 3-6 0-11m12 11c-4-5 3-6 0-11" fill="none" stroke="#e68a49" stroke-width="3" stroke-linecap="round"/><circle cx="69" cy="17" r="10" fill="#fff"/><path d="M65 17h8m-4-4v8" stroke="#e85d32" stroke-width="2" stroke-linecap="round"/></svg><input id="capture-grill" type="checkbox" aria-label="Grill me"></label>
      <label class="capture-option capture-option--go"><span class="capture-option-copy"><strong>Go</strong><small>Start work on the issues.</small></span><svg class="capture-illustration" viewBox="0 0 88 64" aria-hidden="true"><rect x="33" y="8" width="22" height="45" rx="8" fill="#f4fff8" stroke="#34734e" stroke-width="3"/><path d="M39 53h10v6H39z" fill="#34734e"/><circle cx="44" cy="19" r="6" fill="#e56c63"/><circle cx="44" cy="32" r="6" fill="#f0bd55"/><circle cx="44" cy="45" r="6" fill="#42b86c"/><path d="m64 30 5 5 10-12" fill="none" stroke="#28985a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg><input id="capture-go" type="checkbox" aria-label="Go and start work"></label>
      <label class="capture-option capture-option--merge"><span class="capture-option-copy"><strong>Merge</strong><small id="capture-merge-hint">Full Stop · Leave a merge-ready PR for review.</small></span><svg class="capture-illustration" viewBox="0 0 88 64" aria-hidden="true"><path d="M44 4 72 31 44 59 16 31z" fill="#ffe58c" stroke="#3e64b7" stroke-width="3" stroke-linejoin="round"/><path d="M44 47V29c0-7 5-11 12-11h5m-17 11c0-7-5-11-12-11h-5" fill="none" stroke="#293b69" stroke-width="3.5" stroke-linecap="round"/><path d="m56 13 6 5-6 5m-24-10-6 5 6 5" fill="none" stroke="#293b69" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="44" cy="47" r="3" fill="#e9784f"/></svg><input id="capture-merge" type="checkbox" aria-label="Merge after required checks"></label>
    </div>
    <p class="capture-note" id="capture-intent">Create issues only.</p>
    <p id="capture-error" role="alert"></p><p id="capture-status" role="status"></p></section>
    <footer class="capture-footer"><button id="capture-cancel" type="button">Cancel</button><button id="capture-save" type="submit" class="capture-primary">Create issues</button></footer></form>`;
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
  const state = { saving: false, requestId: null };
  const context = {
    dialog,
    field,
    grilling,
    model,
    merge,
    go,
    error,
    status,
    toast,
    state,
    reading: { x: 0, y: 0 },
  };
  const draft = readCaptureDraft();
  field.value = captureDraftText(draft.description);
  grilling.checked = draft.grill === true;
  go.checked = draft.go === true;
  state.requestId = captureDraftRequestId(draft.requestId);
  model.dataset.draft = captureDraftText(draft.model);
  merge.checked = captureDraftMerge(draft);
  function updateChoices() {
    [grilling, go, merge].forEach((choice) => (choice.disabled = state.saving));
    dialog.querySelector('#capture-merge-hint').textContent = captureStrategyHint(merge.checked);
    dialog.querySelector('#capture-intent').textContent = captureIntentText(grilling.checked, go.checked);
  }
  grilling.onchange = updateChoices;
  merge.onchange = updateChoices;
  go.onchange = updateChoices;
  function restoreReading() {
    window.scrollTo(context.reading.x, context.reading.y);
  }
  dialog.querySelector('form').onsubmit = (event) =>
    submitCapture(event, {
      state,
      field,
      grilling,
      go,
      merge,
      model,
      dialog,
      error,
      status,
      toast,
      request: context.request,
      refresh: context.refresh,
      clearDraft: () => clearCaptureDraft(context),
      restoreReading,
      updateChoices,
    });
  context.updateChoices = updateChoices;
  context.restoreReading = restoreReading;
  context.clearDraft = () => clearCaptureDraft(context);
  bindCaptureDismiss(context);
  return {
    bind: (send, update, settings) => bindCaptureUI(context, send, update, settings),
  };
})();
