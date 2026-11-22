import { mergedDelivery } from './factory-ui/merged-issue.mjs';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { readProjectEnv } from './factory-ui/project-env.mjs';
import { createFactoryPool } from './factory-ui/stores/postgres-connection.mjs';
import { openRecordStore, openIssueStore } from './factory-ui/stores/providers.mjs';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';
import { createProjectStores } from './factory-ui/stores/project-stores.mjs';
import { createArtifactRouter, inputDigest } from './factory-ui/stores/coordination.mjs';
import { collectEvidence, hydrateEvidence } from './factory-ui/stores/evidence.mjs';
import { createSourceCheckpoint, restoreSourceCheckpoint } from './factory-ui/stores/source-checkpoints.mjs';

const issueId = '20261121T175626340-4f536bc22ad8b97d';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const option = (args, name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};

function writeSummary(state, summary) {
  const bytes = JSON.stringify(summary, null, 2) + '\n';
  mkdirSync(dirname(state.receipt), { recursive: true });
  writeFileSync(state.output, bytes, { mode: 0o600 });
  writeFileSync(state.receipt, bytes, { mode: 0o600 });
}

function recordStage(state, summary, stage) {
  summary.stage = stage;
  summary.updatedAt = new Date().toISOString();
  writeSummary(state, summary);
  console.log(JSON.stringify({ stage, projectId: state.projectId, checks: summary.checks.length }));
}

function originalIssue(sourceRoot) {
  const candidates = ['.issues', '.issues/closed', '.issues/archive']
    .map((location) => join(sourceRoot, location, issueId + '.md'))
    .filter(existsSync);
  assert.equal(candidates.length, 1, 'Issue 193 must have one original report location.');
  const report = readFileSync(candidates[0]);
  const flowPath = join(sourceRoot, '.issues/flows', issueId, 'flow.json');
  const flowBytes = readFileSync(flowPath);
  const flow = JSON.parse(flowBytes);
  const number = JSON.parse(readFileSync(join(sourceRoot, '.issues/issue-numbers.json'))).issues[issueId];
  assert.equal(number, 193, 'The selected source must be issue 193.');
  assert.ok(mergedDelivery(flow), 'The original issue must retain a confirmed Merge.');
  return {
    report,
    flow,
    flowBytes,
    number,
    reportPath: candidates[0],
    flowPath,
    location: candidates[0].includes('/closed/') ? 'closed' : candidates[0].includes('/archive/') ? 'archive' : 'open',
  };
}

function sourceFingerprint(root, original) {
  const index = git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
  return {
    head: git(root, 'rev-parse', 'HEAD'),
    index: existsSync(index) ? digest(readFileSync(index)) : null,
    report: digest(readFileSync(original.reportPath)),
    flow: digest(readFileSync(original.flowPath)),
  };
}

