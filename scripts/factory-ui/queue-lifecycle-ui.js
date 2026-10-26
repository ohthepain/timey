/* Queue controls use the same Progress and question handlers as the issue screen. */
const queueLifecycleUI = (() => {
  const pending = new Map();
  const scrolls = new Map();
  const icons = {
    completed: '✓',
    skipped: '×',
    'planned-skip': '×',
    blocked: '!',
    failed: '!',
    idle: '▶',
    working: '◌',
  };
  function render(issue, esc) {
    const view = issue.queueLifecycle;
    if (!view) return '';
    return `<div class="queue-lifecycle" data-queue-scroll="${esc(issue.id)}" role="group" aria-label="${esc(issue.title || issue.id)} lifecycle">${view.roles.map((role) => square(issue, role, esc)).join('')}</div>`;
  }
  function square(issue, role, esc) {
    const saving = pending.get(issue.id) === role.state;
    const label = roleLabel(role);
    const id = `lifecycle-${issue.id}-${role.state}`;
    const attrs = `id="${esc(id)}" class="queue-role" aria-label="${esc(label)}" aria-describedby="${esc(id)}-help"`;
    const body = squareBody(role, saving, esc);
    const control = roleControl(issue, role, { attrs, body, saving }, esc);
    return `<span class="queue-role-shell">${control}<span class="queue-role-help" role="tooltip" id="${esc(id)}-help">${esc(label)}</span></span>`;
  }
  function roleLabel(role) {
    const status = role.waiting ? `${role.label}. Your input is needed` : role.label;
    return `${role.name}: ${status}. ${role.explanation || ''}`;
  }
  function squareBody(role, saving, esc) {
    const bubble = role.waiting ? 'has-input' : '';
    const state = saving ? 'is-saving' : '';
    return `<span class="queue-bubble ${bubble}" aria-hidden="true">!</span><span class="queue-square status-${esc(role.status)} ${state}" aria-hidden="true">${roleIcon(role.status, saving)}</span>`;
  }
  function roleIcon(status, saving) {
    if (saving) return '…';
    if (status === 'working') return '<span class="queue-spinner"></span>';
    return icons[status] || '';
  }
  function roleControl(issue, role, view, esc) {
    if (!role.action) return `<span ${view.attrs} tabindex="0">${view.body}</span>`;
    const disabled = pending.has(issue.id) ? 'aria-disabled="true"' : '';
    return `<button type="button" ${view.attrs} data-queue-role="${esc(issue.id)}" data-role-state="${esc(role.state)}" data-role-action="${esc(role.action)}" aria-busy="${view.saving}" ${disabled}>${view.body}</button>`;
  }
  function bind(container, options) {
    container.onclick = (event) => activate(event, options);
    restore(container);
  }
  function restore(container) {
    container.querySelectorAll('[data-queue-scroll]').forEach((group) => {
      group.scrollLeft = scrolls.get(group.dataset.queueScroll) || 0;
      group.onscroll = () => scrolls.set(group.dataset.queueScroll, group.scrollLeft);
    });
  }
  async function activate(event, options) {
    const button = event.target.closest('[data-queue-role]');
    if (!button || button.getAttribute('aria-disabled') === 'true') return;
    const issue = options.issue(button.dataset.queueRole);
    return chooseAction(button, issue, options);
  }
  function chooseAction(button, issue, options) {
    const actions = {
      input: () => options.openInput(issue),
      progress: () => options.progress(issue),
      toggle: () => saveChoice(issue, button.dataset.roleState, options),
    };
    return actions[button.dataset.roleAction]();
  }

  async function saveChoice(issue, target, options) {
    if (pending.has(issue.id)) return;
    pending.set(issue.id, target);
    options.render();
    options.feedback('', true);
    options.feedback('Saving future route choice…');
    try {
      await options.request('toggle-route', {
        issueId: issue.id,
        state: issue.state,
        target,
        basis: issue.queueLifecycle.basis,
      });
      options.feedback('Future route choice saved.');
    } catch (error) {
      options.feedback('Saved route kept.');
      options.feedback(`Route choice was not saved. ${error.message}`, true);
    } finally {
      pending.delete(issue.id);
      await options.refresh();
      options.render();
    }
  }
  return { render, bind, restore };
})();
