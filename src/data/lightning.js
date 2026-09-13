import * as Cesium from 'cesium';

const LIGHTNING_API_URL = '/api/lightning';
const LIGHTNING_UPDATE_MS = 5000;
const LIGHTNING_MAX_AGE_MS = 20 * 60_000;
const LIGHTNING_RENDER_LIMIT = 1200;
const LATEST_STRIKE_COLOR = Cesium.Color.WHITE;
const OLDEST_STRIKE_COLOR = Cesium.Color.RED;

export function normalizeLightningRows(
  payload,
  { nowMs = Date.now(), maxAgeMs = LIGHTNING_MAX_AGE_MS, maxRows = LIGHTNING_RENDER_LIMIT } = {},
) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const cutoff = nowMs - maxAgeMs;
  const seen = new Set();
  const normalized = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const lat = finiteOrNull(row?.lat ?? row?.location?.latitude);
    const lon = finiteOrNull(row?.lon ?? row?.location?.longitude);
    const timeMs = toEpochMs(row?.timeMs ?? row?.time);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) continue;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) continue;
    if (!Number.isFinite(timeMs) || timeMs < cutoff || timeMs > nowMs + 10_000) continue;
    const stableId = String(row?.id || `${Math.trunc(timeMs)}:${lat.toFixed(4)}:${lon.toFixed(4)}:${index}`);
    if (seen.has(stableId)) continue;
    seen.add(stableId);
    normalized.push({
      id: stableId,
      lat,
      lon,
      timeMs: Math.trunc(timeMs),
      deviation: finiteOrNull(row?.deviation),
      delay: finiteOrNull(row?.delay),
      detectors: clampInt(row?.detectors, 0, 128, 0),
      polarity: normalizePolarity(row?.polarity),
      region: Number.isInteger(row?.region) ? row.region : null,
    });
  }
  normalized.sort((a, b) => b.timeMs - a.timeMs || String(a.id).localeCompare(String(b.id)));
  return normalized.slice(0, Math.max(1, Math.floor(maxRows || LIGHTNING_RENDER_LIMIT)));
}

export function lightningPointSize(row) {
  const detectorBoost = Math.sqrt(Math.max(1, Number(row?.detectors) || 1));
  let size = 4 + detectorBoost * 2.2;
  const deviation = finiteOrNull(row?.deviation);
  if (Number.isFinite(deviation)) {
    if (deviation <= 5000) size += 1.5;
    else if (deviation >= 20_000) size -= 1;
  }
  return Math.max(3.5, Math.min(14, size));
}

export function lightningPointColor(row, nowMs = Date.now()) {
  const ageMs = Math.max(0, nowMs - Number(row?.timeMs || nowMs));
  const ageRatio = Math.min(1, ageMs / LIGHTNING_MAX_AGE_MS);
  return Cesium.Color.lerp(
    LATEST_STRIKE_COLOR,
    OLDEST_STRIKE_COLOR,
    ageRatio,
    new Cesium.Color(),
  );
}

