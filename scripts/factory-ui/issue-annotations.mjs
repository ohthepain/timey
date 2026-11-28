import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { requireThat } from './common.mjs';
import { storedIssuePath } from './issue-report-storage.mjs';
import { readStoreConfig, requireStore } from './stores/config.mjs';
import { createCoordination, inputDigest } from './stores/coordination.mjs';
import { annotationPrefix, incomingKey, incomingReferences, retainingTypes } from './issue-annotation-references.mjs';
import { openRecordStore } from './stores/providers.mjs';
import { ensureProjectStores } from './stores/runtime.mjs';

const identity = z.string().regex(/^[\w-]{1,150}$/);
const actorSchema = z
  .object({
    kind: z.enum(['user', 'chat', 'issue']),
    id: z.string().min(1).max(200),
  })
  .strict();
const message = z
  .string()
  .refine((value) => value.trim().length > 0, 'Enter annotation text.')
  .max(8000);
const label = z.enum(['blocked', 'not-ready']);
export const annotationToolSchema = z
  .object({
    action: z.enum(['add', 'clear']),
    issueId: identity,
    type: z.enum(['label', 'comment', ...retainingTypes]).optional(),
    label: label.optional(),
    note: message.optional(),
    text: message.optional(),
    relatedIssueId: identity.optional(),
    targetIssueId: identity.optional(),
    annotationId: identity.optional(),
  })
  .strict();
const add = {
  action: z.literal('add'),
  issueId: identity,
  annotationId: identity.optional(),
};
const annotationInput = z.union([
  z
    .object({ ...add, type: z.literal('label'), label, note: message.optional(), relatedIssueId: identity.optional() })
    .strict(),
  z.object({ ...add, type: z.literal('comment'), text: message, relatedIssueId: identity.optional() }).strict(),
  z
    .object({
      ...add,
      type: z.enum(retainingTypes),
      annotationId: identity,
      targetIssueId: identity,
      note: message.optional(),
    })
    .strict(),
  z.object({ action: z.literal('clear'), issueId: identity, annotationId: identity }).strict(),
]);
export const annotationTool = {
  name: 'issue_annotation',
  description:
    'Add a label by passing action add, type label and the label, with an optional note. Add a comment by passing action add, type comment and text. Either can mention a relatedIssueId. To retain an issue, add type reference with targetIssueId, a stable annotationId and an optional note. Reuse annotationId when retrying an add. To clear, pass action clear and annotationId. This changes only annotations.',
  inputSchema: z.toJSONSchema(annotationToolSchema, { target: 'draft-7' }),
};

const instances = new WeakMap();
const ordered = (records) => records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
const selectedRecords = (reader, id) => reader.list(annotationPrefix(id), ({ value }) => value);

function sameAdd(saved, value) {
  const { createdAt, cleared, ...original } = saved;
  const { createdAt: addedAt, ...requested } = value;
  requireThat(inputDigest(original) === inputDigest(requested), 'This annotation ID already names different input.');
  return saved;
}

class IssueAnnotations {
  constructor(service) {
    this.service = service;
    this.display = new Map();
  }

  async coordination() {
    if (this.service.projectStores) return this.service.projectStores.coordination;
    const config = readStoreConfig(this.service.root);
    const store = requireStore(config, config.coordination, 'coordination');
    if (store.kind === 'files' || (store.kind === 'git' && this.service.sharedIssues))
      return this.standaloneCoordination(store, config.projectId);
    return this.sharedCoordination();
  }

  standaloneCoordination(store, projectId) {
    this.standalone ||= openRecordStore(store, {
      root: this.service.root,
      projectId,
      inlinePayloads: true,
    }).then(createCoordination);
    return this.standalone;
  }

  async sharedCoordination() {
    return (await ensureProjectStores(this.service, { display: true }))?.coordination;
  }

  async list(issueId) {
    const coordination = await this.coordination();
    requireThat(coordination, 'Connect the project Coordination store to read issue annotations.');
    return ordered(await selectedRecords(coordination, identity.parse(issueId)));
  }

  async view(issueIds) {
    const ids = [...new Set(issueIds)];
    try {
      if (!ids.length) return { records: [], incoming: new Map() };
      const coordination = await this.coordination();
      const store = coordination.records;
      const read = async (reader) => {
        const entries = [];
        for (let i = 0; i < ids.length; i += 16) {
          entries.push(
            ...(await Promise.all(
              ids.slice(i, i + 16).map(async (id) => {
                const [records, incoming] = await Promise.all([
                  selectedRecords(reader, id),
                  incomingReferences(reader, id),
                ]);
                return { records, incoming };
              })
            ))
          );
        }
        return entries;
      };
      const entries = store.readSnapshot ? await store.readSnapshot(read) : await read(store);
      ids.forEach((id, index) => this.display.set(id, entries[index].records));
      return {
        records: ordered(entries.flatMap(({ records }) => records)),
        incoming: new Map(ids.map((id, index) => [id, entries[index].incoming])),
      };
    } catch {
      return {
        records: ordered(ids.flatMap((id) => this.display.get(id) ?? [])),
        incoming: new Map(),
        warning: 'Issue annotations could not be refreshed. Showing the last available history.',
      };
    }
  }

