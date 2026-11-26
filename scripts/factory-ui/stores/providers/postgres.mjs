import { createFactoryPool } from '../postgres-connection.mjs';
import { checkExpected, verifyReceipt, retireReceipt } from './records.mjs';

export async function openPostgresRecords(config, { root, projectId, readOnly }) {
  const pool = createFactoryPool(config, { root });
  try {
    if (!readOnly)
      await pool.query(`CREATE SCHEMA IF NOT EXISTS factory;
      CREATE TABLE IF NOT EXISTS factory.store_records (
        project_id text NOT NULL, store_id text NOT NULL, key text NOT NULL,
        revision text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(project_id, store_id, key));
      CREATE TABLE IF NOT EXISTS factory.store_operations (
        project_id text NOT NULL, store_id text NOT NULL, operation_id text NOT NULL,
        receipt jsonb NOT NULL, PRIMARY KEY(project_id, store_id, operation_id));`);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const scope = [projectId, config.id];
  function record(row) {
    return row ? { key: row.key, revision: row.revision, value: row.value } : null;
  }
  async function get(target, key) {
    return record(
      (
        await target.query(
          'SELECT key, revision, value FROM factory.store_records WHERE project_id=$1 AND store_id=$2 AND key=$3',
          [...scope, key]
        )
      ).rows[0]
    );
  }
  async function list(target, prefix) {
    return (
      await target.query(
        `SELECT key, revision, value FROM factory.store_records
      WHERE project_id=$1 AND store_id=$2 AND starts_with(key,$3) ORDER BY key`,
        [...scope, prefix]
      )
    ).rows.map(record);
  }
  async function operation(target, id) {
    return (
      (
        await target.query(
          'SELECT receipt FROM factory.store_operations WHERE project_id=$1 AND store_id=$2 AND operation_id=$3',
          [...scope, id]
        )
      ).rows[0]?.receipt ?? null
    );
  }
  async function transaction(begin, work) {
    const client = await pool.connect();
    try {
      await client.query(begin);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async function visitPages(client, statement, visit, params = []) {
    let after = '';
    for (;;) {
      const { rows } = await client.query(statement, [...scope, after, ...params]);
      if (!rows.length) return;
      for (const row of rows) await visit(row);
      after = rows.at(-1).id;
    }
  }
  function visitPrefix(client, prefix, visit) {
    return visitPages(
      client,
      `SELECT key AS id,key,revision,value FROM factory.store_records
       WHERE project_id=$1 AND store_id=$2 AND key>$3 AND starts_with(key,$4) ORDER BY key LIMIT 16`,
      (row) => visit(record(row)),
      [prefix]
    );
  }
  async function scanRetained(client, { visitRecord, visitReceipt }) {
    await visitPrefix(client, '', visitRecord);
    await visitPages(
      client,
      `SELECT operation_id AS id,receipt FROM factory.store_operations
       WHERE project_id=$1 AND store_id=$2 AND operation_id>$3 ORDER BY operation_id LIMIT 16`,
      visitReceipt
    );
    return { records: [], receipts: [] };
  }
  async function readRetained(client) {
    const records = await list(client, '');
    const receipts = (
      await client.query(
        'SELECT operation_id AS id,receipt FROM factory.store_operations WHERE project_id=$1 AND store_id=$2 ORDER BY operation_id',
        scope
      )
    ).rows;
    return { records, receipts };
  }
  function writeOperation(request, change) {
    return transaction('BEGIN', async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(scope)]);
      const prior = await operation(client, request.operationId);
      if (prior) return verifyReceipt(prior, request.inputDigest);
      await change(client);
      await client.query(
        'INSERT INTO factory.store_operations(project_id,store_id,operation_id,receipt) VALUES($1,$2,$3,$4::jsonb)',
        [...scope, request.operationId, JSON.stringify(request.receipt)]
      );
      return request.receipt;
    });
  }
  return {
    inlineLimit: 1_048_576,
    receipt: (id) => operation(pool, id),
    retainedPayloads(visitors) {
      return transaction('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', (client) =>
        visitors ? scanRetained(client, visitors) : readRetained(client)
      );
    },
    retireReceipts(request) {
      return writeOperation(request, async (client) => {
        for (const item of request.receipts) {
          const retired = retireReceipt(await operation(client, item.id), item, request);
          await client.query(
            'UPDATE factory.store_operations SET receipt=$4::jsonb WHERE project_id=$1 AND store_id=$2 AND operation_id=$3',
            [...scope, item.id, JSON.stringify(retired)]
          );
        }
      });
    },
    readSnapshot(read) {
      return transaction('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', (client) =>
        read({
          get: (key) => get(client, key),
          list: (prefix) => list(client, prefix),
          visit: (prefix, visit) => visitPrefix(client, prefix, visit),
        })
      );
    },
    get: (key) => get(pool, key),
    list: (prefix) => list(pool, prefix),
    commit(request) {
      return writeOperation(request, async (client) => {
        const rows = await client.query(
          'SELECT key, revision, value FROM factory.store_records WHERE project_id=$1 AND store_id=$2 AND key=ANY($3::text[])',
          [...scope, request.expected.map((item) => item.key)]
        );
        checkExpected(request.expected, new Map(rows.rows.map((row) => [row.key, record(row)])));
        for (const { key, record: next } of request.writes) {
          if (next)
            await client.query(
              `INSERT INTO factory.store_records(project_id,store_id,key,revision,value) VALUES($1,$2,$3,$4,$5::jsonb)
             ON CONFLICT(project_id,store_id,key) DO UPDATE SET revision=EXCLUDED.revision,value=EXCLUDED.value`,
              [...scope, key, next.revision, JSON.stringify(next.value)]
            );
          else
            await client.query('DELETE FROM factory.store_records WHERE project_id=$1 AND store_id=$2 AND key=$3', [
              ...scope,
              key,
            ]);
        }
      });
    },
    close: () => pool.end(),
  };
}
