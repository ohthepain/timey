import { routeQueueIssue, updateProgressSnapshot } from './browser-queue-route.mjs';

export default async function blockedProgressBrowserChecks(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await routeQueueIssue(page, 'b', (snapshot, issue) =>
    updateProgressSnapshot(snapshot, issue, 'blocked', '2026-11-01T10:04:00Z')
  );
  await page.goto(new URL('/#/issue/b', page.url()).href);
  const heading = page.getByRole('heading', { name: 'Checking pull request details', exact: true });
  await heading.waitFor();
  const summary = page.locator('#issue-progress-summary');
  const text = await summary.innerText();
  const assertions = [
    ['No failed shell command was recorded.', 'The internal check was shown as a failed command.'],
    ['work response named PR #37', 'The conflicting pull request facts were not explained.'],
    ['no PR number saved', 'The conflicting pull request facts were not explained.'],
    ['Last recorded command', 'A successful command was shown as the cause of the block.', true],
  ];
  const failed = assertions.find(([expected, , negate]) => text.includes(expected) === Boolean(negate));
  if (failed) throw Error(failed[1]);
  await summary.getByText('Technical details (optional)', { exact: true }).click();
  const details = await summary.innerText();
  if (!details.includes('Saved issue record: no PR number'))
    throw Error('Optional diagnostics omitted the saved pull request record.');
  if (errors.length) throw Error(errors.join('; '));
  return {
    passed: true,
    assertions: ['blocked step and saved facts', 'no false failed-command claim', 'optional technical details'],
  };
}
