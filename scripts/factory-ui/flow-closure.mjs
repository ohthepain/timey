import { makeBlock } from './flow-store.mjs';
import { requestBlock } from './flow-block-data.mjs';

export function setRetroBlock(flow, catalog) {
  const current = flow.blocks.find((block) => block.id === 'closure-retro');
  const enabled = flow.closing ? flow.closing.retro : requestBlock(flow).data.runRetro;
  if (enabled) {
    if (current) {
      current.suggested = false;
      return current;
    }
    return addRetro(flow, catalog);
  }
  if (current) retireRetro(flow, current);
}

function addRetro(flow, catalog) {
  const close = flow.blocks.find((block) => block.kind === 'close');
  const retro = makeBlock('retro', close ? [close.id] : [], false, catalog);
  retro.id = 'closure-retro';
  flow.blocks.push(retro);
  return retro;
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
  const retro = flow.closing.retro ? setRetroBlock(flow, catalog) : null;
  if (retro) retro.after = [close.id];
  const after = [(retro || close).id];
  const cleanup = closureBlock(flow, catalog, 'cleanup', after);
  cleanup.after = after;
  return { close, retro, cleanup };
}
