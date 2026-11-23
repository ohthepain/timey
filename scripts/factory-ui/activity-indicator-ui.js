(() => {
  'use strict';

  function markup(active) {
    return active
      ? '<span class="activity-indicator" data-view-key="activity-indicator" role="status"><span class="activity-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="activity-label">Working</span></span>'
      : '';
  }

  function sync(container, active) {
    const indicator = container.querySelector(':scope > .activity-indicator');
    if (!active) indicator?.remove();
    else if (!indicator) container.insertAdjacentHTML('beforeend', markup(true));
  }

  window.timeyActivity = { markup, sync };
})();
