import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { requireThat } from './common.mjs';
import { storedIssuePath } from './issue-report-storage.mjs';
import { readStoreConfig, requireStore } from './stores/config.mjs';
import { createCoordination } from './stores/coordination.mjs';
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
    type: z.enum(['label', 'comment']).optional(),
    label: label.optional(),
    note: message.optional(),
    text: message.optional(),
    relatedIssueId: identity.optional(),
    annotationId: identity.optional(),
  })
  .strict();
const add = {
  action: z.literal('add'),
  issueId: identity,
  relatedIssueId: identity.optional(),
};
const annotationInput = z.union([
  z.object({ ...add, type: z.literal('label'), label, note: message.optional() }).strict(),
  z.object({ ...add, type: z.literal('comment'), text: message }).strict(),
  z.object({ action: z.literal('clear'), issueId: identity, annotationId: identity }).strict(),
]);
export const annotationTool = {
  name: 'issue_annotation',
  description:
    'Add a label by passing action add, type label and the label, with an optional note. Add a comment by passing action add, type comment and text. Either can pass relatedIssueId. To clear, pass action clear and annotationId. This changes only annotations.',
  inputSchema: z.toJSONSchema(annotationToolSchema, { target: 'draft-7' }),
};

const instances = new WeakMap();
const prefix = 'issue-annotations/';
const issuePrefix = (id) => prefix + identity.parse(id) + '/';

class IssueAnnotations {
  constructor(service) {
    this.service = service;
    this.display = [];
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
    return (await coordination.list(issueId ? issuePrefix(issueId) : prefix))
      .map(({ value }) => value)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async view() {
    try {
      this.display = await this.list();
      return { records: this.display };
    } catch {
      return {
        records: this.display,
        warning: 'Issue annotations could not be refreshed. Showing the last available history.',
      };
    }
  }

  async issueCondition(issueId) {
    if (this.service.projectStores) {
      const catalog = await this.service.projectStores.catalog(issueId);
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

  async mutate(input, authenticatedActor, signal) {
    requireThat(this.service.reviewMode !== 'preview', 'Project preview cannot change issue annotations.');
    const { action, issueId, annotationId, ...content } = annotationInput.parse(input);
    const actor = actorSchema.parse(authenticatedActor);
    const coordination = await this.coordination();
    requireThat(coordination, 'Connect the project Coordination store to write issue annotations.');
    const expected = await this.issueCondition(issueId);
    signal?.throwIfAborted();
    const id = annotationId ?? randomUUID();
    const key = issuePrefix(issueId) + id;
    const value =
      action === 'add'
        ? await this.add(coordination, expected, key, {
            id,
            issueId,
            author: actor,
            createdAt: coordination.now(),
            ...content,
          })
        : await this.clear(coordination, expected, key, actor, signal);
    this.service.flowChanges?.notify();
    return value;
  }

  async add(coordination, expected, key, value) {
    await coordination.commit('annotation-add/' + value.id, [...expected, { key, revision: null }], [{ key, value }]);
    return value;
  }

  async clear(coordination, expected, key, actor, signal) {
    const saved = await coordination.get(key);
    requireThat(saved, 'Choose an annotation on this issue.');
    if (saved.value.cleared) return saved.value;
    const value = { ...saved.value, cleared: { at: coordination.now(), by: actor } };
    signal?.throwIfAborted();
    try {
      await coordination.commit(
        'annotation-clear/' + randomUUID(),
        [...expected, { key, revision: saved.revision }],
        [{ key, value }]
      );
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
