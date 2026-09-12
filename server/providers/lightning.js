import { createRequire } from 'node:module';
import { clampInt } from './common/query.js';

const DEFAULT_MAX_ROWS = 400;
export const LIGHTNING_CACHE_MAX = 5000;
export const LIGHTNING_RETENTION_MS = 20 * 60_000;
const LIGHTNING_BACKOFF_MS = [2_000, 5_000, 15_000, 60_000];
const LIGHTNING_TICK_MS = 15_000;

/** Cached newest-first strike rows for /api/lightning snapshots. */
const _lightningRows = [];
let _lightningSequence = 0;
let _lightningClient = null;
let _lightningSocket = null;
let _lightningStatus = 'idle';
let _lightningError = null;
let _lightningLastMessageAt = null;
let _lightningReconnectAttempt = 0;
let _lightningNextAttemptAt = null;
let _lightningRetryTimer = null;
let _lightningTickTimer = null;
let _lightningClientCtor;
let _lightningWebSocketCtor;

export function lightningProxy() {
  function install(middlewares) {
    middlewares.use('/api/lightning', async (req, res) => {
      try {
        ensureLightningConnection();
        const incoming = new URL(req.url || '', 'http://localhost');
        const maxRows = clampInt(
          incoming.searchParams.get('maxRows'),
          1,
          LIGHTNING_CACHE_MAX,
          DEFAULT_MAX_ROWS,
        );
        const rawSince = Number(incoming.searchParams.get('since'));
        const sinceMs = Number.isFinite(rawSince) && rawSince > 0
          ? Math.floor(rawSince)
          : null;
        const rows = lightningRowsSnapshot(maxRows, sinceMs);
        const status = lightningStatusSnapshot();

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(
          JSON.stringify({
            rows,
            source: 'Blitzortung.org',
            retainedMs: LIGHTNING_RETENTION_MS,
            refreshing: status.status !== 'live',
            ...status,
          }),
        );
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(
          JSON.stringify({
            rows: [],
            status: 'error',
            error: error?.message || 'lightning feed error',
          }),
        );
      }
    });
  }

  return {
    name: 'lightning-proxy',
    configureServer(server) {
      install(server.middlewares);
      startLightningTick();
      server.httpServer?.on('close', disposeLightningProxy);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
      startLightningTick();
      server.httpServer?.on('close', disposeLightningProxy);
    },
    closeBundle() {
      disposeLightningProxy();
    },
  };
}

export function normalizeBlitzortungStrike(strike, sequence = 0) {
  const latitude = Number(strike?.location?.latitude);
  const longitude = Number(strike?.location?.longitude);
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) return null;
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;

  const timeMs = toEpochMs(strike?.time);
  if (!Number.isFinite(timeMs) || timeMs <= 0) return null;

  const seq = Number.isFinite(sequence) ? Math.max(0, Math.trunc(sequence)) : 0;
  const detectors = Array.isArray(strike?.detectors) ? strike.detectors.length : 0;
  const polarity = Number(strike?.polarity);
  const normalizedPolarity = polarity === 0 || polarity === 1 ? polarity : null;

  return {
    id: `${Math.trunc(timeMs)}:${Math.round(latitude * 10_000)}:${Math.round(longitude * 10_000)}:${seq}`,
    lat: latitude,
    lon: longitude,
    altitude: finiteOrNull(strike?.location?.altitude),
    timeMs: Math.trunc(timeMs),
    time: new Date(timeMs).toISOString(),
    deviation: finiteOrNull(strike?.deviation),
    delay: finiteOrNull(strike?.delay),
    detectors,
    polarity: normalizedPolarity,
    maxDeviation: finiteOrNull(strike?.maxDeviation),
    maxCircularGap: finiteOrNull(strike?.maxCircularGap),
    region: Number.isInteger(strike?.region) ? strike.region : null,
  };
}

function lightningStatusSnapshot() {
  return {
    status: _lightningStatus,
    error: _lightningError,
    lastMessageAt: _lightningLastMessageAt,
    reconnectAttempt: _lightningReconnectAttempt,
    nextAttemptAt: _lightningNextAttemptAt,
  };
}

function lightningRowsSnapshot(maxRows, sinceMs) {
  pruneLightningRows(Date.now());
  const rows = [];
  for (const row of _lightningRows) {
    if (Number.isFinite(sinceMs) && row.timeMs < sinceMs) break;
    rows.push(row);
    if (rows.length >= maxRows) break;
  }
  return rows;
}

function ingestLightningStrike(strike) {
  const normalized = normalizeBlitzortungStrike(strike, ++_lightningSequence);
  if (!normalized) return;
  _lightningRows.unshift(normalized);
  if (_lightningRows.length > LIGHTNING_CACHE_MAX) {
    _lightningRows.length = LIGHTNING_CACHE_MAX;
  }
  _lightningLastMessageAt = normalized.timeMs;
  _lightningStatus = 'live';
  _lightningError = null;
  _lightningReconnectAttempt = 0;
  _lightningNextAttemptAt = null;
  pruneLightningRows(normalized.timeMs);
}

