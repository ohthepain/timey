// Presentation-only ordering; never mutates queue records or the input array.
const queueSortUI = (() => {
  const modes = {
    lastProgress: 'Last progress',
    progress: 'Progress',
    created: 'Creation time',
    completed: 'Completion time',
    humanInput: 'Human input required',
  };
  function controls(selection) {
    return `<select id="queue-sort" aria-label="Sort issues">${Object.entries(modes)
      .map(([key, label]) => `<option value="${key}" ${selection.sort === key ? 'selected' : ''}>${label}</option>`)
      .join(
        ''
      )}</select><select id="queue-direction" aria-label="Sort direction"><option value="desc" ${selection.direction === 'desc' ? 'selected' : ''}>Highest / newest first</option><option value="asc" ${selection.direction === 'asc' ? 'selected' : ''}>Lowest / oldest first</option></select>`;
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
  function bind(selection, changed) {
    document.getElementById('queue-sort').onchange = (event) => {
      selection.sort = event.target.value;
      selection.direction = 'desc';
      document.getElementById('queue-direction').value = 'desc';
      changed();
    };
    document.getElementById('queue-direction').onchange = (event) => {
      selection.direction = event.target.value;
      changed();
    };
  }
  return { controls, sort, bind };
})();
