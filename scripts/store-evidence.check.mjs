import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';
import {
  collectEvidence,
  hydrateEvidence,
  evidencePath,
  registerEvidenceResolver,
} from './factory-ui/stores/evidence.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'timey-evidence-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const issueRoot = join(root, '.issues/evidence');
  await mkdir(issueRoot, { recursive: true });
  const artifactDirectory = join(root, 'artifact-bytes');
  const artifacts = await openArtifactStore(
    { id: 'proofs', kind: 'files', directory: artifactDirectory },
    { root, projectId: 'proof-tests' }
  );
  return { root, issueRoot, artifacts, artifactDirectory };
}

test('portable nested proof preserves original JSON bytes and resolves relative logs after source removal', async (t) => {
  const f = await fixture(t);
  const log = join(f.issueRoot, 'command.log');
  const unhashed = join(f.issueRoot, 'direct-unhashed.log');
  const summary = join(f.issueRoot, 'summary.json');
  const logBytes = Buffer.from('start\nordered tool outcome\nfinish\n');
  await writeFile(log, logBytes);
  await writeFile(unhashed, 'Direct command output without a previously recorded digest.');
  const summaryBytes = Buffer.from(
    '{ "proof": { "path": "command.log", "sha256": "' + sha(logBytes) + '" }, "files": ["command.log"] }\n'
  );
  await writeFile(summary, summaryBytes);
  const flow = {
    blocks: [
      {
        attempts: [
          {
            evidence: [
              { path: summary, sha256: sha(summaryBytes) },
              { path: unhashed, key: 'log' },
            ],
            result: { supportingProof: [{ path: log, sha256: sha(logBytes) }] },
          },
        ],
      },
    ],
  };
  const originalFlow = JSON.stringify(flow);
  const manifest = await collectEvidence({ root: f.root, flow, artifacts: f.artifacts });
  assert.equal(manifest.files.length, 3);
  assert.deepEqual(manifest.gaps, []);
  assert.equal(JSON.stringify(flow), originalFlow);
  assert.deepEqual(await readFile(summary), summaryBytes);
  await rm(f.issueRoot, { recursive: true });
  const hydrated = await hydrateEvidence({
    manifest,
    artifacts: f.artifacts,
    directory: join(f.root, 'receiving/.issues/proofs'),
  });
  assert.deepEqual(hydrated.read(summary, sha(summaryBytes)), summaryBytes);
  assert.deepEqual(hydrated.read('command.log', sha(logBytes), summary), logBytes);
  const unregister = registerEvidenceResolver(f.root, hydrated);
  assert.equal(evidencePath(f.root, summary, sha(summaryBytes)), hydrated.resolve(summary, sha(summaryBytes)));
  unregister();
  assert.equal(evidencePath(f.root, summary, sha(summaryBytes)), summary);
  await writeFile(hydrated.resolve(log, sha(logBytes)), 'tampered');
  assert.throws(
    () => hydrated.resolve(log, sha(logBytes)),
    (error) => error.code === 'STORE_EVIDENCE_GAP'
  );
});

test('evidence gaps reject missing, changed, symbolic-link, and outside-root references without reading secrets', async (t) => {
  const f = await fixture(t);
  const changed = join(f.issueRoot, 'changed.log');
  const outside = join(f.root, '.env');
  const symbolic = join(f.issueRoot, 'escape.log');
  await writeFile(changed, 'changed');
  await writeFile(outside, 'PRIVATE_TEST_VALUE=never-upload');
  await symlink(outside, symbolic);
  const flow = {
    evidence: [
      { path: changed, sha256: sha('original') },
      { path: join(f.issueRoot, 'missing.log'), sha256: sha('missing') },
      { path: outside, sha256: sha('PRIVATE_TEST_VALUE=never-upload') },
      { path: symbolic, sha256: sha('PRIVATE_TEST_VALUE=never-upload') },
    ],
  };
  const manifest = await collectEvidence({ root: f.root, flow, artifacts: f.artifacts });
  assert.equal(manifest.files.length, 0);
  assert.equal(manifest.gaps.length, 4);
  assert.ok(manifest.gaps.some((gap) => gap.reason === 'digest-mismatch'));
  assert.deepEqual(await f.artifacts.list(), []);
});