function ensureLightningConnection() {
  pruneLightningRows(Date.now());
  if (_lightningClient || _lightningRetryTimer) return;

  const ClientCtor = blitzortungClientCtor();
  const WebSocketCtor = lightningWebSocketCtor();
  if (!ClientCtor || !WebSocketCtor) {
    _lightningStatus = 'unsupported';
    _lightningError = '`@panzer1119/blitzortungapi` or `ws` is unavailable';
    return;
  }

  try {
    const client = new ClientCtor({
      make(address) {
        return new WebSocketCtor(address);
      },
    });
    _lightningClient = client;
    _lightningStatus = 'connecting';
    _lightningError = null;
    client.on('connect', (socket) => {
      if (client !== _lightningClient) {
        socket?.close?.();
        return;
      }
      _lightningSocket = socket;
      _lightningStatus = 'live';
      _lightningError = null;
      _lightningReconnectAttempt = 0;
      _lightningNextAttemptAt = null;
      socket?.on?.('close', () => {
        handleLightningDisconnect('Blitzortung socket closed');
      });
      socket?.on?.('error', (error) => {
        handleLightningDisconnect(error?.message || 'Blitzortung socket error');
      });
    });
    client.on('data', ingestLightningStrike);
    client.on('error', (error) => {
      handleLightningDisconnect(error?.message || 'Blitzortung feed error');
    });
    const forcedUrl = String(process.env.BLITZORTUNG_WS_URL || '').trim();
    if (forcedUrl) client.connect(forcedUrl);
    else client.connect();
  } catch (error) {
    handleLightningDisconnect(error?.message || 'Blitzortung connect failed');
  }
}

function handleLightningDisconnect(reason) {
  const hadClient = Boolean(_lightningClient || _lightningSocket);
  disposeLightningClient();
  if (!hadClient) return;
  _lightningStatus = 'reconnecting';
  _lightningError = reason || 'Blitzortung feed disconnected';
  scheduleLightningReconnect();
}

function scheduleLightningReconnect() {
  if (_lightningRetryTimer) return;
  _lightningReconnectAttempt += 1;
  const delayMs = LIGHTNING_BACKOFF_MS[
    Math.min(_lightningReconnectAttempt - 1, LIGHTNING_BACKOFF_MS.length - 1)
  ];
  _lightningNextAttemptAt = Date.now() + delayMs;
  _lightningRetryTimer = setTimeout(() => {
    _lightningRetryTimer = null;
    _lightningNextAttemptAt = null;
    ensureLightningConnection();
  }, delayMs);
  _lightningRetryTimer.unref?.();
}

function startLightningTick() {
  if (_lightningTickTimer) return;
  _lightningTickTimer = setInterval(() => {
    try {
      ensureLightningConnection();
      pruneLightningRows(Date.now());
    } catch (error) {
      console.warn('[Lightning] watchdog tick failed', error?.message || '');
    }
  }, LIGHTNING_TICK_MS);
  _lightningTickTimer.unref?.();
}

function disposeLightningClient() {
  const client = _lightningClient;
  const socket = _lightningSocket;
  _lightningClient = null;
  _lightningSocket = null;
  try {
    socket?.removeAllListeners?.('close');
    socket?.removeAllListeners?.('error');
  } catch {
    // Best-effort cleanup.
  }
  try {
    client?.removeAllListeners?.();
  } catch {
    // Best-effort cleanup.
  }
  if (!client) return;
  try {
    client.close();
  } catch {
    // close() throws when the client never reached an open socket.
  }
}

function disposeLightningProxy() {
  if (_lightningTickTimer) {
    clearInterval(_lightningTickTimer);
    _lightningTickTimer = null;
  }
  if (_lightningRetryTimer) {
    clearTimeout(_lightningRetryTimer);
    _lightningRetryTimer = null;
  }
  _lightningNextAttemptAt = null;
  _lightningReconnectAttempt = 0;
  _lightningStatus = 'idle';
  _lightningError = null;
  disposeLightningClient();
}

function pruneLightningRows(nowMs) {
  const cutoff = nowMs - LIGHTNING_RETENTION_MS;
  while (_lightningRows.length > 0 && _lightningRows[_lightningRows.length - 1].timeMs < cutoff) {
    _lightningRows.pop();
  }
}

function blitzortungClientCtor() {
  if (_lightningClientCtor !== undefined) return _lightningClientCtor;
  try {
    const required = createRequire(import.meta.url)('@panzer1119/blitzortungapi');
    _lightningClientCtor = required?.Client || required?.default?.Client || required?.default || null;
  } catch {
    _lightningClientCtor = null;
  }
  return _lightningClientCtor;
}

function lightningWebSocketCtor() {
  if (_lightningWebSocketCtor !== undefined) return _lightningWebSocketCtor;
  try {
    const required = createRequire(import.meta.url)('ws');
    _lightningWebSocketCtor = required?.WebSocket || required?.default || required || null;
  } catch {
    _lightningWebSocketCtor = null;
  }
  return _lightningWebSocketCtor;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toEpochMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber > 1e12 ? asNumber : asNumber * 1000;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

