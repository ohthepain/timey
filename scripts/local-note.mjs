import { LocalNotes } from './factory-ui/local-notes.mjs';

const [operation = 'list', ...words] = process.argv.slice(2);
try {
  const notes = new LocalNotes(process.cwd());
  const current = notes.view();
  let result;
  if (operation === 'list') result = current;
  else if (operation === 'add') result = notes.action({ action: 'create', text: words.join(' ') });
  else {
    const [id, ...rest] = words;
    const input = { id, basis: current.basis };
    if (operation === 'edit') Object.assign(input, { action: 'edit', text: rest.join(' ') });
    else if (operation === 'done' || operation === 'reopen')
      Object.assign(input, { action: 'complete', done: operation === 'done' });
    else if (operation === 'delete') input.action = 'delete';
    else if (operation === 'up' || operation === 'down') Object.assign(input, { action: 'move', direction: operation });
    else throw Error('Usage: local-note.mjs list | add TEXT | edit ID TEXT | done/reopen/delete/up/down ID');
    result = notes.action(input);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
