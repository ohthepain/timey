import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockCatalog } from './factory-ui/block-catalog.mjs';
import { setRetroBlock } from './factory-ui/flow-closure.mjs';
const catalog = new BlockCatalog().read().entries;
const flow = () => ({
  blocks: [
    { id: 'request', kind: 'request', data: { runRetro: true } },
    { id: 'close', kind: 'close' },
  ],
});

test('Run a retro creates a normal planned block', () => {
  const saved = flow();
  setRetroBlock(saved, catalog);
  const retro = saved.blocks.find((block) => block.id === 'closure-retro');
  assert.equal(retro.suggested, false);
  assert.deepEqual(retro.after, ['close']);
});

test('existing enabled Retro blocks retain their identity, skill and history while losing suggested status', () => {
  const saved = flow();
  const retro = {
    id: 'closure-retro',
    kind: 'retro',
    suggested: true,
    skill: 'retro',
    attempts: [{ id: 'previous' }],
    comments: [],
  };
  saved.blocks.push(retro);
  setRetroBlock(saved, catalog);
  assert.equal(saved.blocks.at(-1), retro);
  assert.equal(retro.suggested, false);
  assert.equal(retro.skill, 'retro');
  assert.deepEqual(retro.attempts, [{ id: 'previous' }]);
});

test('closure keeps its frozen Retro choice even if request metadata differs', () => {
  const saved = flow();
  saved.blocks[0].data.runRetro = false;
  saved.closing = { retro: true };
  setRetroBlock(saved, catalog);
  assert.equal(saved.blocks.at(-1).kind, 'retro');
  assert.equal(saved.blocks.at(-1).suggested, false);
});
