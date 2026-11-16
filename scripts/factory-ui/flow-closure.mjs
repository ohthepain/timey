import { makeBlock } from './flow-store.mjs';
import { requestBlock } from './flow-block-data.mjs';

export function setRetroBlock(flow, catalog) {
  const current = flow.blocks.find((block) => block.kind === 'retro');
  if (requestBlock(flow).data.runRetro) return current || addRetro(flow, catalog);
  if (current) retireRetro(flow, current);
}

function addRetro(flow, catalog) {
  const close = flow.blocks.find((block) => block.kind === 'close');
  const retro = makeBlock('retro', close ? [close.id] : [], true, catalog);
  retro.id = 'closure-retro';
  flow.blocks.push(retro);
}

function retireRetro(flow, retro) {
  flow.blocks = flow.blocks.filter((block) => block.id !== retro.id);
  if (retro.attempts.length || retro.comments.length) {
    flow.retiredBlocks = [...(flow.retiredBlocks || []), retro];
  }
  for (const block of flow.blocks) block.after = block.after.flatMap((id) => (id === retro.id ? retro.after : [id]));
}

function closureBlock(flow, catalog, kind, after = []) {
  const saved = flow.blocks.find((block) => block.kind === kind);
  if (saved) return saved;
  const block = makeBlock(kind, after, false, catalog);
  flow.blocks.push(block);
  return block;
}

export function closureBlocks(flow, catalog) {
  const close = closureBlock(flow, catalog, 'close');
  const retro = flow.closing.retro ? closureBlock(flow, catalog, 'retro', [close.id]) : null;
  if (retro) retro.after = [close.id];
  const after = [(retro || close).id];
  const cleanup = closureBlock(flow, catalog, 'cleanup', after);
  cleanup.after = after;
  return { close, retro, cleanup };
}
