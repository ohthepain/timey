const issueCaptureUI = (() => {
  const dialog = document.createElement('dialog');
  dialog.id = 'create-issue-dialog';
  dialog.setAttribute('aria-labelledby', 'create-issue-heading');
  dialog.innerHTML = `<form id="capture-form"><h2 id="create-issue-heading">Create issue</h2><label for="capture-description">Description</label><textarea id="capture-description" required maxlength="24000" rows="7" style="width:100%;box-sizing:border-box"></textarea><p>Save an issue; implementation requires separate approval. Descriptions go to your configured model to derive titles and identify separate issues.</p><label><input id="capture-grill" type="checkbox" role="switch"> Grill me after creation</label><p>Start grilling in the saved issue conversation after creating the issue. This does not approve implementation.</p><p id="capture-error" role="alert"></p><p id="capture-status" role="status"></p><div class="actions"><button id="capture-save" type="submit">Save</button><button id="capture-cancel" type="button">Cancel</button></div></form>`;
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
    }
  } catch {}
  function clearDraft() {
    field.value = '';
    grilling.checked = false;
    requestId = null;
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
      link.href = '#/issue/' + encodeURIComponent(issue.id);
      link.textContent = issue.title;
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
  dialog.querySelector('form').onsubmit = async (event) => {
    event.preventDefault();
    if (saving) return;
    if (!field.value.trim()) {
      error.textContent = 'Description is required.';
      field.focus();
      return;
    }
    requestId ||= crypto.randomUUID();
    const input = { description: field.value, requestId, ...(grilling.checked ? { grill: true } : {}) };
    try {
      sessionStorage.setItem('factory-capture-draft', JSON.stringify(input));
    } catch {}
    saving = true;
    error.textContent = '';
    status.textContent = 'Saving…';
    dialog.setAttribute('aria-busy', 'true');
    dialog.querySelectorAll('button,textarea,input').forEach((node) => {
      node.disabled = true;
    });
    try {
      const result = await request('issue-capture', input);
      feedback(result.issues);
      for (const item of result.grilling || [])
        if (item.error) {
          const notice = document.createElement('p');
          notice.textContent = 'Issue saved. Grilling could not start: ' + item.error;
          toast.append(notice);
        }
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
      if (input.grill && result.issues.length) {
        location.hash = '#/issue/' + encodeURIComponent(result.issues[0].id);
        window.scrollTo(0, 0);
      } else {
        restoreReading();
        document.getElementById('create-issue')?.focus({ preventScroll: true });
      }
    } catch (failure) {
      error.textContent = failure.message + ' Retry Save with this draft; the submission identity is retained.';
    } finally {
      saving = false;
      status.textContent = '';
      dialog.removeAttribute('aria-busy');
      dialog.querySelectorAll('button,textarea,input').forEach((node) => {
        node.disabled = false;
      });
    }
  };
  return {
    bind(send, update) {
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
