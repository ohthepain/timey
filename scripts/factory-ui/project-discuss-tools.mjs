import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireThat } from './common.mjs';
import { readQueue } from './data.mjs';
import { listIssueStorage, moveIssueStorage } from './issue-storage-actions.mjs';
import { issueTypes } from './flow-definitions.mjs';
import { requestData } from './flow-block-data.mjs';
import { LocalNotes, localNoteActionSchema } from './local-notes.mjs';
import { inheritedIssueCaptureProfile } from './stores/settings.mjs';
import { annotationToolSchema, annotationTool, annotationTools, issueAnnotations } from './issue-annotations.mjs';

const text = z.string().max(16000);
const id = z
  .string()
  .regex(/^[\w-]+$/)
  .max(200);
function capturedIssue(input, options) {
  const report = options.reportContext?.();
  const requestId = input.requestId || randomUUID();
  if (!report) return { ...input, requestId };
  return {
    ...input,
    requestId,
    needsApproval: true,
    sourceIssue: report.source.issueId,
    sourceAttempt: report.source.attemptId,
    description:
      input.description + '\n\n## Source report\n' + report.reportId + '\nOutput attempt: ' + report.outputAttemptId,
  };
}
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
    ...(options.annotationActor && {
      issue_annotation: {
        description: annotationTool.description,
        schema: annotationToolSchema,
        path: '/api/issue-annotation',
        pauseSafe: true,
        run: (input) => annotationTools(service, options.annotationActor()).invoke(annotationTool.name, input),
      },
    }),
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
      run: ({ location, issueId }) =>
        location === 'open' ? openIssueList(service, issueId, flows) : storedIssueList(service, location, issueId),
    },
    issue_create: {
      description:
        'Create an idle issue from a user-requested description. Describe the outcome, proof and constraints, including any specific decision or operation the person reserved. Starting Work authorizes in-scope implementation; leave generic design or implementation sign-off out of the description. Set needsApproval only when the person asks to make approval a prerequisite for starting this issue. Use the named folder when specified. Storage defaults to the destination folder’s inherited profile. Pass a profile ID only for a requested override. Creation does not start work. Reuse the same UUID requestId when retrying.',
      schema: z
        .object({
          description: text.min(1),
          requestId: id.optional(),
          folder: text.optional(),
          storageProfile: z.string().min(1).max(100).optional(),
          type: text.optional(),
          needsApproval: z.boolean().optional(),
        })
        .strict(),
      path: '/api/flow-action',
      run: async (input) => {
        const prepared = options.prepareIssueCreation?.(input) ?? input;
        const capture = capturedIssue(prepared, options);
        capture.storageProfile = prepared.storageProfile ?? inheritedIssueCaptureProfile(service);
        return issueCreationReceipt(await flows().capture(capture), options.issueCreated);
      },
    },
    issue_move_folder: {
      description:
        'Move an open, idle issue to a named issue folder when requested. Read issues_list for the current folders and query the issue for its revision. Moving folders keeps the issue’s saved storage destinations and starts no work.',
      schema: z.object({ issueId: id, revision: z.number().int().nonnegative(), folder: text.min(1) }).strict(),
      path: '/api/flow-action',
      run: async (input) => receipt(await flows().action({ ...input, action: 'folder' }), 'folder'),
    },
    issue_group_preview: {
      description:
        'Prepare the combined request for a master issue from exact issue IDs in one named folder. Use issues_list to check the selected issues and their types first. If the user also asked to move them, confirm those moves succeeded before preparing the group. Returns the preview ID and wording. Starts no work.',
      schema: z.object({ folder: text.min(1), issueIds: z.array(id).min(2).max(50) }).strict(),
      path: '/api/flow-action',
      run: (input) => flows().action({ ...input, action: 'folder-group-preview' }),
    },
    issue_group_create: {
      description:
        'Create an idle master issue and attach the sub-issues from a current issue_group_preview when the user requested creation. Use the preview wording, preserving each issue’s scope and requested proof. Use a UUID requestId and reuse it for a retry. The master uses the sub-issues’ shared storage destinations.',
      schema: z.object({ previewId: id, wording: z.string().min(1).max(24000), requestId: id }).strict(),
      path: '/api/flow-action',
      run: async (input) => receipt(await flows().action({ ...input, action: 'folder-group-create' }), 'created'),
    },
    issue_edit: {
      description:
        'Edit only an open issue’s original prompt and/or issue type. Record design decisions as scope and constraints. Starting Work authorizes in-scope implementation; retain only specific decisions or operations the person reserved. Query issues_list for the issue ID and current revision first. Changing the original prompt reruns Request clarification; changing type applies that type’s default flow. This never starts issue work.',
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
        'Invoke an existing issue control when explicitly requested. To start or resume an issue’s planned route, query issues_list for its revision and use action play; the center-column control is labeled Start or Resume and runs the Request block before continuing the saved route through its existing guards. Use action start only for a specifically selected runnable non-Request block, with its blockId from issues_list. Never start the Request block directly. Existing approval, verification and ownership guards apply. Returns a command receipt; use the issue page for later progress. Never duplicate issue execution in this chat.',
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

function storedIssueList(service, location, issueId) {
  const result = listIssueStorage(service, location);
  return issueId ? { issues: result.issues.filter((issue) => issue.id === issueId) } : result;
}

function listedIssue(issue) {
  return {
    id: issue.id,
    title: issue.title,
    issueNumber: issue.issueNumber,
    state: issue.state,
    folderId: issue.folderId,
    url: '/?issue=' + encodeURIComponent(issue.id),
  };
}

function issueRequestSummary(flow) {
  const { wording, fields } = requestData(flow);
  return { originalPrompt: wording || '', issueType: fields?.type || flow.routeType };
}

function issueControlSnapshot(issue, flow, { records, warning }) {
  return {
    ...listedIssue(issue),
    ...issueRequestSummary(flow),
    revision: flow.revision,
    folder: flow.folder,
    annotations: records.filter(({ issueId }) => issueId === issue.id),
    annotationsWarning: warning,
    blocks: flow.blocks.map((block) => ({
      id: block.id,
      kind: block.kind,
      label: block.label,
      status: block.attempts.at(-1)?.status || 'ready',
    })),
  };
}

async function openIssueList(service, issueId, flows) {
  const { issues, issueFolders } = readQueue(service.root, { issueId });
  const folders = issueFolders.map(({ id, name }) => ({ id, name }));
  if (!issueId || !issues.length) return { folders, issues: issues.map(listedIssue) };
  const annotations = await issueAnnotations(service).view();
  return { folders, issues: issues.map((issue) => issueControlSnapshot(issue, flows().read(issue), annotations)) };
}

async function issueCreationReceipt({ deleted, issue, ...result } = {}, created) {
  requireThat(!deleted, 'This issue creation was removed. Use a new request to create it again.');
  if (issue) await created?.(issue.id);
  return receipt({ ...result, issue }, 'created');
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