function createRepositories(directory) {
  const remote = join(directory, 'remote.git');
  const first = join(directory, 'first');
  const second = join(directory, 'second');
  mkdirSync(remote);
  git(remote, 'init', '--bare', '-q');
  mkdirSync(first);
  git(first, 'init', '-q', '-b', 'source');
  git(first, 'config', 'user.name', 'Factory isolated storage acceptance');
  git(first, 'config', 'user.email', 'factory-test@example.invalid');
  git(first, 'config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(first, '.gitignore'), '.issues/\n');
  writeFileSync(join(first, 'source.txt'), 'Source must remain unchanged during shared issue updates.\n');
  git(first, 'add', '.');
  git(first, 'commit', '-qm', 'Isolated source');
  git(first, 'remote', 'add', 'origin', remote);
  git(first, 'push', '-qu', 'origin', 'source');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/source');
  execFileSync('git', ['clone', '-q', remote, second], { stdio: 'pipe' });
  git(second, 'config', 'core.hooksPath', '/dev/null');
  return { first, second };
}

function checkoutFingerprint(root) {
  return {
    head: git(root, 'rev-parse', 'HEAD'),
    tree: git(root, 'write-tree'),
    status: git(root, 'status', '--porcelain'),
  };
}

async function provisionDynamo(state) {
  state.dynamo = new DynamoDBClient({ region: state.region });
  await state.dynamo.send(
    new CreateTableCommand({
      TableName: state.table,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      Tags: [
        { Key: 'purpose', Value: 'factory-isolated-acceptance' },
        { Key: 'project', Value: state.projectId },
      ],
    })
  );
  state.tableCreated = true;
  await waitUntilTableExists({ client: state.dynamo, maxWaitTime: 120 }, { TableName: state.table });
}

async function providers(state, root) {
  const options = { root, projectId: state.projectId, artifacts: state.artifacts };
  const configs = [
    { id: 'files', kind: 'files', directory: join(state.directory, 'shared-files') },
    { id: 'git', kind: 'git', remote: 'origin', branch: 'issue-queue' },
    { id: 'postgres', kind: 'postgres' },
    { id: 'dynamodb', kind: 'dynamodb', table: state.table, region: state.region },
  ];
  const issueStores = new Map();
  const recordStores = new Map();
  for (const config of configs) {
    const issue = await openIssueStore({ ...config, id: config.id + '-issues' }, options);
    const records = await openRecordStore({ ...config, id: config.id + '-coordination' }, options);
    issueStores.set(config.id, issue);
    recordStores.set(config.id, records);
    state.providers.push(issue, records);
  }
  return { issueStores, recordStores };
}

async function openProject(state, root, coordination = 'git') {
  const opened = await providers(state, root);
  const project = createProjectStores({
    root,
    projectId: state.projectId,
    runnerId: root.endsWith('first') ? 'runner-a' : 'runner-b',
    records: opened.recordStores.get(coordination),
    ...opened,
    artifacts: state.artifacts,
  });
  return project;
}

async function retainIssueEvidence(state, original, summary) {
  const manifest = await collectEvidence({
    root: state.sourceRoot,
    flow: original.flow,
    artifacts: state.artifacts,
    originId: state.projectId,
    allowedRoots: [state.sourceRoot],
  });
  summary.evidence = {
    files: manifest.files.length,
    gaps: manifest.gaps.length,
    gapReasons: [...new Set(manifest.gaps.map((gap) => gap.reason))],
  };
  const direct = original.flow.blocks.flatMap((block) => block.attempts).flatMap((attempt) => attempt.evidence || []);
  for (const file of direct)
    assert.ok(
      manifest.files.some(
        (retained) => retained.path === file.path && (!file.sha256 || retained.sha256 === file.sha256)
      ),
      'A direct issue 193 evidence reference was not retained.'
    );
  summary.evidence.directReferences = direct.length;
  summary.evidence.historicalGapDigest = inputDigest(manifest.gaps);
  summary.evidence.historicalGapsPreserved = true;
  assert.ok(manifest.files.length >= 638, 'Expected issue 193 retained evidence inventory is incomplete.');
  const key = 'evidence/' + issueId;
  await state.project.coordination.commit(
    'retain-issue-193-evidence',
    [{ key, revision: null }],
    [{ key, value: { manifest } }]
  );
  state.manifest = manifest;
  summary.evidence.manifestPath = state.receipt.replace(/\.json$/, '') + '-evidence-manifest.json';
  writeFileSync(summary.evidence.manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  const checkpoint = await createSourceCheckpoint({
    checkout: state.repositories.first,
    artifacts: state.artifacts,
    projectId: state.projectId,
  });
  const checkpointKey = 'checkpoints/fixture-source';
  await state.project.coordination.commit(
    'retain-fixture-source-checkpoint',
    [{ key: checkpointKey, revision: null }],
    [{ key: checkpointKey, value: checkpoint }]
  );
  recordStage(state, summary, 'retained-issue-193-evidence');
}

async function verifyIssueEvidence(state, runner, summary) {
  const stored = await runner.coordination.get('evidence/' + issueId);
  const hydrated = await hydrateEvidence({
    manifest: stored.value.manifest,
    artifacts: state.artifacts,
    directory: join(state.repositories.second, '.issues/store-runtime/hydrated-evidence'),
  });
  assert.equal(
    inputDigest(hydrated.gaps),
    inputDigest(stored.value.manifest.gaps),
    'Artifact transfer introduced a new evidence gap or changed a historical gap.'
  );
  for (const file of stored.value.manifest.files)
    assert.equal(digest(hydrated.read(file.path, file.sha256)), file.sha256, 'A nested original proof digest changed.');
  summary.evidence.hydrated = hydrated.files.length;
  summary.evidence.verifiedAfterCoordinationMigration = true;
  const checkpoint = await runner.coordination.get('checkpoints/fixture-source');
  const restored = await restoreSourceCheckpoint({
    checkpoint: checkpoint.value,
    artifacts: state.artifacts,
    projectId: state.projectId,
    checkout: join(state.directory, 'restored-checkpoint'),
  });
  assert.equal(
    restored.head,
    state.beforeFirst.head,
    'The isolated fixture source checkpoint restored another commit.'
  );
  summary.sourceCheckpoint = { fixtureSourceOnly: true, sourceHead: restored.head, restored: true };
}

async function verifyIssue(project, original, summary) {
  const issue = await project.readIssue(issueId);
  assert.equal(digest(Buffer.from(issue.report)), digest(original.report), 'Exact report bytes changed.');
  assert.equal(inputDigest(issue.flow), inputDigest(original.flow), 'Confirmed flow history changed.');
  assert.equal(issue.number, 193, 'Stable issue number changed.');
  assert.ok(
    (await project.history(issueId)).some((entry) => digest(entry.report) === digest(original.report)),
    'Original report revision was lost.'
  );
  assert.equal((await project.coordination.list('claims/')).length, 0, 'Merged issue acquired an execution claim.');
  summary.checks.push({
    issueStore: issue.storeId,
    flowRevision: issue.flow.revision,
    reportSha256: digest(original.report),
    flowSha256: inputDigest(original.flow),
  });
}

async function verifyRunner(state, original, coordination, summary) {
  const runner = await openProject(state, state.repositories.second, coordination);
  await runner.refresh();
  await verifyIssue(runner, original, summary);
  const source = join(state.repositories.second, '.issues/flows', issueId, 'flow.json');
  assert.equal(
    inputDigest(JSON.parse(readFileSync(source))),
    inputDigest(original.flow),
    'Other runner received different history.'
  );
  assert.deepEqual(
    checkoutFingerprint(state.repositories.second),
    state.beforeSecond,
    'Refreshing shared issue state changed the other source workspace.'
  );
}

async function runScenario(state, original, summary) {
  const project = await openProject(state, state.repositories.first);
  state.project = project;
  const cachedFlow = join(project.root, '.issues/flows', issueId, 'flow.json');
  mkdirSync(dirname(cachedFlow), { recursive: true });
  writeFileSync(cachedFlow, original.flowBytes);
  await project.importIssue({
    id: issueId,
    number: 193,
    report: original.report,
    flow: original.flow,
    location: original.location,
    storeId: 'files',
    operationId: 'import-real-issue-193',
  });
  await project.refresh();
  await verifyIssue(project, original, summary);
  recordStage(state, summary, 'imported-issue-193');
  await retainIssueEvidence(state, original, summary);
  for (const storeId of ['git', 'postgres', 'dynamodb', 'files']) {
    await project.moveIssue({ issueId, storeId, operationId: 'move-issue-' + storeId });
    await project.refresh();
    await verifyIssue(project, original, summary);
    await verifyRunner(state, original, 'git', summary);
    recordStage(state, summary, 'issue-' + storeId);
  }
  for (const storeId of ['postgres', 'dynamodb']) {
    await project.moveProjectStore({ role: 'coordination', storeId, operationId: 'move-coordination-' + storeId });
    await project.refresh();
    await verifyIssue(project, original, summary);
    await verifyRunner(state, original, storeId, summary);
    recordStage(state, summary, 'coordination-' + storeId);
    if (storeId === 'dynamodb')
      await verifyIssueEvidence(state, await openProject(state, state.repositories.second, storeId), summary);
  }
  assert.ok(
    (await project.coordination.list('operations/')).every((record) => record.value.status === 'confirmed'),
    'A migration receipt remained pending.'
  );
  assert.equal(
    digest(readFileSync(cachedFlow)),
    digest(original.flowBytes),
    'Storage migration reformatted the original flow cache bytes.'
  );
  assert.deepEqual(checkoutFingerprint(project.root), state.beforeFirst, 'Storage writes changed the source checkout.');
  await assert.rejects(
    project.beginAttempt({
      issueId,
      blockId: original.flow.blocks.find((block) => block.kind === 'work').id,
      attempt: { id: 'forbidden-replay' },
      expectedRevision: original.flow.revision,
      operationId: 'forbidden-merged-replay',
    }),
    { code: 'STORE_MERGED' }
  );
}

async function cleanPostgres(state) {
  const pool = createFactoryPool({}, { root: state.sourceRoot });
  try {
    for (const table of ['store_records', 'store_operations'])
      await pool.query(`DELETE FROM factory.${table} WHERE project_id=$1`, [state.projectId]);
    for (const table of ['store_records', 'store_operations'])
      assert.equal(
        Number(
          (await pool.query(`SELECT count(*) AS count FROM factory.${table} WHERE project_id=$1`, [state.projectId]))
            .rows[0].count
        ),
        0
      );
  } finally {
    await pool.end();
  }
}

async function cleanS3(state) {
  const client = new S3Client({ region: state.region });
  const Bucket = state.bucket;
  const Prefix = state.prefix + '/' + state.projectId + '/';
  try {
    let page;
    do {
      page = await client.send(new ListObjectVersionsCommand({ Bucket, Prefix }));
      const Objects = [...(page.Versions || []), ...(page.DeleteMarkers || [])].map(({ Key, VersionId }) => ({
        Key,
        VersionId,
      }));
      if (Objects.length) {
        const deleted = await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects, Quiet: true } }));
        assert.equal(deleted.Errors?.length || 0, 0, 'Some isolated S3 object versions could not be removed.');
      }
    } while (page.IsTruncated);
    const remaining = await client.send(new ListObjectsV2Command({ Bucket, Prefix }));
    assert.equal(remaining.KeyCount || 0, 0, 'Isolated S3 artifacts remain after cleanup.');
  } finally {
    client.destroy();
  }
}

