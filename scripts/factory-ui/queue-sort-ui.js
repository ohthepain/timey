// Presentation-only ordering; never mutates queue records or the input array.
const queueSortUI = (() => {
  const modes = {
    implementationOrder: 'Implementation order',
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
    const state = directionState(selection);
    button.textContent = state.glyph;
    button.disabled = state.disabled;
    button.setAttribute('aria-label', state.label);
    button.title = state.title;
  }
  function directionState(selection) {
    if (selection.sort === 'implementationOrder')
      return { glyph: '▼', disabled: true, label: 'Implementation order direction is fixed', title: 'Implementation order is fixed' };
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
    const options = Object.entries(modes).map(([key, label]) => option(key, label, selection)).join('');
    const fixed = selection.sort === 'implementationOrder';
    const label = fixed ? 'Implementation order direction is fixed' : directionLabel(selection);
    const title = fixed ? 'Implementation order is fixed' : directionTitle(selection);
    return `<select id="queue-sort" aria-label="Sort issues">${options}</select><button type="button" id="queue-direction" class="direction-toggle" aria-label="${label}" title="${title}" ${fixed ? 'disabled' : ''}>${directionGlyph(selection)}</button>`;
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
    return left.implementationOrder - right.implementationOrder;
  }
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
    if (selection.sort === 'implementationOrder') return compareOrder(left, right);
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
      if (selection.sort === 'implementationOrder') return;
      selection.direction = descending(selection) ? 'asc' : 'desc';
      paintDirection(selection);
      changed();
    };
  }
  return { controls, sort, adjacent, bind };
})();
