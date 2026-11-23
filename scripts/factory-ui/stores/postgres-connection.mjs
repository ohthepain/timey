import pg from 'pg';
import { readProjectEnv } from '../project-env.mjs';
import { assertStore, storeError } from './providers/records.mjs';

function postgresFailure(error) {
  if (error.code?.startsWith('STORE_')) return error;
  const code =
    typeof error.code === 'string' && /^(?:[A-Z0-9]{5}|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET)$/.test(error.code)
      ? error.code
      : 'STORE_UNAVAILABLE';
  return storeError(code, `The dedicated Factory database operation failed (${code}).`);
}

function environment(root) {
  return { ...readProjectEnv(root), ...process.env };
}
function parsedOptions(config, env) {
  const url = config.connectionString || config.url || env[config.urlEnv || 'FACTORY_ISSUES_DB_URL'];
  assertStore(
    typeof url === 'string' && /^postgres(?:ql)?:\/\//.test(url),
    'Configure a dedicated Factory Postgres connection reference.'
  );
  try {
    const parsed = new pg.Client({ connectionString: url }).connectionParameters;
    return {
      ...parsed,
      password: parsed.password,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 1000,
      ...(env[config.userEnv || 'FACTORY_DB_USER'] && { user: env[config.userEnv || 'FACTORY_DB_USER'] }),
      ...(env[config.passwordEnv || 'FACTORY_DB_PASSWORD'] && {
        password: env[config.passwordEnv || 'FACTORY_DB_PASSWORD'],
      }),
    };
  } catch {
    throw storeError('STORE_INVALID', 'The Factory database connection is invalid.');
  }
}

function assertDedicatedDatabase(database, env) {
  assertStore(
    database && !['postgres', 'template0', 'template1'].includes(database),
    'Factory storage requires its own dedicated database.'
  );
  for (const key of ['DATABASE_URL', 'AUTH_DATABASE_URL']) {
    if (!env[key]) continue;
    let installed;
    try {
      installed = new pg.Client({ connectionString: env[key] }).connectionParameters;
    } catch {
      throw storeError('STORE_INVALID', 'The installed application database identity is invalid.');
    }
    assertStore(
      database !== installed.database,
      'Factory must not use the installed application database, including a different schema or credentials.'
    );
  }
}

function connection(config, root) {
  const env = environment(root);
  const options = parsedOptions(config, env);
  const database = new pg.Client(options).connectionParameters.database;
  assertDedicatedDatabase(database, env);
  assertStore(!config.schema || config.schema === 'factory', 'Factory storage uses the dedicated factory schema.');
  return { options, database };
}

function safePool(options) {
  const pool = new pg.Pool(options);
  const clientErrors = new WeakMap();
  pool.on('error', (error, client) => {
    if (client) clientErrors.set(client, postgresFailure(error));
  });
  const query = async (target, args) => {
    try {
      return await target.query(...args);
    } catch (error) {
      throw postgresFailure(error);
    }
  };
  return {
    query(...args) {
      return query(pool, args);
    },
    async connect() {
      let client;
      try {
        client = await pool.connect();
      } catch (error) {
        throw postgresFailure(error);
      }
      return {
        query: (...args) => {
          if (clientErrors.has(client)) return Promise.reject(clientErrors.get(client));
          return query(client, args);
        },
        release: () => client.release(),
      };
    },
    async end() {
      await pool.end();
    },
  };
}

export function createFactoryPool(config = {}, { root }) {
  return safePool(connection(config, root).options);
}

export async function ensureFactoryDatabase({ root, config = {} }) {
  const { options, database } = connection(config, root);
  const target = safePool(options);
  try {
    await target.query('SELECT 1');
    return { created: false, database };
  } catch (error) {
    if (error.code !== '3D000') throw error;
  } finally {
    await target.end();
  }
  const maintenance = safePool({ ...options, database: 'postgres' });
  try {
    const existing = await maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (existing.rowCount) return { created: false, database };
    const quoted = '"' + database.replaceAll('"', '""') + '"';
    try {
      await maintenance.query(`CREATE DATABASE ${quoted}`);
    } catch (error) {
      if (error.code !== '42P04') throw error;
    }
    return { created: true, database };
  } finally {
    await maintenance.end();
  }
}
