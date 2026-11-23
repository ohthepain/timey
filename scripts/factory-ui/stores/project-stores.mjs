import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parse } from 'yaml';
import {
  createCoordination,
  createIssueArtifactRouter,
  cloneRecord,
  inputDigest,
  assertStoreState,
  sameOwner,
  storeFailure,
  validIdentity,
} from './coordination.mjs';
import { installSnapshot, readSnapshot } from './snapshots.mjs';
import { moveIssue, moveProjectStore } from './migrations.mjs';
import { deleteIssue, resumeDelete } from './deletion.mjs';

const asMap = (value) => (value instanceof Map ? value : new Map(Object.entries(value || {})));
const reportText = (value) => (typeof value === 'string' ? value : Buffer.from(value).toString('utf8'));
const flowKey = (id) => 'flows/' + validIdentity(id);
const catalogKey = (id) => 'catalog/' + validIdentity(id);
const storagePair = ({ storeId, artifactStoreId }) => JSON.stringify([storeId, artifactStoreId]);
const now = () => new Date().toISOString();

function localRunner(root) {
  const path = join(root, '.issues/store-runtime/runner.json');
  if (existsSync(path)) return validIdentity(JSON.parse(readFileSync(path, 'utf8')).id, 'runner');
  mkdirSync(dirname(path), { recursive: true });
  const id = randomUUID();
  try {
    writeFileSync(path, JSON.stringify({ id }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return validIdentity(JSON.parse(readFileSync(path, 'utf8')).id, 'runner');
}

function validateReport(id, report) {
  const header = report.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  assertStoreState(Boolean(header), 'STORE_INVALID_REPORT', 'The issue report needs YAML frontmatter.');
  assertStoreState(
    parse(header)?.id === id,
    'STORE_INVALID_REPORT',
    'The report identity differs from the requested issue.'
  );
}

function merged(flow) {
  if (flow?.merged) return true;
  return [...(flow?.blocks || []), ...(flow?.retiredBlocks || [])].some(
    (block) =>
      block.kind === 'merge' &&
      block.attempts.some(
        (attempt) =>
          attempt.status === 'completed' &&
          Number.isSafeInteger(attempt.result?.pr) &&
          Boolean(attempt.result?.revision)
      )
  );
}

function assertFlowVersion(record, expected) {
  if (typeof expected === 'number') {
    assertStoreState(
      (record?.value.revision ?? 0) === expected,
      'STORE_CONFLICT',
      'The shared flow changed. Refresh before editing.'
    );
    return;
  }
  assertStoreState(
    (record?.revision ?? null) === (expected ?? null),
    'STORE_CONFLICT',
    'The shared flow changed. Refresh before editing.'
  );
}

function sameFlow(record, flow) {
  return Boolean(record && inputDigest(record.value) === inputDigest(flow));
}

function validateFlowSave(record, flow, expectedRevision, purpose) {
  const unchanged = sameFlow(record, flow);
  assertStoreState(
    !merged(record?.value) || permitsClosure(record.value, flow, purpose) || unchanged,
    'STORE_MERGED',
    'This merged issue is read-only.'
  );
  assertFlowVersion(record, expectedRevision);
  return unchanged;
}

function confirmedFlowSave(coordination, operation, record, inputHash) {
  coordination.matchOperation(operation, inputHash);
  return operation.value.status === 'confirmed' ? { flow: record?.value ?? null } : null;
}

function flowSaveKeys(issueId, operationId) {
  assertStoreState(
    typeof operationId === 'string' && operationId.length > 0 && operationId.length < 500,
    'STORE_INVALID_OPERATION',
    'Supply a stable operation identity.'
  );
  return { key: 'operations/' + encodeURIComponent(operationId), claimKey: 'claims/' + validIdentity(issueId) };
}

function recordRevision(record) {
  return record?.revision ?? null;
}

function updatedFlow(record, flow, at) {
  return { ...cloneRecord(flow), revision: (record?.value.revision || 0) + 1, updatedAt: at };
}

function flowSaveTransaction(
  { catalog, record, gate, unchanged, key, claimKey, operationId },
  input,
  inputHash,
  runnerId
) {
  const at = now();
  const flow = unchanged ? record.value : updatedFlow(record, input.flow, at);
  const value = {
    id: operationId,
    kind: 'save-flow',
    input,
    inputHash,
    status: 'confirmed',
    createdAt: at,
    confirmedAt: at,
    runnerId,
    token: randomUUID(),
    result: {},
  };
  return {
    flow,
    transaction: {
      operationId: operationId + '/atomic',
      expected: [
        { key: catalog.key, revision: catalog.revision },
        { key: flowKey(input.issueId), revision: recordRevision(record) },
        { key: claimKey, revision: null },
        { key: 'project/migration', revision: recordRevision(gate) },
        { key, revision: null },
      ],
      writes: [{ key, value }, ...(!unchanged ? [{ key: flowKey(input.issueId), value: flow }] : [])],
    },
  };
}

async function reconcileFlowSave(project, { key, issueId, inputHash, operationId }, error) {
  let recovered;
  try {
    recovered = await project.pinnedRead(async (view) => ({
      operation: await view.coordination.get(key),
      record: await view.coordination.get(flowKey(issueId)),
    }));
  } catch {
    throw Object.assign(error, { operationId, pending: true });
  }
  if (recovered.operation) {
    const confirmed = confirmedFlowSave(project.coordination, recovered.operation, recovered.record, inputHash);
    if (confirmed) return confirmed;
  }
  throw Object.assign(error, { operationId, pending: error.code !== 'STORE_CONFLICT' });
}

export function createProjectStores({
  root,
  projectId,
  records,
  issueStores,
  artifacts,
  runnerId,
  recordStores,
  artifactStores,
  onCutover,
}) {
  const project = {};

  project.root = root;
  project.projectId = validIdentity(projectId, 'project');
  project.runnerId = runnerId || localRunner(root);
  project.coordination = createCoordination(records, { runnerId: project.runnerId });
  project.issueStores = asMap(issueStores);
  project.artifacts = artifacts;
  project.recordStores = asMap(recordStores);
  project.artifactStores = asMap(artifactStores);
  project.onCutover = onCutover;
  project.journals = new Map();
  project.progressFlushes = new Map();

  return Object.defineProperties(
    project,
    Object.getOwnPropertyDescriptors({
      get records() {
        return this.coordination.records;
      },
      issueStore(id) {
        const store = this.issueStores.get(id);
        assertStoreState(Boolean(store), 'STORE_UNCONFIGURED', 'The selected Issue store is not configured.');
        return store;
      },
      async issueArtifacts(issueId) {
        const catalog = await this.coordination.get(catalogKey(issueId));
        const id = catalog?.value.artifactStoreId;
        assertStoreState(
          id,
          'STORE_PROFILE_MIGRATION_REQUIRED',
          'Migrate this issue’s saved Artifact destination before writing files.'
        );
        const active = this.artifactStores.get(id) || (this.artifacts.id === id && this.artifacts);
        assertStoreState(active, 'STORE_UNCONFIGURED', 'The saved issue Artifact store is not configured.');
        return createIssueArtifactRouter({
          active,
          stores: new Map(this.artifactStores),
          records: () => this.records,
        });
      },
      async catalog(issueId) {
        const record = await this.coordination.get(catalogKey(issueId));
        assertStoreState(Boolean(record), 'STORE_ISSUE_MISSING', 'The issue is not registered in the shared catalog.');
        assertStoreState(record.value.state === 'active', 'STORE_MIGRATING', 'The issue is being created or moved.');
        return record;
      },
      async readIssue(issueId) {
        const catalog = await this.catalog(issueId);
        return this.readCatalogIssue(catalog, this.issueStore(catalog.value.storeId));
      },
      async readCatalogIssue(catalog, provider) {
        const issueId = catalog.value.id;
        const issue = await provider.read(issueId);
        assertStoreState(Boolean(issue), 'STORE_ISSUE_MISSING', 'The authoritative issue report is missing.');
        const flow = await this.coordination.get(flowKey(issueId));
        return {
          ...issue,
          report: reportText(issue.report),
          id: issueId,
          issue,
          number: catalog.value.number,
          storeId: catalog.value.storeId,
          artifactStoreId: catalog.value.artifactStoreId,
          homeEpoch: catalog.value.epoch,
          catalog: catalog.value,
          flow: flow?.value ?? null,
          flowRevision: flow?.revision ?? null,
        };
      },
      async pinnedRead(action) {
        const read = (records) => {
          const view = Object.create(this);
          view.coordination = createCoordination(records, { runnerId: this.runnerId });
          return action(view);
        };
        return typeof this.records.readSnapshot === 'function' ? this.records.readSnapshot(read) : read(this.records);
      },
      async displayCatalogs(issueIds) {
        if (!issueIds) return this.coordination.list('catalog/');
        return (await Promise.all(issueIds.map((id) => this.coordination.get(catalogKey(id))))).filter(Boolean);
      },
      async listCatalogIssues({ location, issueIds } = {}, catalogs) {
        const entries = (catalogs ?? (await this.displayCatalogs(issueIds))).filter(
          (entry) => entry.value.state === 'active'
        );
        const groups = new Map();
        for (const entry of entries) {
          const key = entry.value.storeId;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(entry);
        }
        const batches = await Promise.all(
          [...groups].map(async ([storeId, catalogs]) => {
            const provider = this.issueStore(storeId);
            const read = (pinned) => Promise.all(catalogs.map((catalog) => this.readCatalogIssue(catalog, pinned)));
            return typeof provider.readSnapshot === 'function' ? provider.readSnapshot(read) : read(provider);
          })
        );
        return batches
          .flat()
          .filter((issue) => !location || issue.location === location)
          .sort((a, b) => a.number - b.number);
      },
      listIssues(options = {}) {
        return this.pinnedRead((view) => view.listCatalogIssues(options));
      },
      snapshot(options = {}) {
        return this.pinnedRead((view) => view.readDisplaySnapshot(options));
      },
      async displayClaims(scope) {
        const records = scope
          ? await Promise.all(scope.map((id) => this.coordination.get('claims/' + id)))
          : await this.coordination.list('claims/');
        return records.filter(Boolean).map(({ value }) => value);
      },
      async displayCommands(scope) {
        const records = scope
          ? (await Promise.all(scope.map((id) => this.coordination.list('commands/' + id + '/')))).flat()
          : await this.coordination.list('commands/');
        return records.map(({ value }) => value);
      },
      async readDisplaySnapshot({ issueIds, ...options }) {
        const scope = issueIds?.length ? [...new Set(issueIds)] : undefined;
        const catalogs = await this.displayCatalogs(scope);
        const [issues, claims, commands] = await Promise.all([
          this.listCatalogIssues(options, catalogs),
          this.displayClaims(scope),
          this.displayCommands(scope),
        ]);
        const deletedIssueIds = catalogs
          .filter((entry) => entry.value.state === 'deleted')
          .map((entry) => entry.value.id);
        return {
          version: 1,
          projectId: this.projectId,
          capturedAt: now(),
          issues,
          claims,
          commands,
          deletedIssueIds,
          ...(scope && { issueIds: scope }),
        };
      },
      async refresh(options = {}) {
        try {
          return installSnapshot(this.root, await this.snapshot(options));
        } catch (error) {
          if (!options.allowCached) throw error;
          const cached = readSnapshot(this.root);
          if (!cached) throw error;
          return {
            ...cached,
            unavailable: true,
            warning: 'The authoritative store is unavailable. Cached data is read-only.',
          };
        }
      },
      async createIssue(input) {
        await this.assertGroupStore(
          reportText(input.report),
          input.storeId,
          input.artifactStoreId || this.artifacts.id
        );
        return this.importIssue({ ...input, id: input.issueId || input.id });
      },
      async importIssue({
        id,
        number,
        report,
        flow = null,
        location = 'open',
        storeId,
        artifactStoreId = this.artifacts.id,
        operationId,
      }) {
        validIdentity(id);
        const text = reportText(report);
        validateReport(id, text);
        const op = await this.coordination.operation(operationId, 'create-issue', {
          id,
          number,
          report: text,
          flow,
          location,
          storeId,
          artifactStoreId,
        });
        if (op.value.status === 'confirmed') return { status: 'confirmed', ...(await this.readIssue(id)) };
        try {
          await this.reserveCatalog(op);
          await this.publishImportedIssue(op);
          return { status: 'confirmed', ...(await this.readIssue(id)) };
        } catch (error) {
          await this.coordination.pending(op, error);
          throw Object.assign(error, { operationId, pending: true });
        }
      },
      legacyNextNumber() {
        const path = join(this.root, '.issues/issue-numbers.json');
        if (!existsSync(path)) return 1;
        const registry = JSON.parse(readFileSync(path, 'utf8'));
        return Math.max(registry.next || 1, ...Object.values(registry.issues || {}).map((number) => number + 1));
      },
      async reserveCatalog(op) {
        const input = op.value.input;
        const key = catalogKey(input.id);
        const existing = await this.coordination.get(key);
        if (existing) {
          assertStoreState(existing.value.state !== 'deleted', 'STORE_DELETED', 'This issue was permanently deleted.');
          assertStoreState(
            existing.value.creationOperation === op.value.id,
            'STORE_ISSUE_EXISTS',
            'Another operation already created this issue.'
          );
          return existing;
        }
        for (let attempt = 0; attempt < 8; attempt++) {
          try {
            return await this.allocateCatalog(op);
          } catch (error) {
            if (error.code !== 'STORE_CONFLICT') throw error;
          }
        }
        throw storeFailure('STORE_CONFLICT', 'Issue number allocation kept changing. Retry the same creation.');
      },
      async allocateCatalog(op) {
        const input = op.value.input;
        const counter = await this.coordination.get('project/numbers');
        const selected = input.number ?? Math.max(counter?.value.next || 1, this.legacyNextNumber());
        assertStoreState(
          Number.isSafeInteger(selected) && selected > 0,
          'STORE_INVALID_NUMBER',
          'Choose a valid issue number.'
        );
        const catalogs = await this.coordination.list('catalog/');
        assertStoreState(
          !catalogs.some((record) => record.value.number === selected && record.value.id !== input.id),
          'STORE_NUMBER_CONFLICT',
          'Another issue already owns this number.'
        );
        const key = catalogKey(input.id);
        const value = {
          id: input.id,
          number: selected,
          storeId: input.storeId,
          artifactStoreId: input.artifactStoreId,
          epoch: op.value.token,
          state: 'creating',
          creationOperation: op.value.id,
        };
        await this.coordination.commit(
          op.value.id + '/reserve-' + (counter?.revision || 'new'),
          [
            { key, revision: null },
            { key: 'project/numbers', revision: counter?.revision ?? null },
          ],
          [
            { key, value },
            { key: 'project/numbers', value: { next: Math.max(selected + 1, counter?.value.next || 1) } },
          ]
        );
        return this.coordination.get(key);
      },
      async publishImportedIssue(op) {
        const { id, storeId, report, location, flow } = op.value.input;
        const provider = this.issueStore(storeId);
        let current = await provider.read(id);
        if (!current)
          current = await provider.commit({
            issueId: id,
            expectedRevision: null,
            operationId: op.value.id + '/issue',
            report,
            location,
          });
        assertStoreState(
          reportText(current.report) === report && current.location === location,
          'STORE_IMPORT_CONFLICT',
          'The destination report differs from the imported issue.'
        );
        const catalog = await this.coordination.get(catalogKey(id));
        const savedFlow = await this.coordination.get(flowKey(id));
        assertStoreState(
          !savedFlow || inputDigest(savedFlow.value) === inputDigest(flow),
          'STORE_IMPORT_CONFLICT',
          'The destination flow differs from the imported history.'
        );
        const operation = await this.coordination.get(op.key);
        const writes = [
          { key: catalog.key, value: { ...catalog.value, state: 'active' } },
          { key: op.key, value: { ...operation.value, status: 'confirmed', confirmedAt: now() } },
        ];
        const expected = [
          { key: catalog.key, revision: catalog.revision },
          { key: op.key, revision: operation.revision },
        ];
        if (flow && !savedFlow) {
          expected.push({ key: flowKey(id), revision: null });
          writes.push({ key: flowKey(id), value: flow });
        }
        await this.coordination.commit(op.value.id + '/activate', expected, writes);
      },
      async atomicIssueSave(request) {
        const { issueId, operationId, owner, flow, purpose } = request;
        const kind = purpose === 'closure' ? 'close' : purpose === 'storage' ? 'storage' : (request.kind ?? 'edit');
        if (owner || flow !== undefined || kind !== 'edit') return null;
        const coordinationId = this.records.id;
        const state = await this.pinnedRead(async (view) => {
          const catalog = await view.catalog(issueId);
          const provider = this.issueStore(catalog.value.storeId);
          if (catalog.value.storeId !== coordinationId || !provider.supportsCoordinatedCommit) return null;
          const current = await view.readCatalogIssue(catalog, provider);
          const key = 'operations/' + encodeURIComponent(operationId);
          const [operation, claim, gate] = await Promise.all([
            view.coordination.get(key),
            view.coordination.get('claims/' + issueId),
            view.coordination.get('project/migration'),
          ]);
          const text = reportText(request.report);
          validateReport(issueId, text);
          const groups = await view.assertGroupStore(text, current.storeId, current.artifactStoreId);
          return { catalog, provider, current, key, operation, claim, gate, groups, text };
        });
        if (!state) return null;
        const { catalog, provider, current, key, operation, claim, gate, groups, text } = state;
        const input = {
          issueId,
          report: text,
          location: request.location || current.location,
          expectedRevision: request.expectedRevision,
          storeId: current.storeId,
          homeEpoch: current.homeEpoch,
          kind,
          owner: null,
        };
        const inputHash = inputDigest({ kind: 'save-issue', input });
        if (operation) {
          this.coordination.matchOperation(operation, inputHash);
          return operation.value.status === 'confirmed' ? { status: 'confirmed', ...current } : null;
        }
        assertStoreState(
          typeof operationId === 'string' && operationId.length > 0 && operationId.length < 500,
          'STORE_INVALID_OPERATION',
          'Supply a stable operation identity.'
        );
        assertStoreState(!claim, 'STORE_CLAIMED', 'Another runner or attempt owns this issue.');
        assertStoreState(!merged(current.flow), 'STORE_MERGED', 'This merged issue is read-only.');
        this.coordination.requireGate(gate);
        const expected = new Map([
          [catalog.key, { key: catalog.key, revision: catalog.revision }],
          [flowKey(issueId), { key: flowKey(issueId), revision: current.flowRevision }],
          ['claims/' + issueId, { key: 'claims/' + issueId, revision: null }],
          ['project/migration', { key: 'project/migration', revision: gate?.revision ?? null }],
          [key, { key, revision: null }],
          ...groups.map((record) => [record.key, { key: record.key, revision: record.revision }]),
        ]);
        if (expected.size > 97) return null;
        const at = now();
        const value = {
          id: operationId,
          kind: 'save-issue',
          input,
          inputHash,
          status: 'confirmed',
          createdAt: at,
          confirmedAt: at,
          runnerId: this.runnerId,
          token: randomUUID(),
          claimAdmission: true,
          publicationStarted: true,
        };
        let issue;
        try {
          issue = await provider.commit({
            issueId,
            report: text,
            location: input.location,
            expectedRevision: request.expectedRevision,
            operationId: operationId + '/atomic',
            coordination: { expected: [...expected.values()], writes: [{ key, value }] },
          });
        } catch (error) {
          let saved;
          try {
            saved = await this.coordination.get(key);
          } catch {
            throw Object.assign(error, { operationId, pending: true });
          }
          if (saved) {
            this.coordination.matchOperation(saved, inputHash);
            if (saved.value.status === 'confirmed') return { status: 'confirmed', ...(await this.readIssue(issueId)) };
          }
          throw Object.assign(error, { operationId, pending: error.code !== 'STORE_CONFLICT' });
        }
        return { status: 'confirmed', ...current, ...issue, report: reportText(issue.report), issue };
      },
      async saveIssue({
        issueId,
        report,
        location,
        expectedRevision,
        operationId,
        flow,
        kind = 'edit',
        purpose,
        owner,
      }) {
        const atomic = await this.atomicIssueSave({
          issueId,
          report,
          location,
          expectedRevision,
          operationId,
          flow,
          kind,
          purpose,
          owner,
        });
        if (atomic) return atomic;
        const current = await this.readIssue(issueId);
        const text = reportText(report);
        validateReport(issueId, text);
        await this.assertGroupStore(text, current.storeId, current.artifactStoreId);
        kind = purpose === 'closure' ? 'close' : purpose === 'storage' ? 'storage' : kind;
        await this.preflightIssueClaim(operationId, issueId, owner);
        const op = await this.coordination.operation(
          operationId,
          'save-issue',
          {
            issueId,
            report: text,
            location: location || current.location,
            expectedRevision,
            flow,
            storeId: current.storeId,
            homeEpoch: current.homeEpoch,
            kind,
            owner: owner || null,
          },
          { claimAdmission: true }
        );
        if (op.value.status === 'confirmed') return { status: 'confirmed', ...(await this.readIssue(issueId)) };
        const closing = kind === 'close' && Boolean(current.flow?.closing);
        const storage = kind === 'storage' && text === current.report && !flow;
        assertStoreState(
          !merged(current.flow) || closing || storage,
          'STORE_MERGED',
          'This merged issue is read-only.'
        );
        const claimOwner = await this.admitIssuePublication(op, issueId, owner);
        try {
          await this.publishIssueChange(op, claimOwner);
          if (owner) await this.coordination.confirmOwned(op, owner);
          else await this.coordination.finalize(op, claimOwner);
          return { status: 'confirmed', ...(await this.readIssue(issueId)) };
        } catch (error) {
          await this.coordination.pending(op, error);
          throw Object.assign(error, { operationId, pending: true });
        }
      },
      async publishIssueChange(op, owner) {
        const input = op.value.input;
        const catalog = await this.catalog(input.issueId);
        assertStoreState(
          catalog.value.epoch === input.homeEpoch,
          'STORE_MOVED',
          'The issue moved before its update was confirmed.'
        );
        await this.issueStore(input.storeId).commit({
          issueId: input.issueId,
          report: input.report,
          location: input.location,
          expectedRevision: input.expectedRevision,
          operationId: op.value.id + '/issue',
        });
        if (input.flow)
          await this.saveFlow({
            issueId: input.issueId,
            flow: input.flow,
            expectedRevision: input.flow.revision,
            owner,
            operationId: op.value.id + '/flow',
            purpose: input.kind === 'close' ? 'closure' : 'edit',
          });
      },
      async atomicFlowSave({ issueId, flow, expectedRevision, operationId, owner, purpose }) {
        if (owner) return null;
        flow = cloneRecord(flow);
        const { key, claimKey } = flowSaveKeys(issueId, operationId);
        const state = await this.pinnedRead(async (view) => {
          const catalog = await view.catalog(issueId);
          const [record, operation, claim, gate] = await Promise.all([
            view.coordination.get(flowKey(issueId)),
            view.coordination.get(key),
            view.coordination.get(claimKey),
            view.coordination.get('project/migration'),
          ]);
          return { catalog, record, operation, claim, gate };
        });
        const { record, operation, claim, gate } = state;
        const input = { issueId, flow, expectedRevision, owner: null, purpose };
        const inputHash = inputDigest({ kind: 'save-flow', input });
        if (operation) return confirmedFlowSave(this.coordination, operation, record, inputHash);
        const unchanged = validateFlowSave(record, flow, expectedRevision, purpose);
        assertStoreState(!claim, 'STORE_CLAIMED', 'Another runner or attempt owns this issue.');
        this.coordination.requireGate(gate);
        const saved = flowSaveTransaction(
          { ...state, unchanged, key, claimKey, operationId },
          input,
          inputHash,
          this.runnerId
        );
        try {
          await this.records.commit(saved.transaction);
        } catch (error) {
          return reconcileFlowSave(this, { key, issueId, inputHash, operationId }, error);
        }
        return { flow: saved.flow };
      },
      async saveFlow({ issueId, flow, expectedRevision, operationId, owner, purpose = 'edit' }) {
        const atomic = await this.atomicFlowSave({ issueId, flow, expectedRevision, operationId, owner, purpose });
        if (atomic) return atomic.flow;
        await this.catalog(issueId);
        const record = await this.coordination.get(flowKey(issueId));
        const op = await this.coordination.operation(operationId, 'save-flow', {
          issueId,
          flow,
          expectedRevision,
          owner: owner || null,
          purpose,
        });
        if (op.value.status === 'confirmed') return (await this.readIssue(issueId)).flow;
        validateFlowSave(record, flow, expectedRevision, purpose);
        const claimOwner = owner || this.coordination.owner(op, issueId);
        if (!owner) await this.coordination.acquire(claimOwner, operationId + '/claim');
        const claim = await this.coordination.owned(claimOwner);
        if (sameFlow(record, flow)) {
          if (owner) await this.coordination.confirmOwned(op, owner);
          else await this.coordination.finalize(op, claimOwner);
          return record.value;
        }
        const next = updatedFlow(record, flow, now());
        if (!owner)
          await this.coordination.finalize(
            op,
            claimOwner,
            [{ key: flowKey(issueId), value: next }],
            [{ key: flowKey(issueId), revision: record?.revision ?? null }]
          );
        else await this.commitOwnedFlow(op, claim, record, next);
        return next;
      },
      async commitOwnedFlow(op, claim, record, flow) {
        const operation = await this.coordination.get(op.key);
        await this.coordination.commit(
          op.value.id + '/flow',
          [
            { key: flowKey(flow.issueId), revision: record?.revision ?? null },
            { key: claim.key, revision: claim.revision },
            { key: op.key, revision: operation.revision },
          ],
          [
            { key: flowKey(flow.issueId), value: flow },
            { key: op.key, value: { ...operation.value, status: 'confirmed', confirmedAt: now() } },
          ]
        );
      },
      async beginAttempt({
        issueId,
        blockId,
        attempt,
        expectedRevision,
        operationId,
        flow: preparedFlow,
        purpose = 'edit',
      }) {
        const state = await this.readIssue(issueId);
        const selected = (preparedFlow || state.flow)?.blocks.find((entry) => entry.id === blockId);
        const closing =
          ['close', 'retro', 'cleanup'].includes(selected?.kind) &&
          permitsClosure(state.flow, preparedFlow || state.flow, purpose);
        assertStoreState(!merged(state.flow) || closing, 'STORE_MERGED', 'This merged issue is read-only.');
        const op = await this.coordination.operation(operationId, 'begin-attempt', {
          issueId,
          blockId,
          attempt,
          expectedRevision,
          preparedFlow,
          purpose,
        });
        assertStoreState(
          !op.value.runnerId || op.value.runnerId === this.runnerId,
          'STORE_ALREADY_STARTED',
          'This execution operation belongs to another runner and cannot transfer its process.'
        );
        const owner = this.coordination.owner(op, issueId, attempt.id);
        if (op.value.status === 'confirmed') {
          assertStoreState(
            op.value.owner.runnerId === this.runnerId,
            'STORE_ALREADY_STARTED',
            'This attempt was already admitted on another runner.'
          );
          return { owner: op.value.owner, flow: (await this.readIssue(issueId)).flow, replayed: true };
        }
        const existingFlow = await this.coordination.get(flowKey(issueId));
        assertStoreState(
          Boolean(existingFlow || preparedFlow),
          'STORE_FLOW_MISSING',
          'Prepare the initial saved flow before admitting an attempt.'
        );
        const record = existingFlow || { key: flowKey(issueId), revision: null, value: { revision: 0 } };
        assertFlowVersion(record, expectedRevision);
        const claimKey = 'claims/' + issueId;
        assertStoreState(!(await this.coordination.get(claimKey)), 'STORE_CLAIMED', 'Another attempt owns this issue.');
        const flow = cloneRecord(preparedFlow || record.value);
        const block = flow.blocks.find((entry) => entry.id === blockId);
        assertStoreState(Boolean(block), 'STORE_BLOCK_MISSING', 'Choose a saved flow block.');
        assertStoreState(
          !flow.blocks.some((entry) => entry.attempts.some((saved) => saved.id === attempt.id)),
          'STORE_ATTEMPT_EXISTS',
          'This attempt identity already exists.'
        );
        block.attempts.push({ ...cloneRecord(attempt), status: 'running' });
        flow.revision = record.value.revision + 1;
        await this.commitAdmission({ operationId, record, claimKey, op, flow, owner });
        this.openJournal(owner);
        return { owner, flow };
      },
      async commitAdmission({ operationId, record, claimKey, op, flow, owner }) {
        const operation = await this.coordination.get(op.key);
        await this.coordination.commit(
          operationId + '/admit',
          [
            { key: record.key, revision: record.revision },
            { key: claimKey, revision: null },
            { key: op.key, revision: operation.revision },
          ],
          [
            { key: record.key, value: flow },
            { key: claimKey, value: owner },
            { key: op.key, value: { ...operation.value, status: 'confirmed', owner, confirmedAt: now() } },
          ]
        );
      },
      openJournal(owner) {
        if (this.journals.has(owner.token)) return this.journals.get(owner.token);
        const path = join(this.root, '.issues/store-runtime/progress', validIdentity(owner.token, 'claim') + '.jsonl');
        mkdirSync(dirname(path), { recursive: true });
        const journal = { owner, path, sequence: 0, offset: 0 };
        if (existsSync(path)) journal.sequence = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).length;
        this.journals.set(owner.token, journal);
        return journal;
      },
      recordProgress(owner, event) {
        const journal = this.journals.get(owner.token);
        assertStoreState(
          Boolean(journal) && sameOwner(journal.owner, owner),
          'STORE_NOT_OWNER',
          'This runner does not own the attempt journal.'
        );
        const value = { ...cloneRecord(event), sequence: ++journal.sequence, at: now() };
        appendFileSync(journal.path, JSON.stringify(value) + '\n', { mode: 0o600 });
        return value.sequence;
      },
      async flushProgress(owner) {
        if (this.progressFlushes.has(owner.token)) return this.progressFlushes.get(owner.token);
        const task = this.flushJournal(owner).finally(() => this.progressFlushes.delete(owner.token));
        this.progressFlushes.set(owner.token, task);
        return task;
      },
      async flushJournal(owner) {
        const claim = await this.coordination.owned(owner);
        const journal = this.openJournal(owner);
        if (!existsSync(journal.path)) return null;
        const body = readFileSync(journal.path);
        const key = `progress/${owner.issueId}/${owner.attemptId}`;
        const saved = await this.coordination.get(key);
        const offset = saved?.value.bytes || 0;
        if (body.length <= offset) return saved?.value ?? null;
        const chunk = body.subarray(offset);
        const artifact = await (
          await this.issueArtifacts(owner.issueId)
        ).put({ body: chunk, mediaType: 'application/x-ndjson' });
        const value = {
          owner,
          bytes: body.length,
          sequence: journal.sequence,
          chunks: [...(saved?.value.chunks || []), { from: offset, to: body.length, artifact }],
          updatedAt: now(),
        };
        await this.coordination.commit(
          `progress:${owner.token}:${offset}:${body.length}`,
          [
            { key, revision: saved?.revision ?? null },
            { key: claim.key, revision: claim.revision },
          ],
          [{ key, value }]
        );
        journal.offset = body.length;
        return value;
      },
      async finishAttempt(owner, { result, operationId }) {
        const op = await this.coordination.operation(operationId, 'finish-attempt', { owner, result });
        if (op.value.status === 'confirmed') return (await this.readIssue(owner.issueId)).flow;
        await this.flushProgress(owner);
        const record = await this.coordination.get(flowKey(owner.issueId));
        const flow = cloneRecord(record.value);
        const attempt = [...flow.blocks, ...(flow.retiredBlocks || [])]
          .flatMap((block) => block.attempts)
          .find((entry) => entry.id === owner.attemptId);
        assertStoreState(Boolean(attempt), 'STORE_ATTEMPT_MISSING', 'The owned attempt record is missing.');
        Object.assign(attempt, cloneRecord(result), { status: result.status || 'completed', endedAt: now() });
        flow.revision++;
        await this.coordination.finalize(
          op,
          owner,
          [{ key: record.key, value: flow }],
          [{ key: record.key, revision: record.revision }]
        );
        this.journals.delete(owner.token);
        return flow;
      },
      async requestStop({ issueId, attemptId, ownerToken, operationId }) {
        const claim = await this.coordination.get('claims/' + validIdentity(issueId));
        assertStoreState(
          claim?.value.attemptId === attemptId && claim.value.token === ownerToken,
          'STORE_NOT_OWNER',
          'The requested attempt is no longer owned by that runner.'
        );
        const op = await this.coordination.operation(operationId, 'request-stop', { issueId, attemptId, ownerToken });
        const key = `commands/${issueId}/${encodeURIComponent(operationId)}`;
        const previous = await this.coordination.get(key);
        if (previous) return previous.value;
        const value = {
          id: operationId,
          issueId,
          attemptId,
          ownerToken,
          runnerId: claim.value.runnerId,
          status: 'requested',
          requestedAt: op.value.createdAt,
        };
        await this.coordination.commit(
          operationId + '/request',
          [
            { key, revision: null },
            { key: claim.key, revision: claim.revision },
          ],
          [{ key, value }]
        );
        await this.coordination.updateOperation(op, { status: 'confirmed' }, 'recorded');
        return value;
      },
      async commands(owner) {
        await this.coordination.owned(owner);
        return (await this.coordination.list('commands/' + owner.issueId + '/'))
          .map((record) => record.value)
          .filter(
            (entry) =>
              entry.ownerToken === owner.token && entry.attemptId === owner.attemptId && entry.status === 'requested'
          );
      },
      async acknowledgeStop(owner, commandId) {
        const claim = await this.coordination.owned(owner);
        const key = `commands/${owner.issueId}/${encodeURIComponent(commandId)}`;
        const command = await this.coordination.get(key);
        assertStoreState(
          command?.value.ownerToken === owner.token && command.value.attemptId === owner.attemptId,
          'STORE_NOT_OWNER',
          'This Stop request belongs to another attempt.'
        );
        if (command.value.status === 'acknowledged') return command.value;
        const value = { ...command.value, status: 'acknowledged', acknowledgedAt: now() };
        await this.coordination.commit(
          commandId + '/acknowledge',
          [
            { key, revision: command.revision },
            { key: claim.key, revision: claim.revision },
          ],
          [{ key, value }]
        );
        return value;
      },
      async assertGroupStore(report, storeId, artifactStoreId) {
        const header = report.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
        const children = parse(header || '')?.issue_group?.children || [];
        const catalogs = [];
        for (const child of children.filter((entry) => !entry.detachedAt)) {
          const catalog = await this.catalog(child.id);
          assertStoreState(
            storagePair(catalog.value) === storagePair({ storeId, artifactStoreId }),
            'STORE_GROUP_MISMATCH',
            'A master and its sub-issues must use the same Issue and Artifact stores.'
          );
          catalogs.push(catalog);
        }
        return catalogs;
      },
      async assertSameStorage(issueIds) {
        const states = await Promise.all(issueIds.map((id) => this.catalog(id)));
        assertStoreState(
          new Set(states.map((record) => JSON.stringify([record.value.storeId, record.value.artifactStoreId]))).size <=
            1,
          'STORE_GROUP_MISMATCH',
          'A master and its sub-issues must use the same Issue and Artifact stores.'
        );
        return states.length
          ? { storeId: states[0].value.storeId, artifactStoreId: states[0].value.artifactStoreId }
          : undefined;
      },
      async archiveIssue({ issueId, operationId, expectedRevision }) {
        const current = await this.readIssue(issueId);
        assertStoreState(
          current.location === 'closed' || current.location === 'archive',
          'STORE_ARCHIVE_OPEN',
          'Close this issue before archiving it.'
        );
        const op = await this.coordination.operation(operationId, 'archive-issue', { issueId, expectedRevision });
        if (op.value.status === 'confirmed') return this.readIssue(issueId);
        const owner = this.coordination.owner(op, issueId);
        await this.coordination.acquire(owner, operationId + '/claim');
        await this.issueStore(current.storeId).commit({
          issueId,
          report: current.report,
          location: 'archive',
          expectedRevision,
          operationId: operationId + '/issue',
        });
        await this.coordination.finalize(op, owner);
        return this.readIssue(issueId);
      },
      async recoverAttempt({ issueId, attemptId, runnerId, ownerToken, operationId, reason, confirmed }) {
        assertStoreState(
          confirmed === true && typeof reason === 'string' && reason.trim().length > 0,
          'STORE_RECOVERY_CONFIRMATION',
          'Confirm that the original runner is stopped or reconciled and record the recovery reason.'
        );
        if (runnerId !== undefined) validIdentity(runnerId, 'runner');
        const op = await this.coordination.operation(operationId, 'recover-attempt', {
          issueId,
          attemptId,
          ownerToken,
          reason,
          ...(runnerId !== undefined && { runnerId }),
        });
        if (op.value.status === 'confirmed') return (await this.coordination.get(flowKey(issueId))).value;
        try {
          return await this.recoverOwnedAttempt(op);
        } catch (error) {
          return this.rejectAtomicRecovery(op, error);
        }
      },
      async recoverOwnedAttempt(op) {
        const { issueId, attemptId, ownerToken, runnerId, reason } = op.value.input;
        const claim = await this.coordination.get('claims/' + validIdentity(issueId));
        assertStoreState(
          claim?.value.attemptId === attemptId &&
            claim.value.token === ownerToken &&
            (runnerId === undefined || claim.value.runnerId === runnerId),
          'STORE_NOT_OWNER',
          'The original attempt claim changed. Refresh before recovery.'
        );
        const record = await this.coordination.get(flowKey(issueId));
        const flow = cloneRecord(record.value);
        if (!merged(flow)) {
          const attempt = [...flow.blocks, ...(flow.retiredBlocks || [])]
            .flatMap((block) => block.attempts)
            .find((entry) => entry.id === attemptId);
          assertStoreState(
            Boolean(attempt),
            'STORE_ATTEMPT_MISSING',
            'The claimed attempt record is missing. Reconcile its pending publication.'
          );
          Object.assign(attempt, { status: 'uncertain', reconciledAt: now(), reconciliation: reason });
          flow.revision++;
        }
        await this.coordination.finalize(
          op,
          claim.value,
          [{ key: record.key, value: flow }],
          [{ key: record.key, revision: record.revision }]
        );
        return flow;
      },
      async rejectAtomicRecovery(op, error) {
        let current;
        try {
          current = await this.coordination.get(op.key);
        } catch {
          throw Object.assign(error, { pending: true });
        }
        this.coordination.matchOperation(current, op.value.inputHash);
        if (current.value.status === 'confirmed')
          return (await this.coordination.get(flowKey(op.value.input.issueId))).value;
        if (!['STORE_NOT_OWNER', 'STORE_CONFLICT', 'STORE_ATTEMPT_MISSING'].includes(error.code))
          throw Object.assign(error, { pending: true });
        try {
          await this.coordination.updateOperation(
            current,
            { status: 'rejected', errorCode: error.code, error: error.message, rejectedAt: now() },
            'recovery-rejected'
          );
          Object.assign(error, { rejected: true, pending: false });
        } catch {
          Object.assign(error, { pending: true });
        }
        throw error;
      },
      deleteIssue(input) {
        return deleteIssue(this, input);
      },
      resumeDelete(input) {
        return resumeDelete(this, input);
      },
      async claimForOperation(op, issueId, owner) {
        const claimOwner = owner || this.coordination.owner(op, issueId);
        if (owner) await this.coordination.owned(owner);
        else await this.coordination.acquire(claimOwner, op.value.id + '/claim');
        return claimOwner;
      },
      async preflightIssueClaim(operationId, issueId, owner) {
        if (await this.coordination.get('operations/' + encodeURIComponent(operationId))) return;
        const claim = await this.coordination.get('claims/' + validIdentity(issueId));
        if (owner) {
          assertStoreState(
            sameOwner(claim?.value, owner),
            'STORE_NOT_OWNER',
            'The exact issue claim is no longer owned by this attempt.'
          );
          return;
        }
        assertStoreState(!claim, 'STORE_CLAIMED', 'Another runner or attempt owns this issue.');
      },
      async admitIssuePublication(op, issueId, owner) {
        let claimOwner;
        try {
          claimOwner = await this.claimForOperation(op, issueId, owner);
        } catch (error) {
          if (['STORE_CLAIMED', 'STORE_NOT_OWNER', 'STORE_CONFLICT'].includes(error.code))
            await this.rejectIssueAdmission(op, owner, error);
          throw error;
        }
        const current = await this.coordination.get(op.key);
        this.coordination.matchOperation(current, op.value.inputHash);
        if (current.value.claimAdmission && !current.value.publicationStarted) {
          const claim = await this.coordination.owned(claimOwner);
          await this.coordination.commit(
            op.value.id + '/publication-admitted',
            [
              { key: current.key, revision: current.revision },
              { key: claim.key, revision: claim.revision },
            ],
            [{ key: current.key, value: { ...current.value, publicationStarted: true } }]
          );
        }
        return claimOwner;
      },
      async rejectIssueAdmission(op, owner, error) {
        const current = await this.coordination.get(op.key);
        if (!current.value.claimAdmission || current.value.publicationStarted || current.value.status !== 'pending')
          return;
        const key = 'claims/' + current.value.input.issueId;
        const claim = await this.coordination.get(key);
        if (claim?.value.token === op.value.token || sameOwner(claim?.value, owner)) return;
        const code = error.code === 'STORE_CONFLICT' ? 'STORE_CLAIMED' : error.code;
        try {
          await this.coordination.commit(
            op.value.id + '/admission-rejected',
            [
              { key: current.key, revision: current.revision },
              { key, revision: claim?.revision ?? null },
            ],
            [
              {
                key: current.key,
                value: {
                  ...current.value,
                  status: 'rejected',
                  rejectedAt: now(),
                  errorCode: code,
                  error: 'The report edit was rejected before publication because its exact claim was unavailable.',
                },
              },
            ]
          );
          Object.assign(error, { code, rejected: true, pending: false });
        } catch {
          // Retain the pending operation when rejection could not be confirmed.
        }
      },
      async history(issueId) {
        const issue = await this.readIssue(issueId);
        const retained = await this.coordination.list('issue-history/' + issueId + '/');
        const prior = retained.flatMap((record) =>
          record.value.entries.map((entry) => ({
            ...entry,
            storeId: record.value.sourceStoreId,
            report: Buffer.from(entry.report, 'base64'),
          }))
        );
        const current = (await this.issueStore(issue.storeId).history(issueId)).map((entry) => ({
          ...entry,
          storeId: issue.storeId,
        }));
        const unique = new Map([...prior, ...current].map((entry) => [entry.storeId + '/' + entry.revision, entry]));
        return [...unique.values()];
      },
      async bootstrap({ issues, operationId }) {
        assertStoreState(
          (await this.coordination.list('claims/')).length === 0,
          'STORE_BUSY',
          'Reconcile active claims before importing existing issues.'
        );
        assertStoreState(
          !issues.some((issue) =>
            issue.flow?.blocks?.some((block) => block.attempts?.some((attempt) => attempt.status === 'running'))
          ),
          'STORE_BUSY',
          'Reconcile existing active attempts before importing shared history.'
        );
        const imported = [];
        for (const issue of issues)
          imported.push(await this.importIssue({ ...issue, operationId: operationId + '/' + issue.id }));
        return imported;
      },
      moveIssue(input) {
        return moveIssue(this, input);
      },
      moveProjectStore(input) {
        return moveProjectStore(this, input);
      },
      async release(owner, operationId) {
        return this.coordination.release(owner, operationId);
      },
    })
  );
}

function protectedFlow(flow) {
  const { revision, updatedAt, closing, autoClose, ...saved } = flow;
  const closureKinds = new Set(['close', 'retro', 'cleanup']);
  return { ...saved, blocks: saved.blocks.filter((block) => !closureKinds.has(block.kind)) };
}

function permitsClosure(before, after, purpose) {
  return (
    Boolean(before) &&
    purpose === 'closure' &&
    Boolean(after.closing) &&
    inputDigest(protectedFlow(before)) === inputDigest(protectedFlow(after))
  );
}
