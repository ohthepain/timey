import {
  installationRecipe,
  missingInstallation,
  providerCommand,
  openProviderTerminal,
} from './provider-installation.mjs';
import { CodexAccountConnection } from './codex-account.mjs';
import { AgentProcess } from './agent-process.mjs';
import { cleanEnvironment, digest, requireThat } from './common.mjs';
import { providerNames } from './provider-config.mjs';
import { observeProvider, providerSettings, refreshProviderQuota } from './provider-runtime.mjs';

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
  const auth = JSON.parse(await providerCommand(root, 'claude', ['auth', 'status']));
  if (auth.loggedIn !== true)
    throw Object.assign(Error('Sign in with Claude Code, then check again.'), { code: 'AGENT_SIGN_IN_REQUIRED' });
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
      setup: { ...installationRecipe(id), step: 'ready' },
      checkedAt: Date.now(),
    });
    await refreshProviderQuota(root, id);
  } catch (error) {
    const missing = error.code === 'ENOENT' || error.code === 'AGENT_NOT_INSTALLED';
    const recipe = installationRecipe(id);
    const setup = missing
      ? await missingInstallation(root, id)
      : { ...recipe, step: error.code === 'AGENT_SIGN_IN_REQUIRED' ? 'signin' : 'error' };
    observeProvider(root, id, {
      ready: false,
      setup,
      message: missing
        ? `${recipe.agent} is not installed or is not on Factory’s PATH.`
        : `Could not confirm ${recipe.agent} sign-in and models. Sign in, then check again.`,
      checkedAt: Date.now(),
    });
  }
  return providerSettings(root);
}
function recordSetup(root, id, setup, message) {
  observeProvider(root, id, { ready: false, setup, message, checkedAt: Date.now() });
  return { setup, guide: providerGuides[id], message };
}
export async function setupProvider(root, id, { openTerminal = openProviderTerminal } = {}) {
  requireThat(Object.hasOwn(providerNames, id), 'Choose a supported provider.');
  const recipe = installationRecipe(id);
  try {
    await providerCommand(root, commands[id], ['--version']);
  } catch (error) {
    if (error.code === 'ENOENT')
      return recordSetup(
        root,
        id,
        await missingInstallation(root, id),
        `${recipe.agent} is not installed or is not on Factory’s PATH.`
      );
    return recordSetup(
      root,
      id,
      { ...recipe, step: 'error' },
      `${recipe.agent} was found but could not start. Run ${recipe.checkCommand} in Terminal to inspect or repair the installation, then check again.`
    );
  }
  const checked = await refreshProvider(root, id);
  if (checked.providers.find((provider) => provider.id === id)?.ready)
    return {
      ready: true,
      guide: providerGuides[id],
      message: 'Existing native sign-in found. Choose which models to enable, then Save.',
    };
  if (process.platform !== 'darwin')
    return recordSetup(
      root,
      id,
      { ...recipe, step: 'signin' },
      `Run ${recipe.loginCommand} in your terminal, finish sign-in, then check again.`
    );
  try {
    await openTerminal(recipe.loginCommand, { directory: root });
  } catch {
    return recordSetup(
      root,
      id,
      { ...recipe, step: 'signin' },
      `Could not open Terminal. Run ${recipe.loginCommand} in your terminal, then check again.`
    );
  }
  return recordSetup(
    root,
    id,
    { ...recipe, step: 'signin' },
    `Finish ${recipe.agent} sign-in in Terminal, then choose Check again. Signing in may change the native agent account used by other projects. Setup sends no model prompt.`
  );
}
export async function installProvider(root, id, { openTerminal = openProviderTerminal } = {}) {
  const recipe = installationRecipe(id);
  try {
    await providerCommand(root, recipe.executable, ['--version']);
    return { ready: false, message: `${recipe.agent} is already installed. Choose Sign in or Check again.` };
  } catch (error) {
    if (error.code !== 'ENOENT')
      return recordSetup(
        root,
        id,
        { ...recipe, step: 'error' },
        `${recipe.agent} was found but could not start. Run ${recipe.checkCommand} in Terminal before reinstalling.`
      );
  }
  const setup = await missingInstallation(root, id);
  if (!setup.canInstall)
    return recordSetup(
      root,
      id,
      setup,
      setup.prerequisite || 'Run the install command below in your terminal, then check again.'
    );
  try {
    await openTerminal(recipe.command);
  } catch {
    return recordSetup(
      root,
      id,
      setup,
      'Could not open Terminal. Copy the install command below into your terminal, then check again.'
    );
  }
  return recordSetup(
    root,
    id,
    { ...setup, step: 'installing', canInstall: false },
    `Installation opened in Terminal. When it finishes, choose Check again, then Sign in. If installation fails, the terminal shows the error; the commands below remain available.`
  );
}
