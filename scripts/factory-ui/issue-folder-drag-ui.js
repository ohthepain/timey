window.createIssueFolderDrag = ({ list, canMove, move, dragging }) => {
  let issueId = null;
  let target = null;
  const payload = 'application/x-timey-issue';

  function clearTarget() {
    target?.classList.remove('issue-folder-drop-active');
    target = null;
  }

  function finish() {
    clearTarget();
    if (!issueId) return;
    issueId = null;
    dragging(null);
  }

  function destination(event) {
    const row = event.target.closest('[data-issue-folder-drop], [data-issue-master-drop]');
    return row && list.contains(row) ? row : null;
  }

  list.addEventListener('dragstart', (event) => {
    const row = event.target.closest('[data-issue][draggable="true"]');
    if (!row) return;
    if (!canMove(row.dataset.issue)) {
      event.preventDefault();
      return;
    }
    issueId = row.dataset.issue;
    event.dataTransfer.clearData();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(payload, issueId);
    dragging(issueId);
  });

  list.addEventListener('dragover', (event) => {
    if (!issueId) return;
    const row = destination(event);
    const drop = row?.dataset;
    if (!row || !canMove(issueId, drop)) {
      clearTarget();
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (target !== row) clearTarget();
    target = row;
    target.classList.add('issue-folder-drop-active');
  });

  list.addEventListener('dragleave', (event) => {
    if (target?.contains(event.relatedTarget)) return;
    clearTarget();
  });

  list.addEventListener('drop', (event) => {
    if (!issueId) return;
    const row = destination(event);
    const drop = row?.dataset;
    const id = issueId;
    event.preventDefault();
    const allowed = row && event.dataTransfer.getData(payload) === id && canMove(id, drop);
    finish();
    if (allowed) void move(id, drop);
  });

  list.addEventListener('dragend', finish);
};
