// Presentation-only ordering; never mutates queue records or the input array.
const queueSortUI = (() => {
  const modes = {
    lastProgress: 'Last progress',
    progress: 'Progress',
    created: 'Creation time',
    completed: 'Completion time',
    humanInput: 'Human input required',
  };
  function descending(selection) {
    return selection.direction !== 'asc';
  }
  function paintDirection(selection) {
    const button = document.getElementById('queue-direction');
    const down = descending(selection);
    button.textContent = down ? '▼' : '▲';
    button.setAttribute('aria-label', down ? 'Direction, descending' : 'Direction, ascending');
    button.title = down ? 'Descending' : 'Ascending';
  }
  function controls(selection) {
    const down = descending(selection);
    return `<select id="queue-sort" aria-label="Sort issues">${Object.entries(modes)
      .map(([key, label]) => `<option value="${key}" ${selection.sort === key ? 'selected' : ''}>${label}</option>`)
      .join(
        ''
      )}</select><button type="button" id="queue-direction" class="direction-toggle" aria-label="${down ? 'Direction, descending' : 'Direction, ascending'}" title="${down ? 'Descending' : 'Ascending'}">${down ? '▼' : '▲'}</button>`;
  }
  function compare(left, right, selection) {
    const a = left.queueSort?.[selection.sort],
      b = right.queueSort?.[selection.sort];
    const aMissing = a === null || a === undefined,
      bMissing = b === null || b === undefined;
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    const difference = aMissing ? 0 : a - b;
    if (difference) return selection.direction === 'asc' ? difference : -difference;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  }
  function sort(issues, selection) {
    return issues.slice().sort((a, b) => compare(a, b, selection));
  }
  function adjacent(issues, issueId, offset) {
    const index = issues.findIndex((issue) => issue.id === issueId);
    return index < 0 ? null : (issues[index + offset] ?? null);
  }
  function bind(selection, changed) {
    document.getElementById('queue-sort').onchange = (event) => {
      selection.sort = event.target.value;
      selection.direction = 'desc';
      paintDirection(selection);
      changed();
    };
    document.getElementById('queue-direction').onclick = () => {
      selection.direction = descending(selection) ? 'asc' : 'desc';
      paintDirection(selection);
      changed();
    };
  }
  return { controls, sort, adjacent, bind };
})();
