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
    links: { parent: [], related: [], depends: [] },
    stage: state,
    priorityInfo: { ...(priorities[index] || { name: 'Unknown', color: '#888888' }), index, basis: 'fixture' },
    queueLifecycle: { roles: lifecycle.map((s) => ({ ...s, label: 'Fixture stage', status: 'idle', future: false })) },
  }));
  const data = {
    root: '/synthetic-browser-fixture',
    head: '0'.repeat(40),
    lifecycle,
    priorities,
    issues,
    actions: [],
    runs: [],
    closureReasons: [],
    sourceClean: true,
    registryPresent: true,
  };
  return createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      response.setHeader('Content-Type', 'application/json');
      if (request.method !== 'GET') {
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
    if (
      ![
        'index.html',
        'server-control-ui.js',
        'queue-lifecycle-ui.js',
        'issue-chat-ui.js',
        'discussion-ui.js',
        'site-review-ui.js',
        'issue-capture-ui.js',
      ].includes(file)
    ) {
      response.statusCode = 404;
      return response.end();
    }
    response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : 'text/javascript');
    response.end(readFileSync(join(root, 'scripts/factory-ui', file)));
  });
}
