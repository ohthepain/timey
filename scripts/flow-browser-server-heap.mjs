import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getHeapStatistics } from 'node:v8';

const heapPath = '/api/server-heap';
const mib = 1024 ** 2;
const gib = 1024 ** 3;

function assertReadableSize(text, bytes) {
  const [amount, unit] = text.split(' ');
  assert.equal(unit, bytes >= gib ? 'GiB' : 'MiB');
  const unitBytes = unit === 'GiB' ? gib : mib;
  const tolerance = unit === 'GiB' ? gib / 20 : mib / 2;
  assert.ok(Math.abs(Number(amount) * unitBytes - bytes) <= tolerance);
}

export async function serverHeapBrowserChecks({ page, output, poll, screenshot }) {
  const header = page.locator('header .server-heap');
  const nextHeapResponse = (documentPath = '/') =>
    page.waitForResponse(
      (response) => response.url().endsWith(heapPath) && new URL(response.frame().url()).pathname === documentPath
    );
  const expectedLimitBytes = getHeapStatistics().heap_size_limit;
  const readSample = async (pendingResponse, precedingLabel) => {
    const response = await pendingResponse;
    assert.equal(response.status(), 200);
    const { usedBytes, limitBytes } = await response.json();
    assert.ok(usedBytes > 0);
    assert.equal(limitBytes, expectedLimitBytes);
    const label = await poll(
      () => header.textContent(),
      (value) => /^Heap [\d.]+ (MiB|GiB) \/ [\d.]+ (MiB|GiB)$/.test(value) && value !== precedingLabel,
      'The shared header did not display the new heap sample.'
    );
    assert.equal(await header.isVisible(), true);
    const [used, limit] = label.slice(5).split(' / ');
    assertReadableSize(used, usedBytes);
    assertReadableSize(limit, limitBytes);
    return { label, usedBytes, limitBytes, navigationTime: await page.evaluate(() => performance.timeOrigin) };
  };

  const initialResponse = nextHeapResponse();
  await page.goto('/');
  const initial = await readSample(initialResponse);
  const refreshResponse = nextHeapResponse();
  const allocation = Array.from({ length: 4 * mib }, (_, index) => index);
  const refreshed = await readSample(refreshResponse, initial.label);
  assert.equal(allocation.at(-1), 4 * mib - 1);
  assert.equal(refreshed.navigationTime, initial.navigationTime);
  await screenshot('server-heap-live');

  await page.route('**' + heapPath, (route) =>
    route.fulfill({ status: 503, json: { error: 'The test made the heap reading unavailable.' } })
  );
  try {
    assert.equal((await nextHeapResponse()).status(), 503);
    await page.locator('header').getByText('Heap unavailable', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => performance.timeOrigin), initial.navigationTime);
    await screenshot('server-heap-unavailable');
  } finally {
    await page.unroute('**' + heapPath);
  }
  const recovered = await readSample(nextHeapResponse());
  assert.equal(recovered.navigationTime, initial.navigationTime);

  const classicResponse = nextHeapResponse('/classic');
  const classicQueue = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/queue');
  await page.goto('/classic');
  const classic = await readSample(classicResponse);
  const queue = await classicQueue;
  assert.equal(queue.status(), 200, await queue.text());
  writeFileSync(
    join(output, 'server-heap.json'),
    JSON.stringify(
      {
        serverPid: process.pid,
        expectedLimitBytes,
        initial,
        refreshed,
        unavailable: 'Heap unavailable',
        recovered,
        classic,
      },
      null,
      2
    ) + '\n'
  );
}
