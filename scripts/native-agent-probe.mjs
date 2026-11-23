import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AgentProcess } from './factory-ui/agent-process.mjs';

const { values } = parseArgs({
  options: {
    claude: { type: 'string', default: 'claude' },
    gemini: { type: 'string', default: 'gemini' },
  },
});
const directory = mkdtempSync(join(tmpdir(), 'timey-agent-probe-'));
const results = [];
for (const provider of ['claude', 'gemini']) {
  const config = join(directory, provider);
  mkdirSync(config);
  const agent = new AgentProcess({
    command: values[provider].includes('/') ? resolve(values[provider]) : values[provider],
    args:
      provider === 'claude'
        ? [
            '--print',
            '--input-format',
            'stream-json',
            '--output-format',
            'stream-json',
            '--verbose',
            '--permission-prompt-tool',
            'stdio',
            '--permission-mode',
            'default',
            '--include-partial-messages',
          ]
        : ['--acp'],
    cwd: directory,
    env: { ...process.env, CLAUDE_CONFIG_DIR: config, GEMINI_CLI_HOME: config },
    protocol: provider,
    event() {},
    request(message) {
      agent.rejectRequest(message);
    },
  });
  try {
    const response = await agent.call(
      'initialize',
      provider === 'claude'
        ? {}
        : {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: 'timey-probe', version: '1' },
          }
    );
    results.push({
      provider,
      handshake: 'passed',
      ...(provider === 'gemini'
        ? {
            version: response.agentInfo?.version,
            resume: response.agentCapabilities?.loadSession,
            mcp: response.agentCapabilities?.mcpCapabilities,
          }
        : { models: response.models?.map(({ value }) => value) }),
      liveCoding: 'not run; requires the user’s configured agent login',
    });
  } catch (error) {
    results.push({ provider, handshake: 'failed', error: error.message });
  } finally {
    agent.close();
  }
}
console.log(JSON.stringify({ results }, null, 2));
if (results.some(({ handshake }) => handshake !== 'passed')) process.exitCode = 1;
