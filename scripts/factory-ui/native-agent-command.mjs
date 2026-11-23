import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

// Native installers may add ~/.local/bin after Factory has already started.
export function nativeAgentCommand(command, { path = process.env.PATH || '', home = homedir() } = {}) {
  if (!['claude', 'gemini', 'codex'].includes(command)) return command;
  const directories = [
    ...path.split(delimiter).filter(Boolean),
    join(home, '.local/bin'),
    join(home, '.npm-global/bin'),
  ];
  for (const directory of directories) {
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Check the next installation location. */
    }
  }
  return command;
}
