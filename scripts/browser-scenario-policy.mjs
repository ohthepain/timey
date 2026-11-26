const dragAndDropScenarios = new Set([
  'factory-browser-issue-folders.mjs',
  'factory-browser-queue-drag.mjs',
  'Issue folders retain every issue and accept drags between folders',
]);

export function browserScenarioSelected(name, args = process.argv) {
  const named = args.filter((arg) => arg.startsWith('--scenario='));
  if (named.length) return named.length === 1 && named[0] === '--scenario=' + name;
  const dragAndDrop = dragAndDropScenarios.has(name);
  return args.includes('--drag-and-drop') ? dragAndDrop : !dragAndDrop;
}

const proposalsCheck = 'Pending proposals can be approved or deleted after confirmation without starting work';

export const flowBrowserScenarioNames = {
  '--activity-indicators': 'Activity dots stay anchored and reflect actual work',
  '--chat-progress': 'Issue and project chats retain semantic progress',
  '--automate-activity': 'Automate me dots follow each active response',
  '--issue-scrollbar': 'Issue flow scrollbar appears only while scrolling',
  '--issue-status-folders': 'Status pseudo-folders track project issues without moving them',
  '--master-issues': 'Master issue hierarchy and badges across the workspace',
  '--manual-sub-issue-removal': 'Manual removal clears the sub-issue master links and badge',
  '--investigative-grouping': 'Master grouping keeps investigative and non-investigative issues separate',
  '--issue-annotations': 'Issue annotations retain history and drive badge filters and attention order',
  '--project-issues': 'Closed issue selections archive together and issue links open the normal view',
  '--actions-menu': 'Actions menu lists two running Flow blocks',
  '--merged-issue': 'Merged issues preserve history and expose only closure controls',
  '--manual-close': 'Manual Close remains discoverable after Merge and automatic closing needs no prompt',
  '--error-recovery': 'Successful refresh clears rejected branch update errors',
  '--no-changes': 'Publication with no changes offers Cannot Reproduce closure',
  '--connection-recovery':
    'Flow and Classic reload the selected issue after a lost connection without replaying the click',
  '--merge-recovery': 'Pending local merges are visible and can be aborted',
  '--drag-and-drop': 'Issue folders retain every issue and accept drags between folders',
  '--local-notes': 'Local notes capture and handoff preserve flow',
  '--sidebar-labels': 'Issues and Local notes use matching text styles',
  '--sidebar-scroll': 'The whole sidebar scrolls over every section',
  '--project-home': 'Project home investigates selected branches and reviews Automate me skills',
  '--project-navigation': 'The shared Factory header keeps every project tab and relocated control usable',
  '--server-heap': 'The Factory header refreshes live server heap usage and shows an unavailable reading',
  '--project-discuss': 'Project Discuss retains independent conversations, settings and explicit controls',
  '--asset-storage': 'Asset Storage lists project S3 artifacts and retained references in Settings',
  '--project-settings': 'Project Settings addressable pages preserve drafts, sources and explicit saves',
  '--ai-providers': 'Factory provider settings save enablement and quota warnings',
  '--native-agents': 'Native Flow approvals and questions retain their exact attempt',
  '--stores': 'Storage profiles preserve explicit destinations and perform checked moves without workspace updates',
  '--ai-text': 'AI text offers copy bro and caret-aware hovered dictation',
  '--investigation-reports': 'Investigation reports retain content, reading state and shared discussion',
  '--investigation-flows': 'Investigations use ordinary flows and independent retained outputs',
  '--investigation-toolbar': 'Investigation controls remain above the graph',
  '--interface-state': 'Refresh preserves expanded activity, editor size, drafts and copied selection',
  '--investigation-followups': 'Completed investigations create reviewed follow-ups without another Retro',
  '--branch-repair': 'Branch repair progress survives reload and requires candidate approval',
  '--block-models': 'Block models preserve history and surface persistent blockers',
  '--block-skills': 'Block skill choices preserve defaults and offer missing-skill setup',
  '--block-deletion': 'Click-selected blocks support safe, confirmed Delete and Backspace removal',
  '--folder-settings': 'Folder settings inherit, repair, search and act on selected open or closed issues',
  '--issue-results': 'Issue results appear below the banner without replacing playback status',
  '--human-input': 'Required PR review is visible and continues only after an explicit action',
  '--merge-settings': 'Request leaves merge checks to GitHub and the block palette hides Verify',
  '--request-save': 'Saving Your words releases issue controls while Request clarification runs',
  '--block-inspection': 'On-demand refresh preserves drafts; Codex popup resets history without moving the sidebar',
  '--storage-status': 'Storage startup and recovery messages follow confirmed availability',
  '--polling': 'Polling preserves expanded text and the Closed issues list',
  '--capture-folder-issue': 'Folder plus creates an issue directly in that folder and retains typed wording',
  '--starting-point': 'Starting point lists every branch in date order, saves selection and survives polling',
  '--closed-destination': 'Closed issues open with Destination flush with the bottom, including short flows',
  '--folder-workspace-grouping': 'The folder workspace reviews moves and creates a master without starting work',
  '--tab-source': 'Inspect and edit a tab source without starting work or losing an issue draft',
  '--sidebar-issue-names': 'Numbered full issue names wrap and sidebar resizing survives reload',
  '--save-request-route': 'Saving Your words retains derived fields and applies the new type default',
  '--flow-menu': 'The Flow menu saves and switches routes, and the wand rebuilds with results intact',
  '--add-parallel-block': 'Adding and saving a block retains the selected prompt mode and parallel lane',
  '--reorder-saved-blocks': 'Keyboard controls reorder saved blocks',
  '--assign-folder': 'Folders can be created and assigned without running work',
  '--save-block-comment': 'Block comments remain attached after reload',
  '--work-markdown': 'Work Markdown reloads headings and lists without changing layout, drafts or actions',
  '--stop-work': 'Inspector Run guards drafts and switches to Stop during a run',
  '--retry-work': 'Retry retains both attempts and does not start the next block',
  '--reload-flow-history': 'Reload retains flow settings, comments, folder and attempt history',
  '--run-extra-work': 'Run beside the Work name starts exactly one block',
  '--update-worktree': 'Worktree menu opens the saved checkout and updates it from the remote target',
  '--publish-preview': 'Publish previews the exact description and refreshes it before any remote write',
  '--timers': 'Block timers reset for each attempt and stop at the last saved time after disconnect',
  '--proposals': proposalsCheck,
  '--delayed-delete': proposalsCheck,
};

export const flowBrowserCiParts = new Set(['--ci-part=1', '--ci-part=2']);

export const flowBrowserOrderModifier = '--reverse-fixture-scenarios';

export function isFlowBrowserSelector(flag) {
  return Object.hasOwn(flowBrowserScenarioNames, flag);
}

export function flowBrowserScenarioSelected(name, args = process.argv) {
  const selected = args.filter(isFlowBrowserSelector);
  return (
    browserScenarioSelected(name, args) &&
    (selected.length === 0 || selected.some((flag) => flowBrowserScenarioNames[flag] === name))
  );
}
