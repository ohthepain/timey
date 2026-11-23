import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CodexAccountConnection } from './codex-account.mjs';
import { AgentProcess } from './agent-process.mjs';
import { cleanEnvironment, digest, requireThat } from './common.mjs';
import { providerNames } from './provider-config.mjs';
import { observeProvider, providerSettings, refreshProviderQuota } from './provider-runtime.mjs';

const execute = promisify(execFile);
const providerGuides = {
  codex: 'https://developers.openai.com/codex/cli/',
  anthropic: 'https://code.claude.com/docs/en/setup',
  google: 'https://geminicli.com/docs/get-started/installation/',
};
const commands = { codex: 'codex', anthropic: 'claude', google: 'gemini' };
const safeId = (id) => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,170}$/.test(id);
function model(id, entry) {
  const raw = entry.modelId || entry.value || entry.model || entry.id;
  if (!safeId(raw)) return null;
  return {
    id: id === 'codex' ? raw : id + ':' + raw,
    name: entry.displayName || entry.name || entry.display_name || raw,
    description: entry.description || '',
    supportsEffort: id === 'codex',
  };
}
async function run(root, command, args) {
  const result = await execute(command, args, {
    cwd: root,
    env: cleanEnvironment(),
    timeout: 20000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout;
}
async function discoverCodex(root) {
  const connection = new CodexAccountConnection();
  try {
    await connection.ready();
    const { account } = await connection.call('account/read', { refreshToken: false });
    requireThat(account, 'Sign in with Codex, then Refresh.');
    const models = [];
    let cursor = null;
    do {
      const result = await connection.call('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      models.push(...result.data.map((entry) => model('codex', entry)).filter(Boolean));
      cursor = result.nextCursor;
      requireThat(models.length < 2000, 'The model catalog is too large. Update the native agent.');
    } while (cursor);
    return { models, accountKey: digest(JSON.stringify([account.type, account.id, account.email])) };
  } finally {
    connection.close();
  }
}
async function discoverClaude(root) {
  const auth = JSON.parse(await run(root, 'claude', ['auth', 'status']));
  requireThat(auth.loggedIn === true, 'Sign in with Claude Code, then Refresh.');
  const process = new AgentProcess({
    command: 'claude',
    args: [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompt-tool',
      'stdio',
    ],
    cwd: root,
    env: cleanEnvironment(),
    protocol: 'claude',
    event() {},
    request() {
      throw Error('Setup cannot approve tools.');
    },
  });
  try {
    const result = await process.call('initialize');
    return {
      models: (result.models || []).map((entry) => model('anthropic', entry)).filter(Boolean),
      accountKey: digest(JSON.stringify([auth.authMethod, auth.apiProvider, auth.email, auth.orgId])),
    };
  } finally {
    process.close();
  }
}
async function discoverGoogle(root) {
  const process = new AgentProcess({
    command: 'gemini',
    args: ['--acp'],
    cwd: root,
    env: { ...cleanEnvironment(), NO_BROWSER: 'true' },
    protocol: 'gemini',
    event() {},
    request() {
      throw Error('Setup cannot approve tools.');
    },
  });
  try {
    const initialized = await process.call('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'timey', version: '1' },
    });
    requireThat(initialized.agentCapabilities?.loadSession, 'Update Gemini CLI to a version with session loading.');
    // No authenticate or prompt request: an unauthenticated session must fail.
    const session = await process.call('session/new', { cwd: root, mcpServers: [] });
    return { models: (session.models?.availableModels || []).map((entry) => model('google', entry)).filter(Boolean) };
  } finally {
    process.close();
  }
}
export async function refreshProvider(root, id) {
  requireThat(Object.hasOwn(providerNames, id), 'Choose a supported provider.');
  try {
    const discovery = await { codex: discoverCodex, anthropic: discoverClaude, google: discoverGoogle }[id](root);
    const { models, accountKey } = discovery;
    requireThat(
      models.length,
      'No supported models were advertised. Update the native agent and sign in, then Refresh.'
    );
    observeProvider(root, id, {
      ...(accountKey ? { accountKey } : {}),
      ready: true,
      message: 'Signed in · native models advertised',
      models,
      checkedAt: Date.now(),
    });
    await refreshProviderQuota(root, id);
  } catch (error) {
    observeProvider(root, id, {
      ready: false,
      message:
        error.code === 'ENOENT' || error.code === 'AGENT_NOT_INSTALLED'
          ? 'Install the native agent, then sign in and Refresh.'
          : 'Could not confirm sign-in and models. Complete native Setup, then Refresh.',
      checkedAt: Date.now(),
    });
  }
  return providerSettings(root);
}
export async function setupProvider(root, id) {
  requireThat(Object.hasOwn(providerNames, id), 'Choose a supported provider.');
  try {
    await run(root, commands[id], ['--version']);
  } catch {
    return {
      guide: providerGuides[id],
      message: 'Install the native agent using the linked instructions, then choose Setup again.',
    };
  }
  const checked = await refreshProvider(root, id);
  if (checked.providers.find((provider) => provider.id === id)?.ready)
    return {
      ready: true,
      guide: providerGuides[id],
      message: 'Existing native sign-in found. Choose which models to enable, then Save.',
    };
  const login = { codex: 'codex login', anthropic: 'claude auth login', google: 'gemini' }[id];
  requireThat(
    process.platform === 'darwin',
    `Run ${login} in a terminal, then Refresh. Native browser setup is currently available on macOS.`
  );
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = `cd ${quote(root)} && ${login}`;
  await execute(
    '/usr/bin/osascript',
    [
      '-e',
      'tell application "Terminal" to activate',
      '-e',
      `tell application "Terminal" to do script ${JSON.stringify(command)}`,
    ],
    { timeout: 10000 }
  );
  return {
    guide: providerGuides[id],
    message:
      'Finish sign-in in the native terminal, then Refresh. Signing in may change the native agent account used by other projects. Setup sends no model prompt.',
  };
}
