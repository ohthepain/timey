import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireThat } from './common.mjs';
import { readQueue } from './data.mjs';
import { listIssueStorage, moveIssueStorage } from './issue-storage-actions.mjs';
import { issueTypes } from './flow-definitions.mjs';
import { LocalNotes, localNoteActionSchema } from './local-notes.mjs';

const text = z.string().max(16000);
const id = z
  .string()
  .regex(/^[\w-]+$/)
  .max(200);
const homeActions = {
  project_investigation: {
    description:
      'Create, configure, discuss, run, retry or stop a project investigation when requested. Creation leaves an idle issue; running is separate. Query project_home for branches, folders and saved investigations. Do not subscribe to investigation progress.',
    schema: z
      .object({
        action: z.enum([
          'investigation-create',
          'investigation-save',
          'investigation-discuss',
          'investigation-run',
          'investigation-retry',
          'investigation-stop',
        ]),
        id: id.optional(),
        issueId: id.optional(),
        requestId: id.optional(),
        focus: text.optional(),
        branch: text.optional(),
        folder: text.optional(),
        issueFolder: text.optional(),
        prompt: text.optional(),
        instructions: text.optional(),
        message: text.optional(),
        reusable: z.boolean().optional(),
        revision: z.number().int().nonnegative().optional(),
      })
      .strict(),
  },
  project_automate_me: {
    description:
      'Run the project Automate me workflow, reply, retry, stop, preview a skill draft or apply the exact reviewed draft. Use only when requested. Apply requires explicit user review of the current draft and destination; preview never authorizes Apply or activation. No background session subscription.',
    schema: z
      .object({
        action: z.enum([
          'automate-start',
          'automate-message',
          'automate-retry',
          'automate-stop',
          'automate-preview',
          'automate-apply',
        ]),
        id: id.optional(),
        requestId: id.optional(),
        message: text.optional(),
        durationValue: z.number().positive().max(10000).optional(),
        durationUnit: z.enum(['days', 'weeks', 'months']).optional(),
        destination: z.enum(['project', 'personal']).optional(),
        name: text.optional(),
        content: z.string().max(100000).optional(),
        basis: text.optional(),
        activate: z.boolean().optional(),
      })
      .strict(),
  },
};

