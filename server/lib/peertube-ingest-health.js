'use strict';

function normalizeState(body) {
  const value = body && typeof body === 'object' ? body : {};
  const state = String(
    value.state
    || value.status
    || value.stream_state
    || value.ingest_state
    || '',
  ).trim().toLowerCase();
  const confirmed = value.active === true
    || value.live === true
    || value.receiving === true
    || value.ingest_active === true
    || ['active', 'live', 'on_air', 'publishing', 'receiving'].includes(state);
  return { state: state || null, confirmed };
}

function createPeerTubeIngestVerifier({
  url,
  token = '',
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 2500,
  confirmationTimeoutMs = 8000,
  pollIntervalMs = 500,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const configuredUrl = String(url || '').trim();
  if (!configuredUrl) {
    return {
      async check() {
        return {
          available: false,
          confirmed: null,
          code: 'PEERTUBE_INGEST_HEALTH_NOT_CONFIGURED',
        };
      },
      async waitForActive() {
        return this.check();
      },
    };
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');

  let endpoint;
  try {
    endpoint = new URL(configuredUrl);
  } catch {
    throw new Error('PEERTUBE_INGEST_HEALTH_URL must be a valid URL');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('PEERTUBE_INGEST_HEALTH_URL must be credential-free HTTP or HTTPS');
  }
  const timeout = Math.max(250, Number(requestTimeoutMs) || 2500);
  const confirmationBudget = Math.max(0, Number(confirmationTimeoutMs) || 0);
  const interval = Math.max(1, Number(pollIntervalMs) || 500);
  const bearer = String(token || '').trim();

  async function check() {
    try {
      const headers = { Accept: 'application/json' };
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      const response = await fetchImpl(endpoint.toString(), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        return {
          available: true,
          confirmed: false,
          code: 'PEERTUBE_INGEST_HEALTH_REJECTED',
          http_status: Number(response.status) || null,
          state: null,
        };
      }
      const body = await response.json();
      const normalized = normalizeState(body);
      return {
        available: true,
        confirmed: normalized.confirmed,
        code: normalized.confirmed ? null : 'PEERTUBE_INGEST_NOT_ACTIVE',
        http_status: Number(response.status) || 200,
        state: normalized.state,
      };
    } catch {
      return {
        available: true,
        confirmed: false,
        code: 'PEERTUBE_INGEST_UNREACHABLE',
        http_status: null,
        state: null,
      };
    }
  }

  async function waitForActive() {
    const deadline = Date.now() + confirmationBudget;
    let result;
    do {
      result = await check();
      if (result.confirmed === true) return result;
      if (Date.now() >= deadline) return result;
      await wait(Math.min(interval, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return result;
  }

  return { check, waitForActive };
}

module.exports = {
  createPeerTubeIngestVerifier,
  normalizeState,
};

