/* Every queue role links to its details on the issue screen. */
const queueLifecycleUI = (() => {
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
    const saving = false;
    const label = roleLabel(role);
    const id = `lifecycle-${issue.id}-${role.state}`;
    const attrs = `id="${esc(id)}" class="queue-role" aria-label="${esc(label)}" aria-describedby="${esc(id)}-help"`;
    const body = squareBody(role, saving, esc);
    const control = roleControl(issue, role, { attrs, body, saving }, esc);
    return `<span class="queue-role-shell ${role.future ? 'is-ahead' : ''} ${['skipped', 'planned-skip'].includes(role.status) ? 'is-skipped' : ''}">${control}<span class="queue-role-help" role="tooltip" id="${esc(id)}-help">${esc(label)}</span></span>`;
  }
  function roleLabel(role) {
    const status = role.waiting ? `${role.label}. Your input is needed` : role.label;
    return `${role.name}: ${status}. Open this step on the issue page.`;
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
    const href = '#/issue/' + encodeURIComponent(issue.id) + '?stage=' + encodeURIComponent(role.state);
    return `<a ${view.attrs} href="${esc(href)}">${view.body}</a>`;
  }
  function bind(container) {
    restore(container);
  }
  function restore(container) {
    container.querySelectorAll('[data-queue-scroll]').forEach((group) => {
      group.scrollLeft = scrolls.get(group.dataset.queueScroll) || 0;
      group.onscroll = () => scrolls.set(group.dataset.queueScroll, group.scrollLeft);
    });
  }
  return { render, bind, restore };
})();
