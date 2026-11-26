import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureRoute } from './flow-browser-routes.mjs';

test('route teardown drains a held request and preserves the other owner', async () => {
  const pattern = '**/api/diagnostic-activity';
  const handlers = new Set([() => {}]);
  const detached = Promise.withResolvers();
  const handled = Promise.withResolvers();
  const page = {
    async route(_, handler) {
      handlers.add(handler);
    },
    async unroute(_, handler) {
      handlers.delete(handler);
      detached.resolve();
    },
  };
  const remove = await fixtureRoute(page, pattern, () => handled.promise);
  const request = [...handlers].at(-1)();
  let finished = false;
  const teardown = remove().then(() => {
    finished = true;
  });
  try {
    await detached.promise;
    await new Promise(setImmediate);
    assert.equal(finished, false, 'Teardown returned while the activity request was still held.');
    assert.equal(handlers.size, 1, 'The other owner can still handle its routes.');
  } finally {
    handled.resolve();
    await request;
    await teardown;
  }
  assert.equal(finished, true);
});
