const siteReviewUI = (() => {
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  function mount(data, request, refresh) {
    document.querySelectorAll('[data-site-review]').forEach((slot) => {
      const issue = data.issues.find((item) => item.id === slot.dataset.siteReview);
      for (const check of issue.siteReview.checks) slot.append(build(issue, check, request, refresh));
    });
  }
  function browserMenu(browsers) {
    const select = node('select');
    select.setAttribute('aria-label', 'Browser for site review');
    for (const browser of browsers) {
      const option = node('option', browser.label);
      option.value = browser.id;
      select.append(option);
    }
    return select;
  }
  function panelHeading(check) {
    if (check.completed) return 'Site review approved';
    return check.status === 'failed' ? 'Changes requested' : 'Review the site';
  }
  function approvalLabel(check) {
    return check.kind === 'judgment' ? 'Approve result' : 'Record observation';
  }
  function openingStatus(receipt) {
    return receipt ? 'Site opened. Record your review when ready.' : 'Open the site to enable review.';
  }
  function feedbackProblem(kind, outcome, text) {
    if (text) return '';
    if (outcome === 'failed') return 'Describe the changes you need before submitting.';
    if (kind === 'evidence') return 'Describe your actual observation before submitting.';
    return '';
  }
  function recordingStatus(outcome) {
    return outcome === 'passed' ? 'Recording approval…' : 'Recording requested changes…';
  }
  function resultText(text) {
    return text || 'I reviewed the opened site and approve this result.';
  }
  function build(issue, check, request, refresh) {
    const panel = node('section', '', 'required-decision');
    panel.append(node('h4', panelHeading(check)), node('p', check.instructions));
    if (issue.siteReview.mode === 'preview') {
      panel.append(node('p', 'Preview only. Record your decision on the real issue linked in the header.'));
      return panel;
    }
    const address = node('p', check.url, 'muted');
    panel.append(address);
    if (check.completed) {
      panel.append(node('p', check.result));
      return panel;
    }
    if (check.status === 'failed') panel.append(node('p', check.result));
    const label = node('label', 'Open in '),
      select = browserMenu(issue.siteReview.browsers);
    label.append(select);
    const open = node('button', 'Open site');
    open.type = 'button';
    const feedbackLabel = node('label', 'Review comments'),
      feedback = node('textarea');
    feedback.id = 'site-review-feedback-' + issue.id + '-' + check.id;
    feedback.dataset.draftKey = 'site-review-' + issue.id + '-' + check.id + '-' + check.revision;
    feedback.maxLength = 4000;
    feedback.placeholder = 'Describe any changes you need…';
    feedbackLabel.append(feedback);
    const approve = node('button', approvalLabel(check)),
      change = node('button', 'Needs changes');
    approve.type = change.type = 'button';
    let receipt = check.opened;
    approve.disabled = change.disabled = !receipt;
    const status = node('p', openingStatus(receipt));
    status.setAttribute('role', 'status');
    open.onclick = async () => {
      let popup = null;
      if (select.value === 'current') {
        popup = window.open(check.url, '_blank');
        if (!popup) {
          status.textContent = 'The browser blocked the new tab. Allow it and try Open site again.';
          return;
        }
        popup.opener = null;
      }
      open.disabled = true;
      status.textContent = 'Opening site…';
      try {
        receipt = await request('site-review-open', {
          issueId: issue.id,
          checkId: check.id,
          basis: check.basis,
          browser: select.value,
        });
        approve.disabled = change.disabled = false;
        status.textContent = 'Site opened. Record your review when ready.';
      } catch (error) {
        popup?.close();
        status.textContent = error.message;
      } finally {
        open.disabled = false;
      }
    };
    const decide = async (outcome) => {
      const text = feedback.value.trim();
      const problem = feedbackProblem(check.kind, outcome, text);
      if (problem) {
        status.textContent = problem;
        feedback.focus();
        return;
      }
      approve.disabled = change.disabled = true;
      status.textContent = recordingStatus(outcome);
      try {
        await request('site-review-decide', {
          issueId: issue.id,
          checkId: check.id,
          basis: check.basis,
          token: receipt.token,
          status: outcome,
          result: resultText(text),
        });
        status.textContent = 'Review recorded.';
        await refresh();
      } catch (error) {
        status.textContent = error.message;
        approve.disabled = change.disabled = false;
      }
    };
    approve.onclick = () => decide('passed');
    change.onclick = () => decide('failed');
    panel.append(label, open, feedbackLabel, approve, change, status);
    return panel;
  }
  return { mount };
})();
