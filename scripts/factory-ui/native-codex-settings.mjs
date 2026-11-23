import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { requireThat } from './common.mjs';

let cached;
export function configuredCodexSettings() {
  // Read only model selection, never serialize configuration or credential contents.
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const stat = statSync(join(home, 'config.toml'));
  const key = [home, stat.mtimeMs, stat.size].join(':');
  if (cached?.key === key) return { ...cached.settings };
  const script =
    'import tomllib,sys,json,pathlib; c=tomllib.loads((pathlib.Path(sys.argv[1])/"config.toml").read_text()); print(json.dumps({k:c.get(k) for k in ["model","model_provider","profile"]}))';
  const settings = JSON.parse(
    execFileSync('python3', ['-c', script, home], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  );
  requireThat(
    !settings.profile && !settings.model_provider && typeof settings.model === 'string',
    'Unsupported provider configuration.'
  );
  cached = { key, settings };
  return { ...settings };
}
