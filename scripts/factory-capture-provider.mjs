import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { captureFixture } from './factory-capture-fixture.mjs';
import { assessCapture } from './factory-ui/capture-assessment.mjs';
const evidence = mkdtempSync(join(tmpdir(), 'timey-capture-provider-'));
console.log(evidence);
const cleanup = [];
const { root, service } = captureFixture({ after: (fn) => cleanup.push(fn) }, { assess: assessCapture });
const cases = [
  {
    description:
      '1. Open the issues list. 2. Type a search. 3. Open an issue and return. The search text disappears; it should stay.',
    count: 1,
    category: 'bug',
  },
  {
    description:
      'Rename the issues list heading from Issue queue to Issues. Also add a Copy ID button on each issue page.',
    count: 2,
    category: 'enhancement',
  },
];
try {
  const results = [];
  for (const item of cases) {
    const result = await service.captures.save({ description: item.description, requestId: crypto.randomUUID() });
    assert.equal(result.issues.length, item.count);
    for (const issue of result.issues) {
      const text = readFileSync(join(root, '.issues', issue.id + '.md'), 'utf8');
      assert.ok(text.includes(item.description));
      assert.ok(text.includes('category: ' + item.category));
      writeFileSync(join(evidence, issue.id + '.md'), text);
    }
    results.push({ input: item, result });
    writeFileSync(join(evidence, 'results.json'), JSON.stringify(results, null, 2));
  }
  assert.equal(service.store.runs.length, 0);
  writeFileSync(
    join(evidence, 'assertions.json'),
    JSON.stringify({ passed: true, cases: results.length, noWorkRuns: true })
  );
} catch (error) {
  writeFileSync(join(evidence, 'failure.txt'), error.message);
  throw error;
} finally {
  for (const close of cleanup.reverse()) await close();
}
