import { mergedDelivery } from './merged-issue.mjs';
import { readFileSync } from 'node:fs';
import { digest } from './common.mjs';
import { successfulInvestigationSource, successfulReportFindings } from './investigation-flow.mjs';

export const blockDefinitionId = (block) => block.definition ?? block.kind;
export const requestBlock = (flow) => flow.blocks?.find((block) => block.kind === 'request');
export const requestData = (flow) =>
  requestBlock(flow)?.data ?? { wording: flow.request?.wording, fields: { ...flow.request, type: flow.type } };
export function deliveryTarget(flow) {
  const target = flow.target;
  if (flow.destination?.branch) return { ...target, branch: flow.destination.branch };
  const ref = flow.startingPoint?.ref;
  if (ref) {
    const local = 'refs/heads/';
    const remote = `refs/remotes/${target.remote}/`;
    const prefix = ref.startsWith(local) ? local : ref.startsWith(remote) ? remote : null;
    return { ...target, branch: prefix ? ref.slice(prefix.length) : null };
  }
  if (flow.resolvedBranch) return { ...target, branch: flow.resolvedBranch };
  return target;
}
export const startingPoint = (flow) => flow.startingPoint;
export const missingMergePR = (branch) => 'No PR exists for ' + branch + '. Publish the issue PR first.';

export function withoutTarget(blocks, target) {
  return blocks
    .filter((block) => block.id !== target.id)
    .map((block) =>
      block.after.includes(target.id)
        ? { ...block, after: [...new Set(block.after.flatMap((id) => (id === target.id ? target.after : id)))] }
        : block
    );
}

export function latestCurrentAttempt(block) {
  const attempt = block.attempts.findLast((item) => !item.cancelledByEdit);
  return attempt?.invalidatedAt ? undefined : attempt;
}

export function invalidateBlocks(flow, seeds, cascade = true) {
  if (mergedDelivery(flow)) return new Set();
  const affected = new Set(seeds);
  const at = new Date().toISOString();
  for (const block of flow.blocks) {
    if (cascade && block.after.some((id) => affected.has(id))) affected.add(block.id);
    if (!affected.has(block.id)) continue;
    for (const attempt of block.attempts) attempt.invalidatedAt ??= at;
    if (block.kind === 'request') block.data.fields = null;
  }
  return affected;
}

export function blockAddresses(blocks) {
  const counts = new Map();
  for (const block of blocks) counts.set(block.label, (counts.get(block.label) || 0) + 1);
  const addresses = new Map();
  for (const block of blocks) {
    const parent = blocks.find((item) => item.id === block.after.at(-1));
    const address = counts.get(block.label) > 1 && parent ? addresses.get(parent.id) + '.' + block.label : block.label;
    addresses.set(block.id, address);
  }
  return addresses;
}

export function upstreamBlocks(block, blocks) {
  if (!block.after) return blocks;
  const ids = new Set(block.after);
  for (const candidate of blocks.toReversed()) if (ids.has(candidate.id)) for (const id of candidate.after) ids.add(id);
  return blocks.filter((item) => ids.has(item.id));
}

function artifactValue(block, key) {
  if (block.kind === 'request' && key === 'wording') return block.data.wording;
  if (block.kind === 'request' && Object.hasOwn(block.data.fields ?? {}, key)) return block.data.fields[key];
  const attempt = latestCurrentAttempt(block);
  if (!['completed', 'failed', 'blocked', 'stopped'].includes(attempt?.status)) return undefined;
  if (Object.hasOwn(attempt.artifacts?.values ?? {}, key)) return attempt.artifacts.values[key];
  const file = attempt.artifacts?.files?.[key];
  if (!file) return undefined;
  try {
    if (file.sha256 && digest(readFileSync(file.path)) !== file.sha256) return undefined;
    return file;
  } catch {
    return undefined;
  }
}

