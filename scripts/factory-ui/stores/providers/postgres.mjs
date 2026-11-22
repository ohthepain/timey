import { createFactoryPool } from '../postgres-connection.mjs';
import { checkExpected, verifyReceipt } from './records.mjs';

export async function openPostgresRecords(config, { root, projectId }) {
  const pool = createFactoryPool(config, { root });
  try {
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
  return {
    async readSnapshot(read) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const result = await read({ get: (key) => get(client, key), list: (prefix) => list(client, prefix) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async get(key) {
      return get(pool, key);
    },
    async list(prefix) {
      return list(pool, prefix);
    },
    async commit(request) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(scope)]);
        const prior = (
          await client.query(
            'SELECT receipt FROM factory.store_operations WHERE project_id=$1 AND store_id=$2 AND operation_id=$3',
            [...scope, request.operationId]
          )
        ).rows[0];
        if (prior) {
          const receipt = verifyReceipt(prior.receipt, request.inputDigest);
          await client.query('COMMIT');
          return receipt;
        }
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
        await client.query(
          'INSERT INTO factory.store_operations(project_id,store_id,operation_id,receipt) VALUES($1,$2,$3,$4::jsonb)',
          [...scope, request.operationId, JSON.stringify(request.receipt)]
        );
        await client.query('COMMIT');
        return request.receipt;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
