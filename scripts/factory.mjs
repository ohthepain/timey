import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const active = new Set(['reserved', 'setup', 'running', 'blocked', 'completed']);
const kinds = new Set(['investigate', 'prototype', 'implement', 'verify', 'review', 'integrate', 'retro']);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const assert = (condition, message) => {
  if (!condition) throw Error(message);
};

function validateRecoveredCode(action) {
  if (!['implement', 'integrate'].includes(action.kind)) return;
  assert(action.merge !== 'none', 'Code actions need an automatic or human-first integration policy.');
  if (action.status === 'completed') {
    assert(
      typeof action.worker_revision === 'string' && /^[0-9a-f]{40}$/.test(action.worker_revision),
      'Completed code recovery needs its exact worker commit; recover as blocked if unknown.'
    );
  }
}

function validateRecoveredReference(action) {
  if (action.status === 'running') {
    assert(
      typeof action.threadId === 'string' && typeof action.hostId === 'string',
      'Running recovery needs a ready chat.'
    );
  }
  if (action.status === 'setup')
    assert(typeof action.clientThreadId === 'string', 'Pending recovery needs its setup ID.');
}

function validateRecoveredWorker(action, known) {
  assert(action && typeof action.id === 'string', 'Recovery needs original action IDs.');
  assert(
    kinds.has(action.kind) && ['setup', 'running', 'blocked', 'completed'].includes(action.status),
    'Invalid recovered worker kind/status.'
  );
  assert(
    Array.isArray(action.issues) && action.issues.length > 0 && action.issues.every((id) => known.includes(id)),
    'Recovered worker must link known local issues.'
  );
  assert(
    typeof action.recovery_evidence === 'string' && action.recovery_evidence.trim(),
    'Link actual chat discovery evidence.'
  );
  assert(['automatic', 'human-first', 'none'].includes(action.merge), 'Recover the actual merge policy.');
  validateRecoveredCode(action);
  validateRecoveredReference(action);
  return action.id;
}

