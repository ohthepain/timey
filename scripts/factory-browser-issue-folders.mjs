export default async function issueFoldersBrowserChecks(page) {
  function assertIssueUnchanged(issue, original, id) {
    if (issue.title !== original.title) throw Error('Issue title changed: ' + id);
    if (issue.state !== original.state) throw Error('Issue lifecycle changed: ' + id);
    if (issue.content !== original.content) throw Error('Issue content changed: ' + id);
  }

  async function dropIssue(id, targetSelector, after = false) {
    await page.evaluate(
      ({ id, targetSelector, after }) => {
        const handle = document.querySelector(`[data-implementation-drag="${id}"]`);
        const target = document.querySelector(targetSelector);
        if (!handle || !target) throw Error('Missing drag source or target: ' + id + ' → ' + targetSelector);
        const transfer = new DataTransfer();
        handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
        const bounds = target.getBoundingClientRect();
        const clientY = after ? bounds.bottom - 1 : bounds.top + 1;
        const detail = { bubbles: true, cancelable: true, dataTransfer: transfer, clientY };
        target.dispatchEvent(new DragEvent('dragover', detail));
        target.dispatchEvent(new DragEvent('drop', detail));
        handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
      },
      { id, targetSelector, after }
    );
  }

  function assertFolderPlacement(result) {
    if (result.a.folderId !== 'folder-1') throw Error('The remaining issue left its folder.');
    if (result.b.folderId !== 'folder-2') throw Error('The issue did not move to its destination folder.');
  }

  function assertIssueOrder(result, reordered) {
    if (reordered.join(',') !== 'a,b') throw Error('Folder-scoped drag did not reorder the issues.');
    if (result.order.indexOf('a') >= result.order.indexOf('b'))
      throw Error('The saved implementation order did not change.');
  }

  function assertFolderOutcome(result, original, reordered) {
    assertFolderPlacement(result);
    assertIssueOrder(result, reordered);
    assertIssueUnchanged(result.a, original.a, 'a');
    assertIssueUnchanged(result.b, original.b, 'b');
  }

  await page.getByRole('heading', { name: 'Issue queue', exact: true }).waitFor();
  await page.getByLabel('Sort issues', { exact: true }).selectOption('implementationOrder');
  const original = await page.evaluate(() => ({
    order: [...data.implementationOrder],
    issues: Object.fromEntries(
      ['a', 'b'].map((id) => {
        const issue = data.issues.find((entry) => entry.id === id);
        return [id, { title: issue.title, state: issue.state, content: issue.content }];
      })
    ),
  }));
  await page.getByRole('button', { name: /New folder/ }).click();
  await page.getByLabel('Folder name', { exact: true }).fill('Sprint');
  await page.getByRole('button', { name: 'Save folder', exact: true }).click();
  await page.locator('[data-issue-folder-drop="folder-1"]').waitFor();
  await dropIssue('a', '[data-issue-folder-drop="folder-1"]');
  await page.waitForFunction(() => data.issues.find((issue) => issue.id === 'a').folderId === 'folder-1');
  await dropIssue('b', '[data-issue-folder-drop="folder-1"]');
  await page.waitForFunction(() => data.issues.find((issue) => issue.id === 'b').folderId === 'folder-1');
  await page.locator('[data-issue-folder-select="folder-1"]').click();
  await dropIssue('b', '.issue-sidebar-item[data-issue-row="a"]', true);
  await page.waitForFunction(() => {
    const ids = [...document.querySelectorAll('.issue-sidebar-item[data-issue-row]')].map(
      (row) => row.dataset.issueRow
    );
    return ids.join(',') === 'a,b';
  });
  const reordered = await page
    .locator('.issue-sidebar-item[data-issue-row]')
    .evaluateAll((rows) => rows.map((row) => row.dataset.issueRow));
  await page.getByRole('button', { name: /New folder/ }).click();
  await page.getByLabel('Folder name', { exact: true }).fill('Next sprint');
  await page.getByRole('button', { name: 'Save folder', exact: true }).click();
  await dropIssue('b', '[data-issue-folder-drop="folder-2"]');
  await page.waitForFunction(() => data.issues.find((issue) => issue.id === 'b').folderId === 'folder-2');
  const result = await page.evaluate(() => ({
    a: data.issues.find((issue) => issue.id === 'a'),
    b: data.issues.find((issue) => issue.id === 'b'),
    order: data.implementationOrder,
  }));
  assertFolderOutcome(result, original.issues, reordered);
  const issueUnchanged = ['a', 'b'].every((id) => {
    const issue = result[id],
      before = original.issues[id];
    return issue.title === before.title && issue.state === before.state && issue.content === before.content;
  });
  return {
    passed: true,
    observed: {
      folderPlacement: { a: result.a.folderId, b: result.b.folderId },
      implementationOrder: { before: original.order, after: result.order },
      issueState: { a: result.a.state, b: result.b.state },
      contentAndLifecycleUnchanged: issueUnchanged,
    },
    assertions: [
      'created a user folder in the left issue sidebar',
      'dragged two issues into the folder without editing reports',
      'reordered issues within the selected folder',
      'dragged an issue between folders',
      'preserved issue content and lifecycle states',
    ],
  };
}
