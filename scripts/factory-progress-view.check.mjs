import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { outputHistory } from './factory-ui/output-history.mjs';

test('retained history pages losslessly across large Unicode records and live appends', (t) => {
  const { root } = gitFixture(t, 'progress-output-');
  mkdirSync(join(root, 'logs'));
  const store = { directory: join(root, 'logs'), runs: [{ id: 'one' }] };
  const event = (id, text) => ({ method: 'item/completed', params: { item: { id, type: 'agentMessage', text } } });
  const records = Array.from({ length: 12 }, (_, i) => event(String(i), 'å'.repeat(i === 5 ? 80000 : 12000)));
  const path = join(store.directory, 'one.jsonl');
  writeFileSync(path, records.map((e) => JSON.stringify(e) + '\n').join(''));
  let page = outputHistory(store, 'one');
  let events = page.events;
  appendFileSync(path, JSON.stringify(event('later', 'new')) + '\n');
  while (page.before) {
    page = outputHistory(store, 'one', page.before);
    events = [...page.events, ...events];
  }
  assert.deepEqual(events, records);
  assert.throws(() => outputHistory(store, '../no'), /no longer exists/);
  assert.throws(() => outputHistory(store, 'one', 5), /boundary/);
});
test('history excludes private reasoning and redacts retained public events', (t) => {
  const { root } = gitFixture(t, 'progress-private-');
  const store = { directory: root, runs: [{ id: 'one' }] };
  writeFileSync(
    join(root, 'one.jsonl'),
    [
      { method: 'item/completed', params: { item: { type: 'reasoning', text: 'private' } } },
      { method: 'item/completed', params: { item: { type: 'agentMessage', text: 'api_key=hidden-secret' } } },
      {
        method: 'item/autoApprovalReview/completed',
        params: {
          reviewId: 'review',
          review: { status: 'denied', rationale: 'Public refusal', reasoning: 'private-review' },
        },
      },
      {
        method: 'turn/completed',
        params: { turn: { status: 'completed', items: [{ type: 'reasoning', text: 'private-turn' }] } },
      },
    ]
      .map((e) => JSON.stringify(e) + '\n')
      .join('')
  );
  const result = outputHistory(store, 'one');
  assert.equal(result.events.length, 3);
  assert.equal(result.events[0].params.item.text, 'api_key=[redacted]');
  assert.doesNotMatch(JSON.stringify(result), /private-review|private-turn/);
  assert.match(JSON.stringify(result), /Public refusal/);
});