export function createProjectDiscussTools(service, options = {}) {
  const home = () => options.home?.() || service.projectHome;
  const flows = () => options.flows?.() || service.flows;
  const registry = {
    local_notes: {
      description: 'Read this project’s private local notes and current edit basis. Reading starts no work.',
      schema: z.object({}).strict(),
      run: () => new LocalNotes(service.root).view(),
    },
    local_note: {
      description:
        'Capture a quick local note verbatim, or edit, complete, delete or move a requested note. Read local_notes before changes and pass its basis. Notes stay local; this creates no issue and starts no work.',
      schema: localNoteActionSchema,
      path: '/api/local-notes-action',
      pauseSafe: true,
      run: (input) => new LocalNotes(service.root).action(input),
    },
    project_home: {
      description:
        'Read current project Home configuration and saved investigations/Automate me sessions when needed for a user request. Reading starts no work. Returns current facts, not a subscription.',
      schema: z.object({}).strict(),
      run: () => home().view(),
    },
    issues_list: {
      description:
        'Query open, closed or archived issue metadata, or one issue control snapshot, when asked or required by a requested command. No issue transcripts or ongoing progress are imported.',
      schema: z
        .object({ location: z.enum(['open', 'closed', 'archive']).default('open'), issueId: id.optional() })
        .strict(),
      run: ({ location, issueId }) => {
        if (location !== 'open') {
          const result = listIssueStorage(service, location);
          return issueId ? { issues: result.issues.filter((issue) => issue.id === issueId) } : result;
        }
        const issues = readQueue(service.root, issueId ? { issueId } : {}).issues;
        return {
          issues: issues.map((issue) => {
            const record = {
              id: issue.id,
              title: issue.title,
              issueNumber: issue.issueNumber,
              state: issue.state,
              url: '/?issue=' + encodeURIComponent(issue.id),
            };
            if (issueId) {
              const flow = flows().read(issue);
              record.revision = flow.revision;
              const request = flow.blocks.find((block) => block.kind === 'request');
              record.originalPrompt = request?.data.wording || '';
              record.issueType = request?.data.fields?.type || flow.routeType;
              record.blocks = flow.blocks.map((block) => ({
                id: block.id,
                kind: block.kind,
                label: block.label,
                status: block.attempts.at(-1)?.status || 'ready',
              }));
            }
            return record;
          }),
        };
      },
    },
    issue_create: {
      description:
        'Create an idle issue from a user-requested description. Creation does not start work. Use a stable requestId when retrying this same creation.',
      schema: z
        .object({
          description: text.min(1),
          requestId: id.optional(),
          folder: text.optional(),
          type: text.optional(),
          needsApproval: z.boolean().optional(),
        })
        .strict(),
      path: '/api/flow-action',
      run: async (input) =>
        receipt(await flows().capture({ ...input, requestId: input.requestId || randomUUID() }), 'created'),
    },
    issue_edit: {
      description:
        'Edit only an open issue’s original prompt and/or issue type. Query issues_list for the issue ID and current revision first. Changing the original prompt reruns Request clarification; changing type applies that type’s default flow. This never starts issue work.',
      schema: z
        .object({
          action: z.literal('edit-request'),
          issueId: id,
          revision: z.number().int().nonnegative(),
          originalPrompt: text.min(1).max(24000).optional(),
          issueType: z.enum(issueTypes).optional(),
        })
        .strict()
        .refine((input) => input.originalPrompt !== undefined || input.issueType !== undefined, {
          message: 'Provide an original prompt or issue type to edit.',
        }),
      path: '/api/flow-action',
      run: async ({ action, issueId, revision, originalPrompt, issueType }) =>
        receipt(
          await flows().action({
            action,
            issueId,
            revision,
            ...(originalPrompt !== undefined ? { wording: originalPrompt } : {}),
            ...(issueType !== undefined ? { type: issueType } : {}),
          }),
          action
        ),
    },
    issue_control: {
      description:
        'Invoke an existing issue control when explicitly requested. To start an issue’s planned route, query issues_list for its revision and use action play; Play starts the Request block and continues the saved route through its existing guards. Use action start only for a specifically selected runnable non-Request block, with its blockId from issues_list. Never start the Request block directly. Existing approval, verification and ownership guards apply. Returns a command receipt; use the issue page for later progress. Never duplicate issue execution in this chat.',
      schema: z
        .object({
          action: z.enum(['play', 'pause', 'start', 'continue', 'stop', 'rename-issue', 'approve-issue']),
          issueId: id,
          revision: z.number().int().nonnegative(),
          blockId: id.optional(),
          title: text.optional(),
          previousTitle: text.optional(),
        })
        .strict(),
      path: '/api/flow-action',
      run: async (input) => receipt(await flows().action(input), input.action),
    },
    issue_archive: {
      description:
        'Archive a requested list of issue numbers together, or archive/restore selected issue IDs, through existing storage controls. Pass the full requested issueNumbers array in one call; number resolution reads the registry once, without per-issue queries. For all closed issues, query issues_list once and pass its IDs. No issue is closed or accepted by this operation.',
      schema: z
        .object({
          action: z.enum(['archive', 'restore']),
          issueIds: z.array(id).min(1).max(500).optional(),
          issueNumbers: z.array(z.number().int().positive().safe()).min(1).max(500).optional(),
        })
        .strict()
        .refine(
          (input) => (input.issueIds === undefined) !== (input.issueNumbers === undefined),
          'Choose issue numbers or IDs.'
        ),
      path: '/api/issue-storage-move',
      run: (input) => moveIssueStorage(service, input),
    },
  };
  for (const [name, descriptor] of Object.entries(homeActions))
    registry[name] = {
      ...descriptor,
      path: '/api/project-home-action',
      run: async (input) => {
        const result = await home().action({ ...input, requestId: input.requestId || randomUUID() });
        if (input.action.startsWith('investigation-')) return receipt(result, input.action);
        return result;
      },
    };

  return {
    definitions: Object.entries(registry).map(([name, descriptor]) => ({
      type: 'function',
      name,
      description: descriptor.description,
      inputSchema: z.toJSONSchema(descriptor.schema, { target: 'draft-7' }),
    })),
    async invoke(name, input) {
      requireThat(Object.hasOwn(registry, name), 'Choose a registered project tool.');
      const descriptor = registry[name];
      const parsed = descriptor.schema.parse(input);
      if (descriptor.path) {
        requireThat(
          !options.readOnly && service.reviewMode !== 'preview',
          'Project preview cannot change the project.'
        );
        service.ownServer();
        if (!descriptor.pauseSafe && !['stop', 'pause', 'investigation-stop', 'automate-stop'].includes(parsed.action))
          service.serverControl?.allow(descriptor.path, parsed);
      }
      return descriptor.run(parsed);
    },
  };
}

function receipt(result, action) {
  const issueId = result?.issueId || result?.issue?.id || result?.session?.issueId;
  return {
    action,
    status: result?.error ? 'failed' : 'accepted',
    ...(issueId ? { issueId, url: '/?issue=' + encodeURIComponent(issueId) } : {}),
    ...(result?.session?.id ? { sessionId: result.session.id } : {}),
    ...(result?.error ? { error: result.error } : {}),
  };
}
