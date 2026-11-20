const dragAndDropScenarios = new Set([
  'factory-browser-issue-folders.mjs',
  'factory-browser-queue-drag.mjs',
  'Issue folders retain every issue and accept drags between folders',
]);

export function browserScenarioSelected(name, args = process.argv) {
  const dragAndDrop = dragAndDropScenarios.has(name);
  return args.includes('--drag-and-drop') ? dragAndDrop : !dragAndDrop;
}
