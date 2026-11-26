import { fixtureRoute } from './flow-browser-routes.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getHeapStatistics } from 'node:v8';

const heapPath = '/api/server-heap';
const mib = 1024 ** 2;
const gib = 1024 ** 3;

function assertReadableSize(text, bytes, diagnostic) {
  const [amount, unit] = text.split(' ');
  assert.equal(unit, bytes >= gib ? 'GiB' : 'MiB', diagnostic);
  const unitBytes = unit === 'GiB' ? gib : mib;
  const tolerance = unit === 'GiB' ? gib / 20 : mib / 2;
  assert.ok(Math.abs(Number(amount) * unitBytes - bytes) <= tolerance, diagnostic);
}

function observeHeapSamples(page) {
  return page.addInitScript((path) => {
    const originalFetch = window.fetch;
    const samples = [];
    window.heapBrowserSamples = samples;
    window.stopHeapBrowserObserver = () => {
      window.fetch = originalFetch;
      delete window.heapBrowserSamples;
      delete window.stopHeapBrowserObserver;
    };
    window.fetch = async function (...args) {
      if (args[0] !== path) return originalFetch.apply(this, args);
      const response = await originalFetch.apply(this, args);
      const bytes = response.ok ? await response.clone().json() : {};
      const reading = document.querySelector('header .server-heap');
      const sample = { ...bytes, status: response.status, navigationTime: performance.timeOrigin, label: null };
      samples.push(sample);
      // The heap poll writes the header before scheduling its next request.
      const observer = new MutationObserver(() => {
        sample.label = reading.textContent;
        observer.disconnect();
      });
      observer.observe(reading, { childList: true });
      return response;
    };
  }, heapPath);
}

export async function serverHeapBrowserChecks({ page, output, poll, screenshot }) {
  const header = page.locator('header .server-heap');
  const expectedLimitBytes = getHeapStatistics().heap_size_limit;
  const sampleObserver = await observeHeapSamples(page);

  const readSample = async (select, status = 200) => {
    const { sample } = await poll(
      async () => {
        const samples = await page.evaluate(() => window.heapBrowserSamples);
        return { sample: select(samples), renderedLabel: await header.textContent() };
      },
      ({ sample }) => sample?.label != null,
      'The header did not render the selected heap response.'
    );
    const { label, usedBytes, limitBytes } = sample;
    const diagnostic = JSON.stringify({ usedBytes, limitBytes, renderedLabel: label });
    assert.equal(sample.status, status, diagnostic);
    assert.ok(await header.isVisible(), diagnostic);
    if (status === 503) {
      assert.equal(label, 'Heap unavailable', diagnostic);
    } else {
      assert.ok(usedBytes > 0, diagnostic);
      assert.equal(limitBytes, expectedLimitBytes, diagnostic);
      assert.match(label, /^Heap [\d.]+ (MiB|GiB) \/ [\d.]+ (MiB|GiB)$/, diagnostic);
      const [used, limit] = label.slice(5).split(' / ');
      assertReadableSize(used, usedBytes, diagnostic);
      assertReadableSize(limit, limitBytes, diagnostic);
    }
    return sample;
  };

  const heapRoute = '**' + heapPath;
  const sameLabelBytes = [mib, mib + 1];
  const fixtures = [
    ...sameLabelBytes.map((usedBytes) => ({ status: 200, json: { usedBytes, limitBytes: expectedLimitBytes } })),
    { status: 503, json: { error: 'The test made the heap reading unavailable.' } },
  ];
  const fulfillFixture = (route) => route.fulfill(fixtures.shift());
  let removeHeap;
  try {
    await page.goto('/');
    const initial = await readSample((samples) => samples[0]);
    const refreshed = await readSample((samples) => samples[1]);
    assert.equal(refreshed.navigationTime, initial.navigationTime);
    await screenshot('server-heap-live');

    removeHeap = await fixtureRoute(page, heapRoute, fulfillFixture, { times: fixtures.length });
    const firstRounded = (samples) => samples.findIndex(({ usedBytes }) => usedBytes === sameLabelBytes[0]);
    const sameLabel = [
      await readSample((samples) => samples[firstRounded(samples)]),
      await readSample((samples) => {
        const index = firstRounded(samples);
        return index >= 0 ? samples[index + 1] : undefined;
      }),
    ];
    assert.deepEqual(
      sameLabel.map(({ usedBytes }) => usedBytes),
      sameLabelBytes
    );
    assert.equal(sameLabel[0].label, sameLabel[1].label);
    for (const sample of sameLabel) assert.equal(sample.navigationTime, initial.navigationTime);

    const unavailable = await readSample((samples) => samples.find(({ status }) => status === 503), 503);
    assert.equal(unavailable.navigationTime, initial.navigationTime);
    await screenshot('server-heap-unavailable');
    const recovered = await readSample((samples) => {
      const index = samples.findIndex(({ status }) => status === 503);
      return index >= 0 ? samples[index + 1] : undefined;
    });
    assert.equal(recovered.navigationTime, initial.navigationTime);

    writeFileSync(
      join(output, 'server-heap.json'),
      JSON.stringify(
        {
          serverPid: process.pid,
          expectedLimitBytes,
          initial,
          refreshed,
          sameLabel,
          unavailable: unavailable.label,
          recovered,
        },
        null,
        2
      ) + '\n'
    );
  } finally {
    await removeHeap?.();
    await sampleObserver.dispose();
    await page.evaluate(() => window.stopHeapBrowserObserver?.());
  }
}
