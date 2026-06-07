// ssrf-policy.js — centralized allow/deny policy for user-supplied remote URLs
// that get broadcast to / rendered on displays (broadcast, widgets, kiosk,
// player, scenes, content remote_url).
//
// THREAT: a remote URL can be pointed at internal infrastructure the server
// can reach but a browser on the public internet can't — the homelab's own
// services, the Docker bridge, other LAN hosts, the Tailscale tailnet, or the
// cloud-metadata endpoint (169.254.169.254). Even a public hostname can resolve
// to a private address (DNS rebinding), so a string-prefix check on the literal
// hostname is NOT enough — we must resolve DNS and re-check every answer.
//
// This module exposes two layers:
//   - isBlockedIp(ip)           : classify a single IP literal (v4 or v6).
//   - checkRemoteUrlShape(url)   : sync — protocol + literal-host check, no DNS.
//   - assertRemoteUrlSafe(url)   : async — shape check THEN DNS-resolve the host
//                                  and block if ANY resolved address is private.
//
// Callers that accept a URL at an HTTP boundary should `await assertRemoteUrlSafe`.
// The sync shape check stays available for places that can't await and for fast
// rejection before paying for a DNS lookup.

const dns = require('dns').promises;
const net = require('net');

// Reasons are stable strings so callers/tests can assert on them without
// depending on human-readable copy.
const REASONS = {
  INVALID_URL: 'invalid_url',
  BAD_PROTOCOL: 'bad_protocol',
  PRIVATE_TARGET: 'private_target',
  DNS_FAILED: 'dns_failed',
};

function err(reason, message) {
  return { ok: false, reason, error: message };
}

// Parse an IPv4 dotted-quad into its 32-bit unsigned integer, or null.
function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

function inV4Cidr(ipInt, baseStr, maskBits) {
  const base = ipv4ToInt(baseStr);
  if (base === null) return false;
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (ipInt & mask) === (base & mask);
}

// Classify an IPv4 literal as blocked (non-routable / internal / sensitive).
function isBlockedIpv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return (
    inV4Cidr(n, '0.0.0.0', 8) ||        // "this" network / 0.0.0.0
    inV4Cidr(n, '10.0.0.0', 8) ||       // RFC1918 private
    inV4Cidr(n, '100.64.0.0', 10) ||    // CGNAT / Tailscale (100.64.0.0/10)
    inV4Cidr(n, '127.0.0.0', 8) ||      // loopback
    inV4Cidr(n, '169.254.0.0', 16) ||   // link-local INCLUDING 169.254.169.254 metadata
    inV4Cidr(n, '172.16.0.0', 12) ||    // RFC1918 private
    inV4Cidr(n, '192.0.0.0', 24) ||     // IETF protocol assignments
    inV4Cidr(n, '192.168.0.0', 16) ||   // RFC1918 private
    inV4Cidr(n, '198.18.0.0', 15) ||    // benchmarking
    inV4Cidr(n, '224.0.0.0', 4) ||      // multicast
    inV4Cidr(n, '240.0.0.0', 4)         // reserved / broadcast
  );
}

// Classify an IPv6 literal as blocked. Handles the common sensitive ranges plus
// IPv4-mapped (::ffff:a.b.c.d) by delegating the embedded v4 to the v4 check.
function isBlockedIpv6(ip) {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::1' || lower === '::') return true;                 // loopback / unspecified
  if (lower.startsWith('fe80') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local fe80::/10
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;   // unique-local fc00::/7
  if (lower.startsWith('ff')) return true;                            // multicast
  // IPv4-mapped / -compatible: pull the trailing dotted-quad and re-check.
  const v4match = lower.match(/(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4match) return isBlockedIpv4(v4match[1]);
  return false;
}

// Public: classify any IP literal (v4 or v6). Unknown / unparseable -> blocked
// (fail closed: we never resolved it to something we can vouch for as public).
function isBlockedIp(ip) {
  if (typeof ip !== 'string' || ip.length === 0) return true;
  const fam = net.isIP(ip);
  if (fam === 4) return isBlockedIpv4(ip);
  if (fam === 6) return isBlockedIpv6(ip);
  return true;
}

// Hostnames that are never legitimate external targets, independent of what DNS
// would say (defense in depth — these often resolve to loopback but a poisoned
// resolver could lie).
function isBlockedHostname(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost') return true;
  if (h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true;       // mDNS
  if (h.endsWith('.internal')) return true;     // common internal suffix / GCP metadata
  return false;
}

// Sync shape check: valid URL, http(s) only, and the LITERAL host isn't an
// obviously-internal name or a private IP literal. Does NOT do DNS. Returns
// { ok:true, parsed } or { ok:false, reason, error }.
function checkRemoteUrlShape(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    return err(REASONS.INVALID_URL, 'Invalid URL format');
  }
  let parsed;
  try { parsed = new URL(url); }
  catch { return err(REASONS.INVALID_URL, 'Invalid URL format'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return err(REASONS.BAD_PROTOCOL, 'URL must use http or https');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(hostname)) {
    return err(REASONS.PRIVATE_TARGET, 'Internal URLs are not allowed');
  }
  // If the host is an IP literal, classify it now (no DNS needed).
  if (net.isIP(hostname) !== 0 && isBlockedIp(hostname)) {
    return err(REASONS.PRIVATE_TARGET, 'Internal URLs are not allowed');
  }
  return { ok: true, parsed };
}

// Async full check: shape check, then resolve the hostname and block if ANY
// answer is a private/loopback/link-local/Tailscale/metadata address. Closes
// the DNS-rebinding hole the sync check can't see. A resolver/lookup that fails
// returns DNS_FAILED (fail closed — we couldn't prove the target is public).
//
// `resolver` is injectable for tests (defaults to dns.promises.lookup, which
// honors the system hosts file + /etc/resolv.conf exactly like fetch will).
async function assertRemoteUrlSafe(url, { resolver } = {}) {
  const shape = checkRemoteUrlShape(url);
  if (!shape.ok) return shape;

  const hostname = shape.parsed.hostname.replace(/^\[|\]$/g, '');
  // IP literal already fully classified by the shape check.
  if (net.isIP(hostname) !== 0) return { ok: true, parsed: shape.parsed };

  const lookup = resolver || ((h) => dns.lookup(h, { all: true, verbatim: true }));
  let addresses;
  try {
    const result = await lookup(hostname);
    addresses = Array.isArray(result) ? result : [result];
  } catch {
    return err(REASONS.DNS_FAILED, 'Could not resolve host');
  }
  if (!addresses || addresses.length === 0) {
    return err(REASONS.DNS_FAILED, 'Could not resolve host');
  }
  for (const a of addresses) {
    const ip = typeof a === 'string' ? a : a && a.address;
    if (isBlockedIp(ip)) {
      return err(REASONS.PRIVATE_TARGET, 'Internal URLs are not allowed');
    }
  }
  return { ok: true, parsed: shape.parsed };
}

module.exports = {
  REASONS,
  isBlockedIp,
  isBlockedHostname,
  checkRemoteUrlShape,
  assertRemoteUrlSafe,
};