const lightningLayer = {
  id: 'lightning',
  name: 'Live Lightning',
  icon: '⚡',
  source: 'Blitzortung',
  updateInterval: LIGHTNING_UPDATE_MS,

  init(viewer) {
    state.viewer = viewer;
    state.dataSource = new Cesium.CustomDataSource('lightning');
    state.dataSource.show = false;
    viewer.dataSources.add(state.dataSource);
    state.enabled = false;
    state.loading = false;
    state.count = 0;
    state.lastUpdate = null;
    state.error = null;
    state.transportStatus = null;
    state.lastMessageAt = null;
    state.nextAttemptAt = null;
  },

  enable() {
    state.enabled = true;
    if (state.dataSource) state.dataSource.show = true;
  },

  disable() {
    state.enabled = false;
    state.loading = false;
    if (state.dataSource) state.dataSource.show = false;
  },

  async update() {
    if (!state.enabled || !state.dataSource) return false;
    state.loading = true;
    try {
      const signal = typeof AbortSignal?.timeout === 'function'
        ? AbortSignal.timeout(10_000)
        : undefined;
      const response = await fetch(LIGHTNING_API_URL, {
        cache: 'no-store',
        signal,
      });
      if (!response.ok) {
        state.error = `Lightning HTTP ${response.status}`;
        return false;
      }
      const payload = await response.json();
      const nowMs = Date.now();
      const rows = normalizeLightningRows(payload, {
        nowMs,
        maxRows: LIGHTNING_RENDER_LIMIT,
      });
      const nextEntities = [];
      for (const row of rows) {
        const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat, 1200);
        nextEntities.push(new Cesium.Entity({
          id: `lightning:${row.id}`,
          position,
          point: {
            pixelSize: lightningPointSize(row),
            color: lightningPointColor(row, nowMs),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.35),
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: {
            timeMs: row.timeMs,
            deviation: row.deviation,
            delay: row.delay,
            detectors: row.detectors,
            polarity: row.polarity,
            region: row.region,
          },
        }));
      }
      state.dataSource.entities.removeAll();
      for (const entity of nextEntities) state.dataSource.entities.add(entity);
      state.count = rows.length;
      state.lastUpdate = nowMs;
      state.transportStatus = typeof payload?.status === 'string'
        ? payload.status
        : null;
      state.lastMessageAt = toEpochMs(payload?.lastMessageAt);
      state.nextAttemptAt = finiteOrNull(payload?.nextAttemptAt);
      state.error = lightningFeedError(payload, rows.length);
      state.stale = state.transportStatus && state.transportStatus !== 'live' && rows.length > 0;
      return true;
    } catch (error) {
      if (error?.name !== 'AbortError') {
        state.error = error?.message || 'Lightning fetch error';
      } else {
        state.error = 'Lightning request timed out';
      }
      return false;
    } finally {
      state.loading = false;
    }
  },

  destroy(viewer) {
    state.enabled = false;
    state.loading = false;
    if (state.dataSource && viewer) {
      viewer.dataSources.remove(state.dataSource, true);
      state.dataSource = null;
    }
    state.viewer = null;
    state.count = 0;
    state.lastUpdate = null;
    state.error = null;
    state.transportStatus = null;
    state.lastMessageAt = null;
    state.nextAttemptAt = null;
    state.stale = false;
  },

  getStats() {
    return {
      count: state.count,
      lastUpdate: state.lastUpdate,
      loading: state.loading,
      error: state.error,
      stale: state.stale,
      status: state.error && state.count === 0 ? 'unavailable' : undefined,
      transportStatus: state.transportStatus,
      lastMessageAt: state.lastMessageAt,
      retryInSec: retryInSec(state.nextAttemptAt),
    };
  },
};

const state = {
  viewer: null,
  dataSource: null,
  enabled: false,
  loading: false,
  count: 0,
  lastUpdate: null,
  error: null,
  stale: false,
  transportStatus: null,
  lastMessageAt: null,
  nextAttemptAt: null,
};

export default lightningLayer;

function lightningFeedError(payload, rowCount) {
  const status = typeof payload?.status === 'string' ? payload.status : '';
  const detail = typeof payload?.error === 'string' && payload.error.trim()
    ? payload.error.trim()
    : null;
  if (status === 'live') return rowCount > 0 ? null : 'awaiting first strike...';
  if (status === 'connecting') return detail || 'connecting to Blitzortung...';
  if (status === 'reconnecting') {
    const retry = retryInSec(payload?.nextAttemptAt);
    if (retry > 0) return `reconnecting to Blitzortung in ${retry}s...`;
    return detail || 'reconnecting to Blitzortung...';
  }
  if (status === 'unsupported') return detail || 'lightning feed unsupported';
  if (status === 'idle') return rowCount > 0 ? null : 'connecting to Blitzortung...';
  if (detail) return detail;
  return rowCount > 0 ? null : 'awaiting first strike...';
}

function retryInSec(nextAttemptAt) {
  const at = Number(nextAttemptAt);
  if (!Number.isFinite(at) || at <= 0) return 0;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.trunc(number);
  return Math.max(min, Math.min(max, rounded));
}

function normalizePolarity(value) {
  const number = Number(value);
  return number === 0 || number === 1 ? number : null;
}

function toEpochMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value > 1e12 ? value : value > 1e9 ? value * 1000 : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric > 1e12 ? numeric : numeric > 1e9 ? numeric * 1000 : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

