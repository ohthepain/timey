import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, git, readJson, requireThat } from './common.mjs';
import { lifecycleEvent, retainAnswer, saveLifecycle } from './lifecycle-store.mjs';

export function deliveryConfigBasis(root) {
  const path = join(root, '.issues/issue-delivery-config.json');
  return existsSync(path) ? digest(readFileSync(path)) : null;
}
function deliverySetupFailure(service, record) {
  const run = service.store.runs.find((r) => r.id === record.childRunId);
  return run?.kind === 'assembly' &&
    /issue-delivery-config\.json|Pull request settings are missing/.test(run.summary || '')
    ? run
    : null;
}
export function needsDeliverySetupRecovery(service, record) {
  return record.deliverySetupVersion !== 1 && Boolean(deliverySetupFailure(service, record));
}
export function recoverDeliverySetup(service, record) {
  if (!needsDeliverySetupRecovery(service, record)) return;
  saveLifecycle(service, record, { deliverySetupVersion: 1, attempts: [], recoveryContexts: [], replan: false });
  ensureDeliverySetup(service, record);
}
function repository(root) {
  const url = git(root, 'remote', 'get-url', 'origin');
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+)\.git$/.exec(url);
  requireThat(
    match,
    'The origin remote is not a supported GitHub repository. Correct origin, then retry this operation.'
  );
  return match[1];
}
function savedTarget(service, record, repo) {
  if (!existsSync(service.store.directory)) return null;
  const answers = readdirSync(service.store.directory)
    .filter((name) => /^answer-.*\.json$/.test(name))
    .flatMap((name) => {
      try {
        const path = join(service.store.directory, name),
          answer = readJson(path);
        return [{ ...answer, path }];
      } catch {
        return [];
      }
    })
    .filter((a) => a.actor === 'human' && a.issueId === record.issueId && validTargetAnswer(a, repo))
    .sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  const latest = answers[0];
  if (!latest) return null;
  const sameTime = answers.filter((a) => a.at === latest.at);
  if (!sameTime.every((a) => a.answer.trim() === latest.answer.trim())) return null;
  return { target: latest.answer.trim(), source: { path: latest.path, sha256: digest(readFileSync(latest.path)) } };
}
function validTargetAnswer(answer, repo) {
  if (answer.type === 'delivery-setup') return answer.repository === repo && validBranch(answer.answer);
  return (
    answer.type === 'clarification' &&
    answer.questions?.length === 1 &&
    answer.questions[0].question === `Should issue pull requests in ${repo} target dev or main?` &&
    ['dev', 'main'].includes(answer.answer?.trim())
  );
}
function validBranch(value) {
  return typeof value === 'string' && /^[\w/.-]+$/.test(value.trim()) && !value.startsWith('-');
}
export function ensureDeliverySetup(service, record) {
  if (deliveryConfigBasis(service.root)) return true;
  const repo = repository(service.root),
    answer = savedTarget(service, record, repo);
  if (!answer) {
    saveLifecycle(service, record, {
      status: 'waiting',
      summary: 'Choose where this project’s pull requests should go.',
      input: {
        type: 'delivery-setup',
        repository: repo,
        question: `Which branch should pull requests in ${repo} target? For example, dev or main.`,
        expected:
          'We will save this project setting and retry the existing operation. No implementation will restart, and the original merge will not be repeated.',
      },
    });
    return false;
  }
  writeConfig(service, repo, answer);
  lifecycleEvent(
    service,
    record,
    `Saved pull request settings for ${repo}, targeting ${answer.target}. Continuing the existing operation.`
  );
  return true;
}
function writeConfig(service, repo, answer) {
  requireThat(
    git(service.root, 'check-ref-format', '--branch', answer.target) === answer.target,
    'Enter a valid target branch name.'
  );
  const path = join(service.root, '.issues/issue-delivery-config.json');
  const value = {
    provider: 'github',
    repository: repo,
    remote: 'origin',
    target: answer.target,
    decision: answer.source,
  };
  try {
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const current = readJson(path);
    requireThat(
      ['provider', 'repository', 'remote', 'target'].every((key) => current[key] === value[key]),
      'Pull request settings were saved differently by another action. Review the current settings before retrying.'
    );
  }
}
export function answerDeliverySetup(service, record, input) {
  const repo = repository(service.root);
  requireThat(
    repo === record.input.repository,
    'The project remote changed. Review the repository before selecting a target.'
  );
  requireThat(validBranch(input.text), 'Enter a target branch name, for example dev or main.');
  const target = input.text.trim();
  if (deliveryConfigBasis(service.root)) {
    const current = readJson(join(service.root, '.issues/issue-delivery-config.json'));
    requireThat(
      current.repository === repo && current.target === target,
      'Pull request settings were saved differently while this question was open. Review them before continuing.'
    );
  }
  git(service.root, 'check-ref-format', '--branch', target);
  retainAnswer(service, record, { type: 'delivery-setup', repository: repo, answer: target });
  requireThat(ensureDeliverySetup(service, record), 'The target setting could not be saved.');
  saveLifecycle(service, record, { attempts: [], recoveryContexts: [], replan: false });
}