test('missing or corrupt remote artifact remains a visible gap with no local-path fallback', async (t) => {
  const f = await fixture(t);
  const proof = join(f.issueRoot, 'proof.log');
  await writeFile(proof, 'verified');
  const manifest = await collectEvidence({
    root: f.root,
    flow: { evidence: [{ path: proof, sha256: sha('verified') }] },
    artifacts: f.artifacts,
  });
  const [file] = manifest.files;
  await writeFile(join(f.artifactDirectory, 'proof-tests', file.sha256), 'corrupt');
  const hydrated = await hydrateEvidence({ manifest, artifacts: f.artifacts, directory: join(f.root, 'received') });
  assert.equal(hydrated.gaps.length, 1);
  assert.throws(
    () => hydrated.resolve(proof, file.sha256),
    (error) => error.code === 'STORE_EVIDENCE_GAP'
  );
});

function mainProject() {
  if (process.env.TIMEY_STORE_REAL_ISSUE_ROOT) return process.env.TIMEY_STORE_REAL_ISSUE_ROOT;
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim();
  return dirname(common);
}

test('real merged issue 193 copies its complete proof graph without altering report, flow, or hashed summaries', async (t) => {
  const sourceRoot = mainProject();
  const id = '20261121T175626340-4f536bc22ad8b97d';
  const source = join(sourceRoot, '.issues/flows', id, 'flow.json');
  if (!existsSync(source)) return t.skip('The user-authorized real issue fixture is unavailable in this checkout.');
  const f = await fixture(t);
  const flowBytes = await readFile(source);
  const flow = JSON.parse(flowBytes);
  const reportPath = ['.issues', '.issues/closed', '.issues/archive']
    .map((location) => join(sourceRoot, location, id + '.md'))
    .find(existsSync);
  assert.ok(reportPath);
  const report = await readFile(reportPath);
  await writeFile(join(f.root, 'original-report.md'), report);
  await writeFile(join(f.root, 'original-flow.json'), flowBytes);
  const manifest = await collectEvidence({
    root: sourceRoot,
    flow,
    originId: 'real-issue-193',
    artifacts: f.artifacts,
  });
  assert.ok(manifest.files.length >= 638, `Expected the complete retained graph; imported ${manifest.files.length}.`);
  const direct = [...flow.blocks, ...(flow.retiredBlocks || [])]
    .flatMap((block) => block.attempts)
    .flatMap((attempt) => attempt.evidence || []);
  for (const proof of direct)
    assert.ok(
      manifest.files.some((file) => file.path === proof.path && (!proof.sha256 || file.sha256 === proof.sha256)),
      'Every directly retained proof reference must transfer.'
    );
  const hydrated = await hydrateEvidence({
    manifest,
    artifacts: f.artifacts,
    directory: join(f.root, 'another-runner/.issues/proofs'),
  });
  assert.equal(
    hydrated.gaps.length,
    manifest.gaps.length,
    'Hydration must retain original historical gaps without adding missing uploads.'
  );
  for (const file of manifest.files) assert.equal(sha(hydrated.read(file.path, file.sha256)), file.sha256);
  assert.deepEqual(await readFile(source), flowBytes);
  assert.deepEqual(await readFile(reportPath), report);
  const merged = flow.blocks.find((block) => block.kind === 'merge');
  assert.equal(merged.attempts.at(-1).status, 'completed');
  if (process.env.TIMEY_STORE_EVIDENCE_REPORT)
    await writeFile(
      process.env.TIMEY_STORE_EVIDENCE_REPORT,
      JSON.stringify(
        {
          sourceFlowSha256: sha(flowBytes),
          sourceReportSha256: sha(report),
          directReferences: direct.length,
          transferredFiles: manifest.files.length,
          retainedGaps: manifest.gaps.length,
          manifest,
        },
        null,
        2
      )
    );
  t.diagnostic(
    `Read-only issue 193 transfer verified ${manifest.files.length} immutable proof files and retained ${manifest.gaps.length} historical gaps.`
  );
});
