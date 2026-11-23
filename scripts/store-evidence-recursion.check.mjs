import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';
import { collectEvidence } from './factory-ui/stores/evidence.mjs';

test('a partial initial evidence batch still visits references discovered from its final JSON document', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'timey-evidence-recursion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, '.issues/evidence');
  await mkdir(directory, { recursive: true });
  const log = join(directory, 'nested.log');
  const summary = join(directory, 'summary.json');
  const bytes = Buffer.from('deep proof');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(log, bytes);
  await writeFile(summary, JSON.stringify({ proof: { path: log, sha256 } }));
  const artifacts = await openArtifactStore({ id: 'proofs', kind: 'files' }, { root, projectId: 'nested-proof' });
  const manifest = await collectEvidence({ root, artifacts, flow: { evidence: [{ path: summary }] } });
  assert.equal(manifest.files.length, 2);
  assert.ok(manifest.files.some((file) => file.path === log && file.sha256 === sha256));
});
