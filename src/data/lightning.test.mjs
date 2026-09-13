import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import lightningLayer, {
  lightningPointColor,
  lightningPointSize,
  normalizeLightningRows,
} from './lightning.js';

test('normalizeLightningRows keeps only valid, recent rows and sorts newest-first', () => {
  const nowMs = 1_760_000_000_000;
  const payload = {
    rows: [
      { id: 'old', lat: 10, lon: 20, timeMs: nowMs - 25 * 60_000 },
      { id: 'bad-lat', lat: 120, lon: 20, timeMs: nowMs - 1000 },
      { id: 'b', lat: 11, lon: 21, timeMs: nowMs - 2000, detectors: 4, polarity: 1 },
      { id: 'a', lat: 12, lon: 22, timeMs: nowMs - 1000, detectors: 8, polarity: 0 },
      { id: 'a', lat: 12, lon: 22, timeMs: nowMs - 1000, detectors: 8, polarity: 0 },
    ],
  };

  const rows = normalizeLightningRows(payload, { nowMs, maxRows: 10 });
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b']);
  assert.equal(rows[0].timeMs > rows[1].timeMs, true);
});

test('lightning point sizing and age color gradient stay bounded', () => {
  const nowMs = 1_760_000_000_000;
  const fresh = { timeMs: nowMs - 1000, detectors: 16, polarity: 1, deviation: 3000 };
  const old = { timeMs: nowMs - 19 * 60_000, detectors: 1, polarity: 0, deviation: 30_000 };

  const freshColor = lightningPointColor(fresh, nowMs);
  const oldColor = lightningPointColor(old, nowMs);
  assert.ok(freshColor.green > oldColor.green);
  assert.ok(freshColor.blue > oldColor.blue);
  assert.equal(freshColor.red, 1);
  assert.equal(oldColor.red, 1);

  const big = lightningPointSize({ detectors: 64, deviation: 1000 });
  const small = lightningPointSize({ detectors: 1, deviation: 30_000 });
  assert.ok(big > small);
  assert.ok(big <= 14);
  assert.ok(small >= 3.5);
});

test('lightning layer lifecycle refreshes entities from /api/lightning payload', async () => {
  const originalFetch = globalThis.fetch;
  const dataSources = [];
  const viewer = {
    dataSources: {
      add(dataSource) {
        dataSources.push(dataSource);
        return dataSource;
      },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
  };

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      status: 'live',
      rows: [
        {
          id: 'strike-1',
          lat: 30.2672,
          lon: -97.7431,
          timeMs: Date.now() - 500,
          detectors: 7,
          polarity: 1,
          deviation: 4200,
        },
      ],
    }),
  });

  try {
    lightningLayer.init(viewer);
    lightningLayer.enable(viewer);
    const updated = await lightningLayer.update(viewer);
    assert.equal(updated, true);
    assert.equal(dataSources.length, 1);
    assert.equal(dataSources[0].entities.values.length, 1);
    const [entity] = dataSources[0].entities.values;
    assert.ok(entity.position instanceof Cesium.ConstantPositionProperty);
    assert.equal(lightningLayer.getStats().count, 1);

    lightningLayer.disable(viewer);
    assert.equal(dataSources[0].show, false);

    lightningLayer.destroy(viewer);
    assert.equal(dataSources.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

