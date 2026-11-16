import { ViewSources } from './view-sources.mjs';

export async function runViewCommand(project, args) {
  const [command, ...options] = args;
  if (!['find', 'index', 'update'].includes(command))
    throw Error('Use factory ui find QUERY, factory ui index, or factory ui update [--watch].');
  if (command === 'find' && !options.length) throw Error('Enter a label, screen, or section to find.');
  if (command === 'index' && options.length) throw Error('The UI index takes no arguments.');
  if (command === 'update' && options.length && (options.length !== 1 || options[0] !== '--watch'))
    throw Error('The only option for UI update is --watch.');
  const sources = new ViewSources(project);
  const result = sources.update();
  if (command === 'update' && options[0] === '--watch') {
    console.log(report(result));
    let errors = result.errors.join('\n');
    const timer = setInterval(() => {
      const next = sources.update();
      const diagnostics = next.errors.join('\n');
      if (next.changed.length || diagnostics !== errors) console.log(report(next));
      errors = diagnostics;
    }, 1000);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => clearInterval(timer));
    return await new Promise((done) => {
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => done('Stopped watching UI sources.'));
    });
  }
  if (result.errors.length) throw Error(result.errors.join('\n'));
  if (command === 'update') return report(result);
  const query = options.join(' ').toLowerCase();
  const entries = result.entries.filter((entry) =>
    [entry.label, entry.bundled.label, entry.section, entry.screen, entry.name, entry.view]
      .join(' ')
      .toLowerCase()
      .includes(query)
  );
  return entries.length ? entries.map(describe).join('\n\n') : 'No UI sources match that search.';
}

function report({ changed, errors }) {
  const summary = changed.length ? 'Built UI regions: ' + changed.join(', ') : 'No UI regions rebuilt.';
  return [summary, ...errors].join('\n');
}

function describe(entry) {
  const { bundled, override, overridePath } = entry;
  return [
    entry.screen + ' / ' + entry.name + ' / ' + entry.section + ' · ' + entry.label,
    bundled ? '  Bundled: ' + bundled.path + ':' + bundled.line : '  Project-defined block',
    '  Project: ' + (override ? override.path + ':' + override.line : overridePath + ' (inherited)'),
    '  Used by: ' + entry.consumers.join(', '),
  ].join('\n');
}