  async issueCondition(issueId, project = this.service.projectStores) {
    if (project) {
      const catalog = await project.catalog(issueId);
      return [{ key: catalog.key, revision: catalog.revision }];
    }
    requireThat(
      ['open', 'closed', 'archive'].some((location) =>
        existsSync(storedIssuePath(this.service.root, issueId, location))
      ),
      'Choose a saved issue.'
    );
    return [];
  }

  async mutationStore(target) {
    const project = this.service.projectStores ?? (target && (await ensureProjectStores(this.service)));
    const coordination = project ? project.coordination : await this.coordination();
    requireThat(coordination, 'Connect the project Coordination store to write issue annotations.');
    return { project, coordination };
  }

  async mutate(input, authenticatedActor, signal) {
    requireThat(this.service.reviewMode !== 'preview', 'Project preview cannot change issue annotations.');
    const { action, issueId, annotationId, ...content } = annotationInput.parse(input);
    const actor = actorSchema.parse(authenticatedActor);
    const target = content.targetIssueId;
    requireThat(target !== issueId, 'Choose another issue as the reference target.');
    const { project, coordination } = await this.mutationStore(target);
    const expected = await this.issueCondition(issueId, project);
    const id = annotationId ?? randomUUID();
    const key = annotationPrefix(issueId) + id;
    signal?.throwIfAborted();
    const value =
      action === 'add'
        ? await this.add(
            coordination,
            project,
            expected,
            key,
            {
              id,
              issueId,
              author: actor,
              createdAt: coordination.now(),
              ...content,
            },
            signal
          )
        : await this.clear(coordination, expected, key, actor, signal);
    this.service.flowChanges?.notify();
    return value;
  }

  async addReference(project, value, expected, writes) {
    const key = incomingKey(value);
    if (!key) return;
    expected.push(...(await this.issueCondition(value.targetIssueId, project)), { key, revision: null });
    const { id, issueId, type, note } = value;
    writes.push({ key, value: { id, issueId, type, ...(note && { note }) } });
  }

  async checkDuplicateReference(coordination, value, error) {
    const key = incomingKey(value);
    if (key && error.code === 'STORE_CONFLICT')
      requireThat(!(await coordination.get(key)), 'An active annotation of this type already references that issue.');
  }

  async add(coordination, project, expected, key, value, signal) {
    const previous = await coordination.get(key);
    if (previous) return sameAdd(previous.value, value);
    const writes = [{ key, value }];
    expected.push({ key, revision: null });
    await this.addReference(project, value, expected, writes);
    signal?.throwIfAborted();
    try {
      await coordination.commit('annotation-add/' + randomUUID(), expected, writes);
      return value;
    } catch (error) {
      const confirmed = await coordination.get(key);
      if (confirmed) return sameAdd(confirmed.value, value);
      await this.checkDuplicateReference(coordination, value, error);
      throw error;
    }
  }

  async clearReference(coordination, value, expected, writes) {
    const key = incomingKey(value);
    if (!key) return;
    const index = await coordination.get(key);
    if (index?.value.id === value.id) {
      expected.push({ key, revision: index.revision });
      writes.push({ key, value: null });
    }
  }

  async clear(coordination, expected, key, actor, signal) {
    const saved = await coordination.get(key);
    requireThat(saved, 'Choose an annotation on this issue.');
    if (saved.value.cleared) return saved.value;
    const value = { ...saved.value, cleared: { at: coordination.now(), by: actor } };
    const writes = [{ key, value }];
    expected.push({ key, revision: saved.revision });
    await this.clearReference(coordination, value, expected, writes);
    signal?.throwIfAborted();
    try {
      await coordination.commit('annotation-clear/' + randomUUID(), expected, writes);
      return value;
    } catch (error) {
      const confirmed = await coordination.get(key);
      if (confirmed?.value.cleared) return confirmed.value;
      throw error;
    }
  }
}

export function issueAnnotations(service) {
  if (!instances.has(service)) instances.set(service, new IssueAnnotations(service));
  return instances.get(service);
}

export function annotationTools(service, actor, signal) {
  return {
    definitions: [{ type: 'function', ...annotationTool }],
    invoke(name, input) {
      requireThat(name === annotationTool.name, 'Choose a registered annotation tool.');
      signal?.throwIfAborted();
      return issueAnnotations(service).mutate(input, actor, signal);
    },
  };
}
