import { z } from 'zod';
import { assertStoreState } from './coordination.mjs';

const referenceSchema = z
  .object({
    storeId: z.string(),
    key: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
  })
  .passthrough();
const owns = (key, ids) =>
  ids.some(
    (id) =>
      ['flows/', 'evidence/', 'classic/'].some((prefix) => key === prefix + id) ||
      ['progress/', 'commands/', 'issue-history/'].some((prefix) => key.startsWith(prefix + id + '/'))
  );

function destination(project, id) {
  const target = project.artifactStores.get(id) || (project.artifacts.id === id && project.artifacts);
  assertStoreState(target, 'STORE_UNCONFIGURED', 'Configure the destination Artifact store before moving issues.');
  return target;
}
async function verifyCopy(target, source, ref, body) {
  assertStoreState(
    ref.sha256 === source.sha256 && ref.bytes === source.bytes && (await target.get(ref)).equals(body),
    'STORE_MIGRATION_VERIFY',
    'The copied issue artifact could not be verified.'
  );
}
function nestedSnapshot(ref, body) {
  if (ref.mediaType !== 'application/json') return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

async function artifactCollector(project, target, ids) {
  const readers = new Map(await Promise.all(ids.map(async (id) => [id, await project.issueArtifacts(id)])));
  const copies = new Map();
  const ownedCopies = new Map(ids.map((id) => [id, new Map()]));
  const visited = new Set();
  async function copy(ref, issueId) {
    const identity = JSON.stringify([ref.storeId, ref.sha256, ref.bytes]);
    const ownerKey = JSON.stringify([issueId, identity, ref.mediaType]);
    if (visited.has(ownerKey)) return;
    visited.add(ownerKey);
    const body = await readers.get(issueId).get(ref);
    const saved = copies.get(identity) || (await target.put({ body, mediaType: ref.mediaType }));
    await verifyCopy(target, ref, saved, body);
    copies.set(identity, saved);
    ownedCopies.get(issueId).set(saved.sha256, saved);
    await visit(nestedSnapshot(ref, body), issueId);
  }
  async function visit(value, issueId) {
    if (value === null || typeof value !== 'object') return;
    if (referenceSchema.safeParse(value).success) return copy(value, issueId);
    await Promise.all(Object.values(value).map((entry) => visit(entry, issueId)));
  }
  return {
    async retain(record) {
      const id = ids.find((candidate) => owns(record.key, [candidate]));
      await visit(record.value, id);
    },
    sources: (sources) =>
      sources.map((source) => ({ ...source, artifactCopies: [...ownedCopies.get(source.id).values()] })),
  };
}
async function ownedRecords(project, ids) {
  const current = await project.records.list('');
  const retained = await project.records.retainedPayloads({ excludeArtifactInventory: true });
  return [...current, ...retained.receipts.flatMap((receipt) => receipt.records)].filter((record) =>
    owns(record.key, ids)
  );
}
async function verifyRetainedCopies(target, sources) {
  for (const source of sources) for (const ref of source.artifactCopies || []) await target.get(ref);
}

export async function prepareIssueArtifactMove(project, operation) {
  const { artifactStoreId, ids } = operation.value.input;
  const target = destination(project, artifactStoreId);
  if (operation.value.artifactsVerified) {
    await verifyRetainedCopies(target, operation.value.sources);
    return operation;
  }
  const collector = await artifactCollector(project, target, ids);
  for (const record of await ownedRecords(project, ids)) await collector.retain(record);
  return project.coordination.updateOperation(
    operation,
    {
      artifactsVerified: true,
      sources: collector.sources(operation.value.sources),
    },
    'artifact-copies'
  );
}
