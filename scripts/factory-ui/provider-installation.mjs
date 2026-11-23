import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { cleanEnvironment, requireThat } from './common.mjs';
import { nativeAgentCommand } from './native-agent-command.mjs';

const execute = promisify(execFile);
const recipes = {
  codex: {
    agent: 'Codex CLI',
    command: 'npm install -g @openai/codex',
    executable: 'codex',
    loginCommand: 'codex login',
    npm: true,
  },
  anthropic: {
    agent: 'Claude Code',
    command: 'curl -fsSL https://claude.ai/install.sh | bash',
    executable: 'claude',
    loginCommand: 'claude auth login',
    npm: false,
  },
  google: {
    agent: 'Gemini CLI',
    command: 'npm install -g @google/gemini-cli',
    executable: 'gemini',
    loginCommand: 'gemini',
    npm: true,
  },
};
export function installationRecipe(id) {
  requireThat(Object.hasOwn(recipes, id), 'Choose a supported provider.');
  const recipe = recipes[id];
  const command =
    process.platform === 'win32' && id === 'anthropic' ? 'irm https://claude.ai/install.ps1 | iex' : recipe.command;
  return { ...recipe, command, checkCommand: `${recipe.executable} --version` };
}
export async function providerCommand(root, command, args) {
  return (
    await execute(nativeAgentCommand(command), args, {
      cwd: root,
      env: cleanEnvironment(),
      timeout: 20000,
      maxBuffer: 2 * 1024 * 1024,
    })
  ).stdout;
}
export async function missingInstallation(root, id) {
  const recipe = installationRecipe(id);
  let prerequisite = null;
  if (recipe.npm) {
    try {
      await providerCommand(root, 'npm', ['--version']);
    } catch {
      prerequisite = 'Install Node.js 22 or later (includes npm), then restart Factory and check again.';
    }
  }
  return { ...recipe, step: 'install', canInstall: process.platform === 'darwin' && !prerequisite, prerequisite };
}
export async function openProviderTerminal(
  command,
  { directory = homedir(), launch = execute, platform = process.platform } = {}
) {
  requireThat(platform === 'darwin', `Run this command in your terminal: ${command}`);
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  await launch(
    '/usr/bin/osascript',
    [
      '-e',
      'tell application "Terminal" to activate',
      '-e',
      `tell application "Terminal" to do script ${JSON.stringify(`cd ${quote(directory)} && ${command}`)}`,
    ],
    { timeout: 10000 }
  );
}
