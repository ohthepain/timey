import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Serve candidate assets with disposable data. No real issue or worker can be changed.
export function browserFixture(root) {
  const lifecycle = [
    ['ready-for-grilling', 'backlog', 'qa', 'Clarify'],
    ['closed', 'closed', '—', 'Closed'],
    ['custom', 'qa', 'closed', 'QA'],
  ].map(([role, state, next, name]) => ({ role, state, next, name, exit: 'Fixture stage' }));
  const priorities = ['Urgent', 'Major', 'Low'].map((name, index) => ({
    id: name.toLowerCase(),
    name,
    color: ['#ff0000', '#eab308', '#22c55e'][index],
    meaning: 'Fixture priority',
  }));
  const issues = [
    ['b', 'Older urgent issue', 'backlog', 0, '2026-01-01', '2026-03-01'],
    ['a', 'Newer low issue', 'qa', 2, '2026-02-01', '2026-01-01'],
    ['c', 'Newest closed issue', 'closed', 1, '2026-03-01', '2026-02-01'],
    ['x', 'Unknown metadata', 'unknown', -1, 'invalid', null],
  ].map(([id, title, state, index, created, updated]) => ({
    id,
    title,
    state,
    created,
    updated,
    content: 'Browser fixture only',
    workingGit: id === 'b' ? { branch: 'codex/example-work', revision: '12345678' + 'a'.repeat(32) } : null,
    links: { parent: [], related: [], depends: [] },
    stage: state,
    strategy: {
      strategy: 'full-stop',
      solRounds: 0,
      status: 'queued',
      active: false,
      basis: 'fixture-basis',
      repository: 'fixture/timey',
      target: 'main',
    },
    modelSelection: { model: '', effort: '', effectiveModel: 'gpt-6-luna', effectiveEffort: 'medium' },
    priorityInfo: { ...(priorities[index] || { name: 'Unknown', color: '#888888' }), index, basis: 'fixture' },
    queueLifecycle: { roles: lifecycle.map((s) => ({ ...s, label: 'Fixture stage', status: 'idle', future: false })) },
  }));
  const data = {
    root: '/synthetic-browser-fixture',
    head: '0'.repeat(40),
    lifecycle,
    priorities,
    modelSettings: {
      defaults: { model: 'gpt-6-luna', effort: 'medium' },
      models: [
        { id: 'gpt-6-luna', name: 'GPT-6 Luna', description: 'Fast and efficient for focused, frequent work.' },
        {
          id: 'gpt-6.1-sol',
          name: 'GPT-6.1 Sol',
          description: 'Near-Astra capability for complex work at lower cost.',
        },
        {
          id: 'gpt-6.1-terra',
          name: 'GPT-6.1 Terra',
          description: 'Fast visual reasoning, precise computer use, and clear writing.',
        },
        {
          id: 'gpt-6-astra',
          name: 'GPT-6 Astra',
          description: 'The most capable choice for demanding reasoning and coding.',
        },
      ],
      efforts: ['low', 'medium', 'high', 'max'],
    },
    issues,
    actions: [],
    runs: [],
    closureReasons: [],
    sourceClean: true,
    registryPresent: true,
  };
  const ui = join(root, 'scripts/factory-ui');
  const page = readFileSync(join(ui, 'index.html'), 'utf8');
  const assets = new Set(['index.html', ...[...page.matchAll(/<script src="\/([^"]+)"/g)].map((match) => match[1])]);
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      response.setHeader('Content-Type', 'application/json');
      if (request.method !== 'GET') {
        let text = '';
        for await (const chunk of request) text += chunk;
        const value = JSON.parse(text || '{}');
        if (url.pathname === '/api/model-settings') {
          data.modelSettings.defaults = { model: value.model, effort: value.effort };
          return response.end(JSON.stringify(data.modelSettings));
        }
        if (url.pathname === '/api/issue-model-settings') {
          const issue = issues.find((entry) => entry.id === value.issueId);
          if (issue) {
            issue.modelSelection = {
              model: value.model,
              effort: value.effort,
              effectiveModel: value.model || data.modelSettings.defaults.model,
              effectiveEffort: value.effort || data.modelSettings.defaults.effort,
            };
          }
          return response.end('{}');
        }
        response.statusCode = 405;
        return response.end('{"error":"Fixture cannot launch work or save issues"}');
      }
      if (url.pathname === '/api/queue') return response.end(JSON.stringify(data));
      if (url.pathname === '/api/runtime')
        return response.end(
          JSON.stringify({ mode: 'preview', project: data.root, checkout: root, revision: data.head })
        );
      if (url.pathname === '/api/issue-chat') return response.end('{"messages":[],"totalMessages":0}');
      if (url.pathname === '/api/fixture-update') {
        issues[1].updated = '2026-04-01';
        return response.end('{}');
      }
      response.statusCode = 404;
      return response.end('{}');
    }
    if (url.pathname === '/favicon.ico') {
      response.statusCode = 204;
      return response.end();
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!assets.has(file) || file.includes('/') || file.includes('..')) {
      response.statusCode = 404;
      return response.end();
    }
    response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : 'text/javascript');
    response.end(readFileSync(join(ui, file)));
  });
}
