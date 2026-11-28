import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { git } from './factory-ui/common.mjs';
import { createFactoryServer } from './factory-ui/http.mjs';
import { FactoryUI } from './factory-ui/service.mjs';

const require = createRequire(import.meta.url);
const playwrightRequire = createRequire(require.resolve('@playwright/cli/package.json'));
const { chromium } = playwrightRequire('playwright');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function postgresFixture(cleanup, output) {
  const reservation = createServer();
  const port = await listen(reservation);
  reservation.close();
  await once(reservation, 'close');
  const data = join(output, 'pgdata');
  execFileSync('initdb', ['-D', data, '-A', 'trust', '-U', 'fixture'], { stdio: 'pipe' });
  const log = join(output, 'postgres.log');
  const options = `-h 127.0.0.1 -p ${port} -c unix_socket_directories=''`;
  execFileSync('pg_ctl', ['-D', data, '-l', log, '-o', options, '-w', 'start']);
  cleanup.unshift(() => {
    execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    rmSync(data, { recursive: true });
  });
  const connectionString = (database) => `postgresql://fixture@127.0.0.1:${port}/${database}`;
  const admin = new pg.Client({ connectionString: connectionString('postgres') });
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE usage_fixture');
  } finally {
    await admin.end();
  }
  return connectionString('usage_fixture');
}

async function makeTables(db) {
  await db.query(`CREATE SCHEMA factory;
    CREATE TABLE factory.store_records (id int PRIMARY KEY, value text);
    CREATE TABLE factory.store_operations (id int PRIMARY KEY);
    CREATE TABLE public.store_records AS SELECT * FROM generate_series(1, 200000);
    CREATE TABLE factory.unrelated AS SELECT * FROM generate_series(1, 10000);
    INSERT INTO factory.store_records SELECT value, md5(value::text) FROM generate_series(1, 4000) AS value;`);
}

async function postgresSizes(db) {
  const total = (await db.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS size')).rows[0].size;
  const { rows } = await db.query(`SELECT name, bytes, indexes, pg_size_pretty(bytes + indexes) AS size
    FROM (SELECT name, pg_table_size(('factory.' || name)::regclass) AS bytes,
          pg_indexes_size(('factory.' || name)::regclass) AS indexes
          FROM (VALUES ('store_records'), ('store_operations')) AS tables(name)) AS usage
    ORDER BY bytes + indexes DESC`);
  assert.notEqual(rows.find(({ name }) => name === 'store_records').indexes, '0');
  return { total, tables: rows };
}

async function compareDisplay(section, expected) {
  const total = 'Database total · ' + expected.total;
  await section.getByText(total, { exact: true }).waitFor();
  const tables = await section.getByRole('listitem').allTextContents();
  assert.deepEqual(
    tables,
    expected.tables.map(({ name, size }) => `${name} · ${size}`)
  );
  return { postgres: expected, displayed: { total, tables } };
}

function projectFixture(output, connectionString) {
  const project = join(output, 'project');
  mkdirSync(join(project, '.issues'), { recursive: true });
  git(project, 'init', '-q', '-b', 'dev');
  writeFileSync(
    join(project, '.env'),
    `FACTORY_USAGE_TEST_DB_URL=${connectionString}\nFACTORY_USAGE_TEST_DB_USER=fixture\n`
  );
  writeFileSync(
    join(project, '.issues/stores.json'),
    JSON.stringify({
      version: 1,
      projectId: 'disk-usage-fixture',
      issueDefault: 'fixture',
      coordination: 'fixture',
      artifacts: 'fixture',
      stores: [
        {
          id: 'fixture',
          kind: 'postgres',
          label: 'Usage fixture',
          urlEnv: 'FACTORY_USAGE_TEST_DB_URL',
          userEnv: 'FACTORY_USAGE_TEST_DB_USER',
          passwordEnv: 'FACTORY_USAGE_TEST_DB_PASSWORD',
        },
      ],
    })
  );
  return project;
}

test('Issue Storage reads current indexed PostgreSQL sizes on open and refresh', async (context) => {
  const cleanup = [];
  context.after(async () => {
    for (const close of cleanup) await close();
  });
  const evidence = join(import.meta.dirname, '../.issues/evidence');
  mkdirSync(evidence, { recursive: true });
  const output = mkdtempSync(join(evidence, 'postgres-disk-usage-'));
  const connectionString = await postgresFixture(cleanup, output);
  const db = new pg.Client({ connectionString });
  await db.connect();
  cleanup.unshift(() => db.end());
  await makeTables(db);
  const project = projectFixture(output, connectionString);
  const server = createFactoryServer(new FactoryUI(project, { preview: true }), { projectAccountOrigin: '' });
  const port = await listen(server);
  cleanup.unshift(() => {
    server.closeAllConnections();
    server.close();
  });
  const browser = await chromium.launch({ channel: 'chrome' });
  cleanup.unshift(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  const settings = page.locator('#project-settings-view');
  const open = async () => {
    await page.locator('#project-settings').click();
    await settings.getByRole('link', { name: 'Issue Storage', exact: true }).click();
  };
  const usage = settings.getByRole('group', { name: 'Usage fixture · postgres' }).locator('[data-store-usage]');
  const original = await postgresSizes(db);
  await open();
  const opened = await compareDisplay(usage, original);
  assert.equal(opened.postgres.tables[0].name, 'store_records');

  await db.query('INSERT INTO factory.store_operations SELECT generate_series(1, 30000)');
  const grown = await postgresSizes(db);
  assert.notEqual(grown.total, original.total);
  assert.equal(grown.tables[0].name, 'store_operations');
  await usage.getByRole('button', { name: 'Refresh' }).click();
  const refreshed = await compareDisplay(usage, grown);

  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await db.query('INSERT INTO factory.store_operations SELECT generate_series(30001, 60000)');
  const latest = await postgresSizes(db);
  assert.notEqual(latest.total, grown.total);
  await open();
  const reopened = await compareDisplay(usage, latest);
  await page.screenshot({ path: join(output, 'postgres-disk-usage.png'), fullPage: true });
  const proof = join(output, 'postgres-disk-usage.json');
  writeFileSync(proof, JSON.stringify({ opened, refreshed, reopened }, null, 2) + '\n');
  console.log(`Postgres disk usage evidence: ${proof}`);
});
