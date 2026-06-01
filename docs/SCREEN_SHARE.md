# Live Screen Share (WebRTC)

Real-time screen sharing from any MBFD admin's browser to any paired
ScreenTinker display, with sub-300ms glass-to-glass latency.

## What it does

A member with admin access opens `media.mbfdhub.com/app/#/screen-share`,
picks a screen / window / browser tab, then casts that stream live to one
or more displays in the same workspace. The chosen display(s) overlay an
HTML5 `<video>` element on top of their normal playlist for the duration
of the share, then revert seamlessly when the broadcaster clicks Stop.

This is **not** a recorded clip uploaded as content. It is a peer-to-peer
WebRTC media stream negotiated through ScreenTinker's existing Socket.IO
signaling channel.

## Use cases at MBFD

- Mirror a PowerPoint training deck from a laptop to every station's
  duty-room TV simultaneously (with system audio for embedded video).
- Push a live incident-management dashboard (browser tab) to the EOC
  video wall during an event.
- Demonstrate a software workflow from the admin desk to every officer's
  display in real time.
- Annotate a document or live-mark up a map and have every screen track.

## How to use it (admin-side)

1. Sign in to `https://media.mbfdhub.com/app`
2. Sidebar &rarr; **Screen Share**
3. Pick one:
   - **Documents / slides** &mdash; optimizes for crisp text (PowerPoint, PDFs)
   - **Video / motion** &mdash; optimizes for smooth playback (training videos)
4. Click **Choose screen / window / tab**, pick the source. The browser
   asks once per session. Includes system audio if your OS supports it.
5. The displays in your workspace appear as a checklist. Check each one
   you want to broadcast to. Multiple simultaneous receivers are fine.
6. The displays switch to your stream within ~1 second. Their normal
   playlist resumes the instant you click **Stop**.

## How it looks on a display

A paired display detects the incoming session and overlays your stream
full-screen. If the broadcaster's tab is closed, the network drops,
or the broadcaster clicks Stop, the overlay is removed and the display
returns to its scheduled playlist with no manual reload.

## Security guarantees

- **HTTPS-only**: `getDisplayMedia()` refuses to start in a non-secure
  context. Cloudflare terminates TLS on `media.mbfdhub.com`.
- **Authenticated signaling**: every screen-share event passes through
  the JWT-authenticated `/dashboard` Socket.IO namespace. The server
  re-validates workspace membership on EVERY incoming event.
- **Workspace isolation**: a screen-share session is gated by the same
  `canActOnDevice` check that gates remote-touch and remote-start.
  Cross-workspace broadcasts are physically impossible &mdash; the server
  refuses to route the SDP offer.
- **Device authentication**: receivers must already be paired and
  presenting a valid device token on their Socket.IO connection.
- **No background capture**: `getDisplayMedia()` ONLY fires from an
  explicit user click. Browsers will reject programmatic calls.
- **No self-mirror**: `selfBrowserSurface: 'exclude'` prevents the user
  from accidentally sharing the dashboard tab itself (which would create
  an infinite hall-of-mirrors and immediately blow out network).
- **Single broadcaster per device**: a second broadcaster attempting to
  cast to a device already receiving a stream preempts the first &mdash;
  the prior broadcaster is told via a `screen-share:preempted` event
  and its peer connection is torn down cleanly.

## Network architecture

```
  Admin browser              ScreenTinker server               Display browser
  +-----------------+        +---------------------+        +-----------------+
  |                 |        |                     |        |                 |
  | getDisplayMedia |        |  Socket.IO          |        |                 |
  |     |           |        |  /dashboard ns      |        |                 |
  |     v           |        |  (JWT)              |        |                 |
  | RTCPeerConn     |        |    \                |        |                 |
  | broadcaster     |        |     +-- signaling --+--->  |                 |
  |     |           +<-------+    relay only       +<------+ RTCPeerConn     |
  |     |           |        |     /               |        | receiver        |
  |     |           |        |  /device ns         |        |     ^           |
  |     |           |        |  (device token)     |        |     |           |
  |     |           |        +---------------------+        | <video> mount   |
  |     |                                                   |     |           |
  |     +-------- direct WebRTC (P2P) ---------------------->|     v           |
  |              (STUN/TURN-assisted)                       | display refreshes
  +-----------------+                                       +-----------------+
```

The server is a **stateless signaling relay**. It does NOT route media
&mdash; SDP offers/answers and ICE candidates pass through, then the actual
video/audio frames go peer-to-peer between the broadcaster and receiver,
NAT-traversal-assisted by STUN (and TURN if configured).

