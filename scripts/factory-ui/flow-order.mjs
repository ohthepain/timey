export const inquiryKinds = new Set(['understand', 'investigate']);
export const investigationOutputKinds = new Set(['generate-report', 'create-issues']);

export function independentOutput(flow, block) {
  return flow.routeType === 'investigation' && investigationOutputKinds.has(block.kind);
}
export function blockDependencies(flow, block, index) {
  if (independentOutput(flow, block)) {
    const inquiry = flow.blocks.slice(0, index).findLast(({ kind }) => inquiryKinds.has(kind)) ?? flow.blocks[0];
    return [inquiry.id];
  }
  return laneDependencies(flow.blocks, index, block.lane);
}
function laneDependencies(blocks, index, lane) {
  const previous = blocks.slice(0, index).findLast((item) => item.lane === lane && !item.suggested) || blocks[0];
  return previous && index > 0 ? [previous.id] : [];
}
export function joinPendingLanes(blocks) {
  blocks.forEach((block, index) => {
    if ((!block.suggested && block.kind !== 'publish') || block.attempts.length) return;
    const prefix = blocks.slice(0, index);
    const parents = new Set(prefix.flatMap((item) => item.after));
    block.after = prefix.filter((item) => !parents.has(item.id)).map((item) => item.id);
  });
}

export function reorderedBlocks(flow, from, to, { insert }) {
  const blocks = flow.blocks.map((block) => ({ ...block }));
  if (insert) {
    const lane = blocks[to].lane;
    const [block] = blocks.splice(from, 1);
    blocks.splice(to, 0, { ...block, lane });
  } else {
    [blocks[from], blocks[to]] = [blocks[to], blocks[from]];
  }
  blocks.forEach((block, index) => {
    block.after = blockDependencies({ ...flow, blocks }, block, index);
  });
  joinPendingLanes(blocks);
  return blocks;
}