async function cleanup(state, summary) {
  const closed = await Promise.allSettled([...new Set(state.providers)].map((provider) => provider.close?.()));
  if (closed.some((result) => result.status === 'rejected')) summary.cleanup.connections = { status: 'failed' };
  const actions = [
    ['postgres', () => cleanPostgres(state)],
    ['s3', () => cleanS3(state)],
    [
      'dynamodb',
      async () => {
        if (!state.dynamo) return;
        try {
          await state.dynamo.send(new DescribeTableCommand({ TableName: state.table }));
        } catch (error) {
          if (error.name === 'ResourceNotFoundException') return;
          throw error;
        }
        await state.dynamo.send(new DeleteTableCommand({ TableName: state.table }));
        await waitUntilTableNotExists({ client: state.dynamo, maxWaitTime: 120 }, { TableName: state.table });
        await assert.rejects(state.dynamo.send(new DescribeTableCommand({ TableName: state.table })), {
          name: 'ResourceNotFoundException',
        });
      },
    ],
  ];
  for (const [name, action] of actions) {
    try {
      await action();
      summary.cleanup[name] = 'verified';
    } catch (error) {
      summary.cleanup[name] = { status: 'failed', code: error.code || error.name };
    }
  }
  state.dynamo?.destroy();
  state.physical?.client?.destroy();
  rmSync(state.directory, { recursive: true, force: true });
}