const startBranch = (flow) => startingPoint(flow)?.name ?? deliveryTarget(flow)?.branch;
function investigationSource(flow, issue) {
  try {
    return successfulInvestigationSource(flow, issue.id);
  } catch {
    return undefined;
  }
}
function reportSupplement(flow, issue) {
  const source = investigationSource(flow, issue);
  return source ? successfulReportFindings(flow, source) : [];
}
const issueFlowSources = new Map([
  ['Investigation.source', investigationSource],
  ['Investigation.supplementalFindings', reportSupplement],
  ['issue.title', (_flow, issue) => issue.title],
  ['issue.content', (_flow, issue) => issue.content],
  ['Starting point.branch', startBranch],
  ['Starting point.startingPoint', startingPoint],
  ['Destination.delivery', deliveryTarget],
  ['Destination.branch', (flow) => deliveryTarget(flow).branch],
  ['Target.branch', startBranch],
  ['Target.startingPoint', startingPoint],
  ['Target.delivery', deliveryTarget],
]);

export function blockDetails(flow, issue, block, definitions) {
  const definition = definitions.get(blockDefinitionId(block));
  const addresses = blockAddresses(flow.blocks);
  const parents = upstreamBlocks(block, flow.blocks);
  return (block.declaredDetails ?? definition?.details ?? []).map(({ key, label, source, initial, type, options }) => {
    if (source === 'Request.title' || (block.kind === 'publish' && source.startsWith('Request.'))) {
      const producer = requestBlock(flow);
      const field = source.slice('Request.'.length);
      const value = field === 'title' ? issue.title : producer && artifactValue(producer, field);
      return { key, label, type, options, value, input: true, fixed: true, requestId: producer?.id };
    }
    if (source === 'derived')
      return {
        key,
        label,
        type: type || 'text',
        options: options || [],
        value: artifactValue(block, key),
        derived: true,
      };
    if (source === 'block.enabledEdits')
      return {
        key,
        label,
        source,
        value: block.edits.filter((edit) => edit.enabled).map((edit) => edit.text),
        derived: true,
      };
    const fixed = issueFlowSources.get(source);
    if (fixed) return { key, label, type, options, input: true, fixed: true, value: fixed(flow, issue) };
    const separator = source.lastIndexOf('.');

    const name = separator < 0 || source === 'editable' ? '' : source.slice(0, separator);
    const output = separator < 0 ? key : source.slice(separator + 1);
    const selected = block.links?.[key];
    const candidates = parents
      .filter((item) => !name || item.id === selected || addresses.get(item.id) === name)
      .filter((item) =>
        (item.declaredArtifacts ?? definitions.get(blockDefinitionId(item))?.artifacts ?? []).some(
          (artifact) => artifact.key === output
        )
      )
      .map((item) => ({
        blockId: item.id,
        address: addresses.get(item.id),
        output,
      }));
    const choice = selected
      ? candidates.find((entry) => entry.blockId === selected)
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    const producer = parents.find((item) => item.id === choice?.blockId);
    const wording = block.kind === 'request' && key === 'wording';
    const manual = wording || Object.hasOwn(block.inputs ?? {}, key);
    const mode = manual ? 'manual' : choice ? 'source' : 'manual';
    return {
      key,
      label,
      input: true,
      type: type || 'text',
      options: options || [],
      candidates,
      selected: choice?.blockId,
      mode,
      editable: mode === 'manual',
      value: wording
        ? block.data.wording
        : manual
          ? block.inputs[key]
          : producer
            ? artifactValue(producer, output)
            : initial,
      source: choice
        ? {
            ...choice,
            attemptId: latestCurrentAttempt(producer)?.id,
          }
        : undefined,
    };
  });
}

export function blockOutputs(flow, block, definitions) {
  const declared = block.declaredArtifacts ?? definitions.get(blockDefinitionId(block))?.artifacts ?? [];
  return declared.map(({ key, kind, label, type, options }) => ({
    key,
    kind,
    label,
    type: type || (kind === 'file' ? 'file' : 'text'),
    options: options || [],
    value: artifactValue(block, key),
  }));
}

export function definitionMap(entries) {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

export function definitionIdentity(entry) {
  return entry?.checksum ?? digest('missing definition');
}
