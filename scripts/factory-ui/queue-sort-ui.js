// Presentation-only ordering; never mutates queue records or the input array.
const queueSortUI = (() => {
  const modes = {
    statusOrder: 'Merged, running, queued',
    implementationOrder: 'Implementation order',
    lastProgress: 'Last progress',
    progress: 'Progress',
    created: 'Creation time',
    completed: 'Completion time',
    humanInput: 'Human input required',
  };
  const fixedDirections = {
    implementationOrder: { label: 'Implementation order direction is fixed', title: 'Implementation order is fixed' },
    statusOrder: { label: 'Queue status order is fixed', title: 'Queue status order is fixed' },
  };
  function descending(selection) {
    return selection.direction !== 'asc';
  }
  function fixed(selection) {
    return selection.sort === 'implementationOrder' || selection.sort === 'statusOrder';
  }
  function paintDirection(selection) {
    const button = document.getElementById('queue-direction');
    const state = directionState(selection);
    button.textContent = state.glyph;
    button.disabled = state.disabled;
    button.setAttribute('aria-label', state.label);
    button.title = state.title;
  }
  function directionState(selection) {
    const fixedState = fixedDirections[selection.sort];
    if (fixedState) return { glyph: '▼', disabled: true, ...fixedState };
    const direction = descending(selection) ? 'descending' : 'ascending';
    return {
      glyph: direction === 'descending' ? '▼' : '▲',
      disabled: false,
      label: `Direction, ${direction}`,
      title: direction[0].toUpperCase() + direction.slice(1),
    };
  }
  function option(key, label, selection) {
    return `<option value="${key}" ${selection.sort === key ? 'selected' : ''}>${label}</option>`;
  }
  function controls(selection) {
    const options = Object.entries(modes)
      .map(([key, label]) => option(key, label, selection))
      .join('');
    const isFixed = fixed(selection);
    const label = isFixed ? directionState(selection).label : directionLabel(selection);
    const title = isFixed ? directionState(selection).title : directionTitle(selection);
    return `<select id="queue-sort" aria-label="Sort issues">${options}</select><button type="button" id="queue-direction" class="direction-toggle" aria-label="${label}" title="${title}" ${isFixed ? 'disabled' : ''}>${directionGlyph(selection)}</button>`;
  }
  function directionLabel(selection) {
    return descending(selection) ? 'Direction, descending' : 'Direction, ascending';
  }
  function directionTitle(selection) {
    return descending(selection) ? 'Descending' : 'Ascending';
  }
  function directionGlyph(selection) {
    return descending(selection) ? '▼' : '▲';
  }
  function compareOrder(left, right) {
    return (
      (left.implementationOrder ?? Number.MAX_SAFE_INTEGER) - (right.implementationOrder ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id)
    );
  }
  function statusRank(issue) {
    return { merged: 0, running: 1, queued: 2 }[issue.strategy?.status] ?? 3;
  }
  function compareStatusOrder(left, right) {
    return statusRank(left) - statusRank(right) || compareOrder(left, right);
  }
  const fixedComparators = {
    implementationOrder: compareOrder,
    statusOrder: compareStatusOrder,
  };
  function compareMissing(aMissing, bMissing) {
    if (aMissing === bMissing) return 0;
    return aMissing ? 1 : -1;
  }
  function compareAvailable(left, right, selection, a, b) {
    const difference = a - b;
    if (difference) return selection.direction === 'asc' ? difference : -difference;
    return left.id.localeCompare(right.id);
  }
  function isMissing(value) {
    return value === null || value === undefined;
  }
  function compareMissingValues(left, right, a, b) {
    const aMissing = isMissing(a);
    const bMissing = isMissing(b);
    const missing = compareMissing(aMissing, bMissing);
    if (missing) return missing;
    if (aMissing) return left.id.localeCompare(right.id);
    return null;
  }
  function compareValues(left, right, selection, a, b) {
    const missing = compareMissingValues(left, right, a, b);
    if (missing !== null) return missing;
    return compareAvailable(left, right, selection, a, b);
  }
  function compare(left, right, selection) {
    const fixedComparator = fixedComparators[selection.sort];
    if (fixedComparator) return fixedComparator(left, right);
    const a = left.queueSort?.[selection.sort],
      b = right.queueSort?.[selection.sort];
    return compareValues(left, right, selection, a, b);
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
      if (fixed(selection)) return;
      selection.direction = descending(selection) ? 'asc' : 'desc';
      paintDirection(selection);
      changed();
    };
  }
  return { controls, sort, adjacent, bind };
})();