## NAT traversal

By default, the server returns **STUN-only** ICE servers
(`stun:stun.cloudflare.com:3478` and Google's STUN as fallback). This
works for ~70-80% of networks: anything not behind symmetric NAT or a
strict corporate firewall.

To enable TURN relay for the remaining cases (when peer-to-peer can't
be established), provision a Cloudflare Calls TURN key and set two env
vars on the screentinker container:

```bash
CF_TURN_KEY_ID=<your-key-id>
CF_TURN_KEY_API_TOKEN=<your-key-api-token>
```

Steps to provision:

1. Create a Cloudflare API token with the **Cloudflare Calls: Edit**
   permission at https://dash.cloudflare.com/profile/api-tokens.
2. Hit the Cloudflare Calls TURN API to create a key:
   ```bash
   curl -X POST -H "Authorization: Bearer <cf-token-with-calls-scope>" \
     https://api.cloudflare.com/client/v4/accounts/<account-id>/calls/turn_keys \
     -H "Content-Type: application/json" \
     -d '{"name":"mbfd-screen-share"}'
   ```
3. Save the returned `id` and `key` &mdash; they become `CF_TURN_KEY_ID`
   and `CF_TURN_KEY_API_TOKEN` respectively.
4. Add them to `/home/peter/screentinker/.env` (mode 600).
5. Restart: `cd /home/peter/screentinker && docker compose up -d`.

The server will now issue **per-session ephemeral TURN credentials** with
a 1-hour TTL. No code change required &mdash; just env + restart.

## Bandwidth budget

Outgoing video bitrate is **adaptive**: the broadcaster computes a per-receiver
target from the **actual captured resolution + frame rate** (~0.08 bits per pixel
per frame — roughly 5 Mbps for 1080p30, 10 Mbps for 1080p60, 20 Mbps for 4K30,
40 Mbps for 4K60), bounded by a tunable ceiling. There is no fixed cap.

The ceiling defaults to **50 Mbps** and is resolved, in priority order:

1. `SCREEN_SHARE_MAX_BITRATE_KBPS` env var on the server (surfaced to the client
   in the `/api/screen-share/turn-credentials` response) — the real deployment knob.
2. a `localStorage.SCREEN_SHARE_MAX_BITRATE_KBPS` override (per-display field tuning).
3. the built-in default (50000 kbps).

**Capacity planning:** the broadcast is peer-to-peer from the *broadcaster's*
uplink, and bitrate is paid **per receiver**. On a constrained/asymmetric link
(e.g. a remote Starlink broadcaster with ~10–40 Mbps upstream), `target × N
receivers` can saturate the uplink — e.g. 4 receivers at 20 Mbps each = 80 Mbps.
Lower `SCREEN_SHARE_MAX_BITRATE_KBPS` to cap fidelity for that scenario. On a LAN
(broadcaster and displays on the same gigabit network) P2P never touches the WAN,
so the full ceiling is usable.

## Troubleshooting

| What you see | Likely cause | Fix |
|---|---|---|
| "device_offline" when starting | Receiver's player tab is closed | Ensure the display is on, browser is open to `/player`, paired and showing as online |
| Connection stays "connecting" then fails | Symmetric NAT on one side | Provision TURN (see above) |
| Display stays black after start | Browser permissions blocking autoplay video element | Browser console on the receiver will show details; usually a one-time interaction unblock |
| Audio missing | OS doesn't expose system audio (notably macOS without driver) | Use a different OS, install BlackHole / Soundflower, or share a single tab instead of full screen (tab audio works everywhere) |
| Broadcast started but other admin sees "preempted" | Another admin started a session to the same device | Only one broadcaster per device at a time. Coordinate or stop the prior session. |

## Implementation files

- Server: [server/lib/turn-credentials.js](../server/lib/turn-credentials.js)
- Server: [server/routes/screen-share.js](../server/routes/screen-share.js)
- Server: [server/ws/screen-share-signaling.js](../server/ws/screen-share-signaling.js)
- Server: [server/lib/socket-permissions.js](../server/lib/socket-permissions.js) (shared workspace gate)
- Dashboard: [frontend/js/views/screen-share.js](../frontend/js/views/screen-share.js)
- Dashboard: [frontend/css/screen-share.css](../frontend/css/screen-share.css)
- Player: [server/player/screen-share-receiver.js](../server/player/screen-share-receiver.js)