export function factory(project) {
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' });
  const root = git('rev-parse', '--show-toplevel').trim();
  const queue = join(root, '.issues');
  const ledger = join(queue, 'factory.json');
  const lock = join(queue, 'factory.lock');
  assert(existsSync(join(queue, 'triage-labels.md')), 'Initialize the local queue first.');
  const readLedger = () => {
    assert(existsSync(ledger), 'Registry missing: reconcile existing worker chats, then explicitly initialize it.');
    const data = JSON.parse(readFileSync(ledger, 'utf8'));
    assert(data.version === 1 && Array.isArray(data.actions), 'Unsupported or damaged registry.');
    return data;
  };
  const reports = () =>
    readdirSync(queue)
      .filter((name) => /^\d.*\.md$/.test(name))
      .sort()
      .map((name) => {
        const content = readFileSync(join(queue, name), 'utf8');
        const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        assert(match, `Missing report YAML: ${name}`);
        const metadata = parse(match[1]);
        assert(
          metadata && typeof metadata.id === 'string' && typeof metadata.state === 'string',
          `Invalid report: ${name}`
        );
        if (metadata.human_checks !== undefined) {
          assert(Array.isArray(metadata.human_checks), `human_checks must be a list: ${name}`);
          const identities = new Set();
          for (const check of metadata.human_checks) {
            assert(
              check && typeof check.id === 'string' && !identities.has(check.id),
              `Invalid/duplicate human check: ${name}`
            );
            identities.add(check.id);
            assert(
              ['evidence', 'judgment'].includes(check.kind) &&
                ['pending', 'passed', 'failed'].includes(check.status) &&
                ['dependent-work', 'closure'].includes(check.blocks),
              `Invalid human check classification: ${name}`
            );
            assert(
              typeof check.instructions === 'string' && check.instructions.trim(),
              `Missing human instructions: ${name}`
            );
            if (check.status === 'passed') {
              assert(
                typeof check.revision === 'string' &&
                  check.revision.trim() &&
                  typeof check.result === 'string' &&
                  check.result.trim(),
                `Human pass needs revision and actual result: ${name}`
              );
            }
          }
        }
        return { path: join(queue, name), metadata, content };
      });
  const snapshot = () => ({
    head: git('rev-parse', 'HEAD').trim(),
    // Include ignored queue configuration but never store its contents or Git diffs in the registry.
    queue: digest(
      readdirSync(queue)
        .filter((name) => name.endsWith('.md') || name === 'preferences.json')
        .sort()
        .map((name) => name + '\0' + readFileSync(join(queue, name), 'utf8'))
        .join('\0')
    ),
    worktree: digest(
      git('diff', 'HEAD', '--binary') +
        git('ls-files', '--others', '--exclude-standard', '-z')
          .split('\0')
          .filter(Boolean)
          .sort()
          .map(
            (name) =>
              name +
              '\0' +
              (lstatSync(join(root, name)).isSymbolicLink()
                ? readlinkSync(join(root, name))
                : digest(readFileSync(join(root, name))))
          )
          .join('\0')
    ),
  });
  const mutate = (fn) => {
    try {
      mkdirSync(lock);
    } catch (error) {
      if (error.code === 'EEXIST')
        throw Error('Coordinator lock exists. Reconcile its owner; do not automatically remove it.');
      throw error;
    }
    try {
      const data = readLedger();
      const result = fn(data);
      const tmp = `${ledger}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
      renameSync(tmp, ledger);
      return result;
    } finally {
      rmSync(lock, { recursive: true });
    }
  };
  const find = (data, id) => {
    const action = data.actions.find((entry) => entry.id === id);
    assert(action, `Unknown action: ${id}`);
    return action;
  };
  return {
    init() {
      // Exclusive create: init cannot erase active dispatch records.
      writeFileSync(ledger, JSON.stringify({ version: 1, actions: [] }, null, 2) + '\n', { flag: 'wx' });
      return { initialized: ledger, instruction: 'Evaluation and action launches remain manual.' };
    },
    recover(records) {
      assert(!existsSync(ledger), 'Registry exists; reconcile it rather than replacing it.');
      assert(
        Array.isArray(records) && records.length > 0,
        'Recover known workers; use init only after confirming none exist.'
      );
      const known = reports().map((report) => report.metadata.id);
      const identities = records.map((action) => validateRecoveredWorker(action, known));
      assert(new Set(identities).size === identities.length, 'Recovery needs unique original action IDs.');
      try {
        mkdirSync(lock);
      } catch {
        throw Error('Coordinator lock exists; reconcile before recovery.');
      }
      try {
        writeFileSync(ledger, JSON.stringify({ version: 1, actions: records }, null, 2) + '\n', { flag: 'wx' });
      } finally {
        rmSync(lock, { recursive: true });
      }
      return {
        recovered: records.map((action) => action.id),
        instruction: 'Known claims restored; no chats were launched.',
      };
    },
    inspect() {
      return {
        project: root,
        snapshot: snapshot(),
        reports: reports(),
        registry: existsSync(ledger) ? readLedger() : null,
      };
    },
    recommend(proposals) {
      assert(Array.isArray(proposals) && proposals.length > 0, 'Supply a ranked, nonempty action array.');
      return mutate((data) => {
        const current = reports();
        const basis = snapshot();
        const batch = proposals.map((proposal) => {
          assert(kinds.has(proposal.kind), 'Unknown action kind.');
          for (const key of ['title', 'scope', 'reason', 'verification', 'worker_prompt']) {
            assert(typeof proposal[key] === 'string' && proposal[key].trim(), `Missing ${key}.`);
          }
          assert(['automatic', 'human-first', 'none'].includes(proposal.merge), 'Choose an explicit merge policy.');
          assert(
            !['implement', 'integrate'].includes(proposal.kind) || proposal.merge !== 'none',
            'Code actions need an automatic or human-first integration policy.'
          );
          assert(Array.isArray(proposal.issues) && proposal.issues.length > 0, 'Link at least one local issue.');
          assert(new Set(proposal.issues).size === proposal.issues.length, 'Duplicate issue IDs.');
          for (const id of proposal.issues) {
            assert(
              current.filter((report) => report.metadata.id === id).length === 1,
              `Missing or ambiguous issue: ${id}`
            );
          }
          assert(
            Array.isArray(proposal.dependencies) && proposal.dependencies.every((id) => typeof id === 'string'),
            'Declare dependency action IDs (or []).'
          );
          return { ...proposal, id: randomUUID(), basis, status: 'recommended', created: new Date().toISOString() };
        });
        data.actions.push(...batch);
        return batch;
      });
    },
    reserve(id) {
      return mutate((data) => {
        const action = find(data, id);
        assert(action.status === 'recommended', `Action is already ${action.status}; never dispatch it twice.`);
        assert(
          JSON.stringify(action.basis) === JSON.stringify(snapshot()),
          'Stale recommendation: manually reevaluate.'
        );
        assert(
          !git('status', '--porcelain', '--untracked-files=all').trim(),
          'Commit or isolate source changes before starting a worktree from HEAD.'
        );
        for (const dependency of action.dependencies) {
          const prior = find(data, dependency);
          const inspectingResult =
            ['review', 'verify', 'integrate'].includes(action.kind) && prior.status === 'completed';
          assert(
            ['integrated', 'reconciled'].includes(prior.status) || inspectingResult,
            `Dependency not reconciled/integrated: ${dependency}`
          );
        }
        const conflict = data.actions.find(
          (entry) =>
            active.has(entry.status) &&
            entry.issues.some((issue) => action.issues.includes(issue)) &&
            !(
              entry.status === 'completed' &&
              action.dependencies.includes(entry.id) &&
              ['review', 'verify', 'integrate'].includes(action.kind)
            )
        );
        assert(!conflict, `Issue already claimed by action ${conflict?.id}.`);
        const current = reports();
        const closed = readFileSync(join(queue, 'triage-labels.md'), 'utf8')
          .split('\n')
          .map((line) => line.split('|').map((cell) => cell.replaceAll('`', '').trim()))
          .find((cells) => cells[1] === 'closed')?.[2];
        assert(closed, 'Lifecycle has no closed-role mapping.');
        for (const id of action.issues) {
          const report = current.find((entry) => entry.metadata.id === id).metadata;
          assert(
            report.state !== closed && !report.grill_later && !report.kind?.startsWith('wayfinder-'),
            'Closed, deferred or planning-only report is not dispatchable.'
          );
          if (['implement', 'integrate'].includes(action.kind)) {
            assert(
              !report.human_checks?.some((check) => check.blocks === 'dependent-work' && check.status !== 'passed'),
              'A required human check blocks this work.'
            );
          }
        }
        action.status = 'reserved';
        action.reserved = new Date().toISOString();
        return action;
      });
    },
    attach(id, reference) {
      return mutate((data) => {
        const action = find(data, id);
        assert(
          ['reserved', 'setup', 'blocked'].includes(action.status),
          'Only an unbound reservation/setup can attach a chat.'
        );
        assert(!action.threadId, 'Chat already bound.');
        assert(
          (typeof reference.threadId === 'string' && typeof reference.hostId === 'string') ||
            typeof reference.clientThreadId === 'string',
          'Need ready threadId/hostId or pending clientThreadId.'
        );
        assert(!(reference.threadId && reference.clientThreadId), 'Pending setup ID is not a ready thread ID.');
        for (const key of ['threadId', 'hostId', 'clientThreadId']) {
          if (reference[key]) action[key] = reference[key];
        }
        if (reference.threadId) delete action.clientThreadId;
        action.status = reference.threadId ? 'running' : 'setup';
        return action;
      });
    },
    record(id, update) {
      return mutate((data) => {
        const action = find(data, id);
        const transitions = {
          reserved: ['blocked', 'failed', 'cancelled'],
          setup: ['blocked', 'failed', 'cancelled'],
          running: ['completed', 'blocked', 'failed'],
          blocked: ['running', 'completed', 'failed', 'cancelled'],
          completed: ['integrated', 'reconciled', 'blocked'],
          failed: ['cancelled'],
          recommended: ['cancelled'],
        };
        assert(
          transitions[action.status]?.includes(update.status),
          `Invalid action transition: ${action.status} -> ${update.status}`
        );
        assert(
          typeof update.evidence === 'string' && update.evidence.trim(),
          'Record an evidence pointer or specific failure reason.'
        );
        if (update.status === 'integrated') {
          assert(action.merge !== 'none', 'Action has no integration authority.');
          assert(
            action.merge !== 'human-first' || update.human_approved === true,
            'Record actual prior human merge approval.'
          );
          assert(
            update.verified_revision === git('rev-parse', 'HEAD').trim(),
            'Integration evidence must name the current HEAD.'
          );
          assert(
            update.checks_passed === true,
            'Integration needs passed relevant checks, not just worker completion.'
          );
          assert(
            typeof action.worker_revision === 'string',
            'Record the completed worker revision before integration.'
          );
          git('merge-base', '--is-ancestor', action.worker_revision, 'HEAD');
        }
        if (update.status === 'completed' && ['implement', 'integrate'].includes(action.kind)) {
          assert(
            typeof update.worker_revision === 'string' && /^[0-9a-f]{40}$/.test(update.worker_revision),
            'Completed code work needs its exact worker commit.'
          );
          action.worker_revision = update.worker_revision;
        }
        if (update.status === 'reconciled')
          assert(
            !['implement', 'integrate'].includes(action.kind),
            'Code actions require integrated revision evidence.'
          );
        Object.assign(action, { status: update.status, evidence: update.evidence, updated: new Date().toISOString() });
        if (update.status === 'running')
          assert(typeof action.threadId === 'string', 'Reconcile a ready worker ID before marking running.');
        if (update.status === 'integrated') action.verified_revision = update.verified_revision;
        return action;
      });
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const api = factory(process.cwd());
    const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
    const result =
      command === 'init'
        ? api.init()
        : command === 'recover'
          ? api.recover(json(args[0]))
          : command === 'inspect'
            ? api.inspect()
            : command === 'recommend'
              ? api.recommend(json(args[0]))
              : command === 'reserve'
                ? api.reserve(args[0])
                : command === 'attach'
                  ? api.attach(args[0], json(args[1]))
                  : command === 'record'
                    ? api.record(args[0], json(args[1]))
                    : (() => {
                        throw Error(
                          'Usage: factory.mjs init|recover FILE|inspect|recommend FILE|reserve ID|attach ID FILE|record ID FILE'
                        );
                      })();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
