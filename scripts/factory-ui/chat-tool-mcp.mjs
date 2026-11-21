import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { digest, requireThat } from './common.mjs';

const maximumBody = 1024 * 1024;
const protocolVersion = '2025-03-26';

class RpcFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function authorized(request, secret) {
  const actual = Buffer.from(String(request.headers.authorization));
  const expected = Buffer.from('Bearer ' + secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function json(response, status, value, sessionId) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  response.writeHead(status, headers);
  response.end(JSON.stringify(value));
}

function empty(response, status) {
  response.writeHead(status, { 'Cache-Control': 'no-store' });
  response.end();
}

function rpcError(id, error) {
  return { jsonrpc: '2.0', id, error: { code: error.code ?? -32603, message: error.message } };
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBody) throw new RpcFailure(-32600, 'The tool request is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RpcFailure(-32700, 'The tool request is not valid JSON.');
  }
}

function checkedRequest(value) {
  requireThat(value?.jsonrpc === '2.0' && typeof value.method === 'string', 'Use a JSON-RPC 2.0 request.');
  if (value.id === undefined) return value;
  requireThat(['string', 'number'].includes(typeof value.id), 'Use a string or number request identity.');
  return value;
}

function newSession(state) {
  const id = randomBytes(24).toString('hex');
  const session = { id, receipts: new Map() };
  state.sessions.set(id, session);
  return session;
}

function selectedSession(request, rpc, state) {
  const id = request.headers['mcp-session-id'];
  if (id) {
    const session = state.sessions.get(id);
    if (!session) throw new RpcFailure(-32001, 'This chat tool session is no longer available.');
    return session;
  }
  if (rpc.method === 'initialize') return newSession(state);
  throw new RpcFailure(-32001, 'Initialize this chat tool session first.');
}

function registry(state) {
  const tools = typeof state.tools === 'function' ? state.tools() : state.tools;
  requireThat(tools && typeof tools.invoke === 'function', 'This chat tool registry is unavailable.');
  return tools;
}

function definitions(state) {
  return registry(state).definitions.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

function initialize(rpc) {
  return {
    protocolVersion: rpc.params?.protocolVersion ?? protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: 'timey-chat', version: '1.0.0' },
  };
}

async function callTool(rpc, state) {
  requireThat(typeof rpc.params?.name === 'string', 'Choose a registered chat tool.');
  try {
    const value = await registry(state).invoke(rpc.params.name, rpc.params.arguments ?? {});
    return toolResult(value);
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) ?? 'null' }] };
}

async function dispatch(rpc, state) {
  const methods = {
    initialize,
    'tools/list': () => ({ tools: definitions(state) }),
    'tools/call': () => callTool(rpc, state),
  };
  const run = Object.hasOwn(methods, rpc.method) && methods[rpc.method];
  if (!run) throw new RpcFailure(-32601, 'Choose a supported chat tool method.');
  return run(rpc);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])])
    );
  return value;
}

function priorReceipt(session, rpc, fingerprint) {
  const receipt = session.receipts.get(JSON.stringify(rpc.id));
  if (!receipt) return null;
  if (receipt.fingerprint !== fingerprint)
    throw new RpcFailure(-32600, 'This tool request identity contains different arguments.');
  if (receipt.status !== 'completed')
    throw new RpcFailure(-32002, 'The original tool request is still uncertain. Inspect it before retrying.');
  return receipt.response;
}

function requireActiveCall(rpc, state) {
  if (rpc.method !== 'tools/call') return;
  if (!state.active())
    throw new RpcFailure(-32003, 'Chat tools can run only during this connection’s active native turn.');
}

async function retainedRequest(session, rpc, state) {
  requireActiveCall(rpc, state);
  const fingerprint = digest(JSON.stringify(canonicalValue([rpc.method, rpc.params])));
  const prior = priorReceipt(session, rpc, fingerprint);
  if (prior) return prior;
  const receipt = { fingerprint, status: 'dispatching' };
  session.receipts.set(JSON.stringify(rpc.id), receipt);
  try {
    receipt.response = { jsonrpc: '2.0', id: rpc.id, result: await dispatch(rpc, state) };
  } catch (error) {
    receipt.response = rpcError(rpc.id, error);
  }
  receipt.status = 'completed';
  return receipt.response;
}

function deleteSession(request, response, state) {
  state.sessions.delete(request.headers['mcp-session-id']);
  empty(response, 204);
}

function failedRequest(response, rpc, session, error) {
  json(response, 200, rpcError(rpc?.id ?? null, error), session?.id);
}

async function postRequest(request, response, state) {
  let rpc;
  let session;
  try {
    rpc = checkedRequest(await requestBody(request));
    session = selectedSession(request, rpc, state);
    if (rpc.id === undefined) return empty(response, 202);
    json(response, 200, await retainedRequest(session, rpc, state), session.id);
  } catch (error) {
    failedRequest(response, rpc, session, error);
  }
}

async function serve(request, response, state) {
  if (!authorized(request, state.secret)) return empty(response, 401);
  if (request.url !== '/mcp') return empty(response, 404);
  const handlers = { POST: postRequest, DELETE: deleteSession };
  const handler = handlers[request.method];
  if (!handler) return empty(response, 405);
  return handler(request, response, state);
}

function closeServer(server, state) {
  state.sessions.clear();
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

export async function createChatToolMcp({ tools, active }) {
  requireThat(typeof active === 'function', 'Bind chat tools to an active native turn.');
  const state = { tools, active, secret: randomBytes(32).toString('hex'), sessions: new Map() };
  const server = createServer((request, response) => {
    serve(request, response, state).catch((error) => json(response, 500, rpcError(null, error)));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = 'http://127.0.0.1:' + server.address().port + '/mcp';
  return {
    args: [
      '-c',
      'mcp_servers.timey_chat.url=' + JSON.stringify(url),
      '-c',
      'mcp_servers.timey_chat.http_headers.Authorization=' + JSON.stringify('Bearer ' + state.secret),
    ],
    close: () => closeServer(server, state),
  };
}
