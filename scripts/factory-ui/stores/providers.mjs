import { assertStore, hash, recordStore, revisionFor } from './providers/records.mjs';
import { openFilesRecords } from './providers/files.mjs';
import { openGitRecords } from './providers/git.mjs';
import { openPostgresRecords } from './providers/postgres.mjs';
import { openDynamoRecords } from './providers/dynamodb.mjs';

export async function openRecordStore(config, options = {}) {
  assertStore(
    config && typeof config.id === 'string' && config.id.length > 0,
    'A configured store identity is required.'
  );
  assertStore(
    typeof options.root === 'string' && typeof options.projectId === 'string' && options.projectId.length > 0,
    'A project root and identity are required.'
  );
  const factories = {
    files: openFilesRecords,
    git: openGitRecords,
    postgres: openPostgresRecords,
    dynamodb: openDynamoRecords,
  };
  assertStore(Object.hasOwn(factories, config.kind), 'Unsupported record store kind.');
  assertStore(
    !options.inlinePayloads || config.kind !== 'dynamodb',
    'DynamoDB records require bounded artifact references.'
  );
  return recordStore(
    await factories[config.kind](config, options),
    options.inlinePayloads ? undefined : options.artifacts,
    { allowInlineLarge: options.inlinePayloads === true, storeId: config.id }
  );
}

export async function openIssueStore(config, options = {}) {
  return issueProvider(await openRecordStore(config, options));
}

function issueProvider(records) {
  const prefix = (issueId) => {
    assertStore(typeof issueId === 'string' && /^[a-zA-Z0-9_-]{1,150}$/.test(issueId), 'Invalid issue identity.');
    return `issues/${issueId}/`;
  };
  function issue(record) {
    if (!record) return null;
    return {
      id: record.value.id,
      revision: record.revision,
      report: Buffer.from(record.value.report, 'base64'),
      location: record.value.location,
    };
  }
  return {
    id: records.id,
    supportsCoordinatedCommit: true,
    ...(records.readSnapshot && {
      readSnapshot: (read) =>
        records.readSnapshot((pinned) => {
          const view = issueProvider(pinned);
          return read({ read: view.read, list: view.list, history: view.history });
        }),
    }),
    async read(issueId) {
      return issue(await records.get(prefix(issueId) + 'head'));
    },
    async list({ location } = {}) {
      return (await records.list('issues/'))
        .filter((item) => item.key.endsWith('/head') && (!location || item.value.location === location))
        .map(issue);
    },
    async commit({ issueId, expectedRevision, operationId, report, location, coordination }) {
      assertStore(
        typeof operationId === 'string' && operationId.length > 0,
        'An issue write requires its operation identity.'
      );
      assertStore(['open', 'closed', 'archive'].includes(location), 'Invalid issue location.');
      assertStore(
        typeof report === 'string' || Buffer.isBuffer(report) || report instanceof Uint8Array,
        'An issue report must contain exact text or bytes.'
      );
      if (coordination) {
        assertStore(
          Array.isArray(coordination.expected) &&
            Array.isArray(coordination.writes) &&
            [...coordination.expected, ...coordination.writes].every(
              (entry) => typeof entry.key === 'string' && !entry.key.startsWith('issues/')
            ),
          'Coordinated publication cannot replace Issue records.'
        );
      }
      const head = prefix(issueId) + 'head';
      const history = prefix(issueId) + 'history/' + hash(operationId);
      const value = { id: issueId, report: Buffer.from(report).toString('base64'), location };
      const result = await records.commit({
        operationId,
        expected: [
          { key: head, revision: expectedRevision },
          { key: history, revision: null },
          ...(coordination?.expected || []),
        ],
        writes: [
          { key: head, value },
          {
            key: history,
            value: { ...value, previousRevision: expectedRevision, headRevision: revisionFor(operationId, head) },
          },
          ...(coordination?.writes || []),
        ],
      });
      return issue(result.records.find((item) => item.key === head));
    },
    async history(issueId) {
      const entries = await records.list(prefix(issueId) + 'history/');
      const byPrevious = new Map(entries.map((item) => [item.value.previousRevision, item]));
      const result = [];
      let cursor = null;
      while (byPrevious.has(cursor)) {
        const entry = byPrevious.get(cursor);
        byPrevious.delete(cursor);
        result.push(issue({ ...entry, revision: entry.value.headRevision }));
        cursor = entry.value.headRevision;
      }
      assertStore(byPrevious.size === 0, 'Issue history has a missing or conflicting predecessor.');
      return result;
    },
    removeRecords: (input) => records.removeRecords(input),
    retainedPayloads: (options) => records.retainedPayloads(options),
    retireReceipts: (input) => records.retireReceipts(input),
    close: () => records.close(),
  };
}
