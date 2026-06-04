/**
 * ICE servers provider for WebRTC screen sharing.
 *
 * Layered fallback strategy (best -> worst):
 *
 *   1. Cloudflare Calls TURN (when CF_TURN_KEY_ID + CF_TURN_KEY_API_TOKEN set)
 *      - Per-session ephemeral credentials, 1-hour TTL
 *      - Production-grade, dedicated bandwidth, your own creds
 *
 *   2. OpenRelay free public TURN by Metered.ca (default, when CF not set
 *      and OPENRELAY_TURN_DISABLED is not '1')
 *      - 50 GB/month free, shared public credentials
 *      - Multiple transports: UDP 80, TCP 80, UDP 443, TLS 443
 *      - Media is still DTLS-SRTP encrypted end-to-end; TURN only relays
 *        opaque packets it cannot decrypt
 *
 *   3. STUN-only (when both above unavailable / disabled)
 *      - Cloudflare + Google public STUN
 *      - Works for ~70-80% of NAT scenarios but FAILS on symmetric NAT /
 *        strict corporate firewalls (e.g. City of Miami Beach gov network)
 *
 * Security: this module is called from a JWT-gated REST endpoint and never
 * returns secrets in logs. CF TURN credentials returned to the client ARE
 * ephemeral and scoped to a single session. OpenRelay credentials are
 * intentionally public (documented at https://www.metered.ca/tools/openrelay/)
 * so leaking them in a network trace is a non-event.
 */

const STATIC_STUN = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

// OpenRelay free public TURN by Metered.ca - https://www.metered.ca/tools/openrelay/
// Four transports so ICE can route around port/protocol blocks on restrictive networks:
//   UDP 80   - fastest when allowed
//   TCP 80   - fallback for UDP-blocked egress
//   UDP 443  - same as UDP 80 but on a more universally-permitted port
//   TLS 443  - last-resort, indistinguishable from HTTPS to most middleboxes
const OPENRELAY_TURN = [
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:80?transport=tcp',
      'turn:openrelay.metered.ca:443',
      'turns:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

const TURN_TTL_SECONDS = 60 * 60; // 1 hour
const CF_TURN_TIMEOUT_MS = parseInt(process.env.CF_TURN_TIMEOUT_MS, 10) || 5000;

async function fetchCloudflareTurnCredentials(keyId, apiToken, ttlSeconds = TURN_TTL_SECONDS) {
  // https://developers.cloudflare.com/calls/turn/generate-credentials/
  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
  const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(CF_TURN_TIMEOUT_MS)
    : undefined;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl: ttlSeconds }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CF TURN credential request failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  // Response shape: { iceServers: { urls: [...], username: '...', credential: '...' } }
  if (data && data.iceServers && data.iceServers.urls) {
    return [{
      urls: data.iceServers.urls,
      username: data.iceServers.username,
      credential: data.iceServers.credential,
    }];
  }
  return [];
}

function getOpenRelayServers() {
  if (process.env.OPENRELAY_TURN_DISABLED === '1') return [];
  return OPENRELAY_TURN;
}

/**
 * Returns { iceServers: RTCIceServer[], turnEnabled: boolean, turnProvider: string }
 * Never throws - falls back to next layer on any failure and logs.
 */
async function getIceServers() {
  const keyId = process.env.CF_TURN_KEY_ID;
  const apiToken = process.env.CF_TURN_KEY_API_TOKEN;

  // Layer 1: Cloudflare Calls TURN (preferred when configured)
  if (keyId && apiToken) {
    try {
      const turnServers = await fetchCloudflareTurnCredentials(keyId, apiToken);
      return {
        iceServers: [...STATIC_STUN, ...turnServers],
        turnEnabled: true,
        turnProvider: 'cloudflare-calls',
      };
    } catch (e) {
      console.warn('[turn-credentials] CF TURN unreachable; falling back to OpenRelay:', e.message);
      // fall through to layer 2
    }
  }

  // Layer 2: OpenRelay free public TURN (default when CF not set or failed)
  const openRelay = getOpenRelayServers();
  if (openRelay.length > 0) {
    return {
      iceServers: [...STATIC_STUN, ...openRelay],
      turnEnabled: true,
      turnProvider: 'openrelay',
    };
  }

  // Layer 3: STUN-only (explicitly disabled OpenRelay, no CF)
  return { iceServers: STATIC_STUN, turnEnabled: false, turnProvider: 'none' };
}

module.exports = { getIceServers, OPENRELAY_TURN };
