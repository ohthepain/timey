export default async function queueDragBrowserChecks(page) {
  await page.getByRole('heading', { name: 'Issue queue', exact: true }).waitFor();
  await page.evaluate(`(() => {
    const source = document.querySelector('[data-implementation-drag="a"]');
    const target = document.querySelector('[data-issue-row="b"]');
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientY: target.getBoundingClientRect().top + 1,
    }));
    const observed = {
      dragged: source.closest('tr').classList.contains('is-dragged'),
      position: target.classList.contains('drop-before'),
    };
    if (!observed.dragged || !observed.position) throw Error('Drag highlight or drop position was missing');
    target.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientY: target.getBoundingClientRect().top + 1,
    }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
    const ids = [...document.querySelectorAll('#issues tr[data-issue-row]')].map((row) => row.dataset.issueRow);
    const feedbackRemains = document.querySelector('#issues .is-dragged, #issues .drop-before, #issues .drop-after');
    if (ids.join(',') !== 'a,b,x' || feedbackRemains) throw Error('Drop did not clear feedback after optimistic reorder');
  })()`);
  return {
    passed: true,
    assertions: [
      'dragged issue highlight',
      'drop position marker',
      'optimistic visual reorder',
      'feedback clears after drop',
    ],
  };
}
