import { assertStore, storeError } from './records.mjs';

const repositoryIds = new WeakMap();
const mutation = `mutation TimeyMetadata($input: UpdateRefsInput!) {
  updateRefs(input: $input) { clientMutationId }
}`;

async function responseJson(response) {
  if ([401, 403].includes(response.status))
    throw storeError('STORE_PERMISSION', `The metadata request was denied (HTTP ${response.status}).`);
  if (!response.ok)
    throw storeError('STORE_UNAVAILABLE', `The metadata request could not be confirmed (HTTP ${response.status}).`);
  try {
    return await response.json();
  } catch {
    throw storeError('STORE_UNAVAILABLE', 'The metadata request returned an unreadable response.');
  }
}
function checkErrors(result) {
  if ((result.errors || []).some((error) => error.type === 'STALE_DATA'))
    throw storeError('STORE_CONFLICT', 'Shared metadata changed during the operation. Refresh before retrying.');
}
function requireRefUpdate(result, oid) {
  if (result.data?.updateRefs?.clientMutationId !== oid)
    throw storeError('STORE_UNAVAILABLE', 'The metadata reference update could not be confirmed.');
}

async function request(credentials, token, path, body) {
  const response = await credentials.request('https://api.github.com/' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  return responseJson(response);
}
async function repositoryId(credentials, token, repository) {
  if (!repositoryIds.has(credentials)) {
    const pending = request(credentials, token, 'repos/' + repository).then((result) => {
      assertStore(
        String(result.full_name).toLowerCase() === repository.toLowerCase(),
        'The metadata repository identity changed.'
      );
      assertStore(typeof result.node_id === 'string', 'The metadata repository has no node identity.');
      return result.node_id;
    });
    repositoryIds.set(credentials, pending);
    pending.catch(() => repositoryIds.delete(credentials));
  }
  return repositoryIds.get(credentials);
}
function treeEntries(changes) {
  return changes.map(([path, value]) => ({
    path,
    mode: '100644',
    type: 'blob',
    ...(value === null ? { sha: null } : { content: JSON.stringify(value) }),
  }));
}
function requireObject(result, expected, kind) {
  assertStore(result.sha === expected, `The metadata ${kind} differs from its prepared Git object.`);
}

export async function githubMetadataHead({ credentials, repository, branch }) {
  const session = await credentials.session();
  const response = await credentials.request(
    `https://api.github.com/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
    {
      headers: { Authorization: 'Bearer ' + session.token, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30000),
    }
  );
  if (response.status === 404) return null;
  const result = await responseJson(response);
  const object = result.object || {};
  assertStore(
    result.ref === 'refs/heads/' + branch && object.type === 'commit',
    'The metadata reference names another branch or object.'
  );
  assertStore(/^[a-f0-9]{40}$/.test(object.sha), 'The metadata reference has an invalid commit identity.');
  return object.sha;
}

export async function publishGitHubMetadata({ credentials, repository, branch, head, changes, identity }) {
  const session = await credentials.session();
  assertStore(session.permissions.contents === 'write', 'The Factory GitHub App requires Contents write permission.');
  const id = await repositoryId(credentials, session.token, repository);
  const api = (path, body) => request(credentials, session.token, path, body);
  const tree = await api(`repos/${repository}/git/trees`, { base_tree: identity.baseTree, tree: treeEntries(changes) });
  requireObject(tree, identity.tree, 'tree');
  const commit = await api(`repos/${repository}/git/commits`, {
    tree: tree.sha,
    parents: [head],
    message: identity.message,
    author: identity.author,
    committer: identity.committer,
  });
  requireObject(commit, identity.oid, 'commit');
  const result = await api('graphql', {
    query: mutation,
    variables: {
      input: {
        repositoryId: id,
        clientMutationId: commit.sha,
        refUpdates: [{ name: 'refs/heads/' + branch, beforeOid: head, afterOid: commit.sha, force: false }],
      },
    },
  });
  checkErrors(result);
  requireRefUpdate(result, commit.sha);
}