function acceptanceState({ sourceRoot, output, env }) {
  const projectId = 'live-issue-193-' + randomUUID();
  const state = {
    sourceRoot,
    projectId,
    output,
    receipt: join(dirname(output), 'issue-stores-live-runs', projectId + '.json'),
    table: 'timey-store-test-' + randomUUID(),
    region: env.FACTORY_ARTIFACTS_BUCKET_REGION || env.AWS_REGION || 'eu-central-1',
    bucket: env.FACTORY_ARTIFACTS_BUCKET,
    prefix: 'factory/live-tests',
    directory: mkdtempSync(join(tmpdir(), 'issue-stores-live-')),
    providers: [],
    tableCreated: false,
  };
  const summary = {
    version: 1,
    scenario: 'real merged issue 193 in an isolated storage namespace',
    projectId,
    table: state.table,
    productionCutover: false,
    receipt: state.receipt,
    originalIssueExecuted: false,
    checks: [],
    cleanup: {},
    startedAt: new Date().toISOString(),
  };
  return { state, summary };
}

async function prepareScenario(state, summary) {
  assert.ok(
    process.env.FACTORY_ISSUES_DB_URL && state.bucket,
    'Configure the dedicated Factory database and artifact bucket environment references.'
  );
  state.repositories = createRepositories(state.directory);
  state.beforeFirst = checkoutFingerprint(state.repositories.first);
  state.beforeSecond = checkoutFingerprint(state.repositories.second);
  await provisionDynamo(state);
  recordStage(state, summary, 'dynamodb-ready');
  state.physical = await openArtifactStore(
    { id: 's3-artifacts', kind: 's3', prefix: state.prefix },
    { root: state.sourceRoot, projectId: state.projectId }
  );
  state.artifacts = createArtifactRouter({
    active: state.physical,
    stores: new Map(),
    records: () => state.project?.records,
  });
}

