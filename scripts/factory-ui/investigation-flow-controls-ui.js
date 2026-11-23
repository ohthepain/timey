window.createInvestigationFlowControls = ({ request, post, changed, archive }) => {
  const panel = document.createElement('section');
  panel.className = 'environment investigation-flow-controls';
  panel.hidden = true;
  panel.innerHTML =
    '<button type="button" class="small-button" data-investigation-settings>Investigation settings</button><button type="button" class="small-button" data-investigation-again hidden>Run again</button><button type="button" class="small-button" data-investigation-archive>Archive</button><form hidden><label class="field"><span>Reusable</span><input name="reusable" type="checkbox"></label><label class="field">Branch<select name="branch"></select></label><label class="field">Investigation prompt<textarea name="prompt" rows="3" required></textarea></label><label class="field">Additional instructions<textarea name="instructions" rows="2"></textarea></label><button class="small-button" type="submit">Save investigation settings</button></form><span role="alert"></span>';
  document.getElementById('graph-scroll').before(panel);
  const form = panel.querySelector('form');
  const error = panel.querySelector('[role="alert"]');
  const again = panel.querySelector('[data-investigation-again]');
  let current;
  let configuration;
  let pending = false;
  const send = (action, data = {}) =>
    post('project-home-action', { action, issueId: current.issue.id, requestId: crypto.randomUUID(), ...data });
  async function perform(task) {
    if (pending) return;
    pending = true;
    error.textContent = '';
    render(current);
    try {
      await task();
      await changed();
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      pending = false;
      render(current);
    }
  }
  async function settings() {
    const id = current.issue.id;
    const [saved, options] = await Promise.all([
      request('/api/investigation?issue=' + encodeURIComponent(id)),
      request('/api/project-home'),
    ]);
    if (id !== current.issue.id) return;
    configuration = saved;
    form.elements.reusable.checked = saved.reusable;
    form.elements.branch.replaceChildren(...options.branches.map(({ ref, name }) => new Option(name, ref)));
    form.elements.branch.value = saved.configuration.branch || options.defaultBranch;
    form.elements.prompt.value = saved.configuration.prompt;
    form.elements.instructions.value = saved.configuration.instructions;
    form.hidden = false;
  }
  panel.querySelector('[data-investigation-settings]').addEventListener('click', () => void perform(settings));
  panel
    .querySelector('[data-investigation-archive]')
    .addEventListener('click', () => void perform(() => archive(current.issue.id)));
  again.addEventListener('click', () => void perform(() => send('investigation-run')));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void perform(async () => {
      await send('investigation-save', {
        revision: configuration.revision,
        reusable: form.elements.reusable.checked,
        branch: form.elements.branch.value,
        prompt: form.elements.prompt.value,
        instructions: form.elements.instructions.value,
      });
      form.hidden = true;
    });
  });
  function identity(view) {
    return view?.issue?.id;
  }
  function controlsLocked(view) {
    const active = view.flow.blocks.some((block) =>
      ['running', 'stopping', 'uncertain'].includes(block.attempts.at(-1)?.status)
    );
    return [pending, active, view.issue.location === 'archive', view.issue.state === 'needs-approval'].some(Boolean);
  }
  function hasCompletedInquiry(block) {
    return (
      ['understand', 'investigate'].includes(block.kind) &&
      block.attempts.some((attempt) => attempt.status === 'completed')
    );
  }
  function render(view) {
    if (identity(current) !== identity(view)) {
      form.hidden = true;
      error.textContent = '';
    }
    current = view;
    panel.hidden = view?.flow?.routeType !== 'investigation';
    if (panel.hidden) return;
    updateControls(view);
  }
  function updateControls(view) {
    const locked = controlsLocked(view);
    for (const field of panel.querySelectorAll('button,input,select,textarea')) field.disabled = locked;
    again.hidden = !view.issue.reusable || !view.flow.blocks.some(hasCompletedInquiry);
    panel.querySelector('[data-investigation-archive]').hidden = view.issue.location === 'archive';
  }
  return { render };
};
