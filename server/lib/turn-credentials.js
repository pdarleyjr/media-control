/**
 * ICE servers provider for WebRTC screen sharing.
 *
 * Returns the iceServers config a peer should use. When Cloudflare Calls TURN
 * credentials are configured via env (CF_TURN_KEY_ID + CF_TURN_KEY_API_TOKEN),
 * issues per-request ephemeral TURN credentials with a short TTL - recommended
 * for production behind strict corporate firewalls / symmetric NATs.
 *
 * When TURN env is absent, returns a STUN-only config using Cloudflare's public
 * STUN + Google's fallback. This covers ~70-80% of NAT scenarios (anything
 * not symmetric NAT or strict firewall). Activate TURN later by setting the
 * env vars and restarting - no code change required.
 *
 * Security: this module is called from a JWT-gated REST endpoint and never
 * returns secrets in logs. The CF TURN credentials returned to the client ARE
 * ephemeral (default TTL 1 hour) and scoped to a single session.
 */

const STATIC_STUN = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

const TURN_TTL_SECONDS = 60 * 60; // 1 hour

async function fetchCloudflareTurnCredentials(keyId, apiToken, ttlSeconds = TURN_TTL_SECONDS) {
  // https://developers.cloudflare.com/calls/turn/generate-credentials/
  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
  const res = await fetch(url, {
    method: 'POST',
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
  // Response shape:
  //   { iceServers: { urls: [...], username: '...', credential: '...' } }
  // Normalize to RTCIceServer[] for the client.
  if (data && data.iceServers && data.iceServers.urls) {
    return [{
      urls: data.iceServers.urls,
      username: data.iceServers.username,
      credential: data.iceServers.credential,
    }];
  }
  return [];
}

/**
 * Returns { iceServers: RTCIceServer[], turnEnabled: boolean }
 * Never throws - falls back to STUN-only on any TURN failure and logs.
 */
async function getIceServers() {
  const keyId = process.env.CF_TURN_KEY_ID;
  const apiToken = process.env.CF_TURN_KEY_API_TOKEN;

  if (!keyId || !apiToken) {
    return { iceServers: STATIC_STUN, turnEnabled: false };
  }

  try {
    const turnServers = await fetchCloudflareTurnCredentials(keyId, apiToken);
    return {
      iceServers: [...STATIC_STUN, ...turnServers],
      turnEnabled: true,
    };
  } catch (e) {
    console.warn('[turn-credentials] CF TURN unreachable; falling back to STUN-only:', e.message);
    return { iceServers: STATIC_STUN, turnEnabled: false };
  }
}

module.exports = { getIceServers };