export async function runLiveStoreAcceptance({ sourceRoot, output }) {
  const original = originalIssue(sourceRoot);
  const beforeOriginal = sourceFingerprint(sourceRoot, original);
  const env = { ...readProjectEnv(sourceRoot), ...process.env };
  for (const [key, value] of Object.entries(env))
    if (value !== undefined && process.env[key] === undefined) process.env[key] = value;
  const { state, summary } = acceptanceState({ sourceRoot, output, env });
  recordStage(state, summary, 'preparing-isolated-resources');
  try {
    await prepareScenario(state, summary);
    await runScenario(state, original, summary);
    summary.status = 'passed';
  } catch (error) {
    summary.status = 'failed';
    summary.error = { code: error.code || error.name, message: error.message };
  } finally {
    recordStage(state, summary, 'cleaning-isolated-resources');
    await cleanup(state, summary);
    assert.deepEqual(
      sourceFingerprint(sourceRoot, original),
      beforeOriginal,
      'The original issue/source changed during read-only acceptance.'
    );
    summary.originalUnchanged = true;
    summary.finishedAt = new Date().toISOString();
    if (Object.values(summary.cleanup).some((value) => value !== 'verified')) summary.status = 'failed';
    writeSummary(state, summary);
  }
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const sourceRoot = resolve(
    option(
      args,
      '--source-root',
      dirname(git(process.cwd(), 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    )
  );
  const output = resolve(option(args, '--output', join(tmpdir(), 'issue-stores-live-summary.json')));
  const result = await runLiveStoreAcceptance({ sourceRoot, output });
  console.log(JSON.stringify({ status: result.status, checks: result.checks.length, cleanup: result.cleanup, output }));
  if (result.status !== 'passed') process.exitCode = 1;
}
