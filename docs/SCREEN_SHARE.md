# Live Screen Share (WebRTC)

Real-time screen sharing from an authenticated MBFD admin browser to paired
ScreenTinker displays and calibrated video walls. Direct WebRTC is the normal,
low-latency path; a visibly labeled video-only fallback prevents a blank wall
when WebRTC is blocked.

## What it does

A member with admin access opens `media.mbfdhub.com/app/#/screen-share`,
picks a screen / window / browser tab, then casts that stream live to one
or more displays in the same workspace. The chosen display(s) overlay an
HTML5 `<video>` element on top of their normal playlist for the duration
of the share, then revert seamlessly when the broadcaster clicks Stop.

This is **not** a recorded clip uploaded as content. It normally uses a WebRTC
media stream negotiated through ScreenTinker's existing Socket.IO signaling
channel. If ICE negotiation fails, the authenticated server can temporarily
fan out bounded JPEG frames so the operator still has video.

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
   - **Video / motion** &mdash; requests 1080p30 for balanced playback
   - **High motion** &mdash; requests up to 1080p60; the browser/source may return less
4. Choose a fit mode:
   - **Auto** &mdash; contain on one display; fill the calibrated canvas on a wall
   - **Fit** &mdash; show the whole source with letterboxing
   - **Fill** &mdash; preserve aspect ratio and crop edges
   - **Stretch** &mdash; fill every pixel, with possible distortion
5. Click **Choose screen / window / tab**, pick the source. The browser
   asks once per session. Includes system audio if your OS supports it.
6. The displays and complete calibrated walls in your workspace appear as a
   checklist. Check each destination
   you want to broadcast to. Multiple simultaneous receivers are fine.
7. Direct connections normally switch within about a second. Their normal
   playlist resumes the instant you click **Stop**.

## How it looks on a display

A paired display detects the incoming session and overlays your stream. A wall
receives one source with a calibrated slice per member, so 2- and 3-display
spans use the same wall geometry as uploaded content. Selecting several
standalone displays mirrors the source. Multi-region layouts remain the job of
the Multiview composer, which can place screen share beside other sources.

If the broadcaster's tab is closed, the network drops,
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
  Cross-workspace attempts are rejected before session setup or media fallback
  fan-out.
- **Device authentication**: receivers must already be paired and
  presenting a valid device token on their Socket.IO connection.
- **No background capture**: `getDisplayMedia()` ONLY fires from an
  explicit user click. Browsers will reject programmatic calls.
- **Self-mirror protection**: supported Chromium browsers are asked to exclude
  the current dashboard tab. The chooser remains browser-controlled, so the
  operator must still verify the selected source.
- **Single broadcaster per device**: a second broadcaster attempting to
  cast to a device already receiving a stream preempts the first &mdash;
  the prior broadcaster is told via a `screen-share:preempted` event
  and its peer connection is torn down cleanly.

## Network architecture

```text
Admin browser -- authenticated SDP/ICE --> Media Control -- device auth --> Display
      |                                                                  ^
      +---- direct WebRTC audio/video (preferred on the room LAN) --------+
      +---- TURN-assisted encrypted WebRTC (when direct ICE cannot route) -+
      +---- authenticated JPEG fallback via Media Control (video only) ----+
```

The server owns the authorized session, reconnect grace, fit/wall metadata,
and the bounded JPEG fallback. It does not inspect SDP or decrypt WebRTC media.
WebRTC audio/video normally travels directly or through the selected TURN
server using DTLS-SRTP. The emergency frame fallback is different: the
broadcaster encodes JPEG images and the Media Control socket server fans them
out only to authorized active targets.

## NAT traversal

By default, the server returns Cloudflare/Google STUN plus Metered OpenRelay
TURN. When Cloudflare Calls TURN credentials are configured, its short-lived
credentials are preferred. `iceTransportPolicy: all` lets the browser prefer a
direct candidate and use TURN when necessary.

To use dedicated Cloudflare Calls TURN instead of the public default, provision
a Calls TURN key and set two environment variables on the Media Control
container:

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
4. Store them in the protected production environment file (mode 600); never
   commit them.
5. Recreate the Media Control container through the normal release procedure.

The server will now issue **per-session ephemeral TURN credentials** with
a 1-hour TTL. No code change required &mdash; just env + restart.

## Bandwidth budget

Outgoing video bitrate is **adaptive**: the broadcaster computes a per-receiver
target from the **actual captured resolution + frame rate** (~0.08 bits per pixel
per frame — roughly 5 Mbps for 1080p30 and 10 Mbps for 1080p60 before the
ceiling), bounded by an operator-tunable cap.

The ceiling defaults to **8 Mbps per receiver** and is resolved, in priority order:

1. `SCREEN_SHARE_MAX_BITRATE_KBPS` env var on the server (surfaced to the client
   in the `/api/screen-share/turn-credentials` response) — the real deployment knob.
2. a `localStorage.SCREEN_SHARE_MAX_BITRATE_KBPS` override (per-display field tuning).
3. the built-in default (8000 kbps).

**Capacity planning:** the broadcast is peer-to-peer from the *broadcaster's*
uplink, and bitrate is paid **per receiver**. On a constrained/asymmetric link
(e.g. a remote broadcaster), `target × N receivers` can saturate the uplink.
Lower `SCREEN_SHARE_MAX_BITRATE_KBPS` to cap fidelity for that scenario. On a LAN
(broadcaster and displays on the same room network), a selected host/private ICE
pair keeps WebRTC media local. Confirm the selected path and live bitrate in the
per-target diagnostics rather than inferring it from topology.

## Degraded frame fallback

The fallback is intentionally bounded to **1280×720**, **5 fps**, JPEG quality
0.62, at most 16 targets per frame, and a 1.2 MB base64 frame limit. It is
**video-only**: captured system/tab audio is available on WebRTC but is not
transported by the JPEG fallback. The Active broadcasts list therefore says
`relay (video only)` and shows the fallback geometry instead of implying that
normal A/V WebRTC is still active.

This path is for slides, dashboards, and continuity during blocked ICE. It is
not suitable for training-video playback. Restore WebRTC/TURN before relying on
motion or audio.

## Operator diagnostics

The dashboard reports actual capture surface, resolution, returned frame rate,
and whether the browser supplied an audio track. Every active WebRTC receiver is
sampled for outbound video/audio kbps, encoded geometry/fps, RTT, codec, and the
browser's quality-limitation reason. A first sample has no bitrate delta yet.
CPU, GPU decode, and glass-to-glass latency are platform measurements rather
than portable WebRTC stats; measure those on the source/display host during a
room acceptance test.

## Troubleshooting

| What you see | Likely cause | Fix |
|---|---|---|
| "device_offline" when starting | Receiver's player tab is closed | Ensure the display is on, browser is open to `/player`, paired and showing as online |
| Connection stays "connecting" then fails | Symmetric NAT on one side | Provision TURN (see above) |
| Display stays black after start | Browser permissions blocking autoplay video element | Browser console on the receiver will show details; usually a one-time interaction unblock |
| Audio missing | The chosen surface/browser/OS did not expose an audio track | Re-share a browser tab with its audio checkbox enabled, or use an approved OS audio-routing device; verify `Audio: included` before broadcasting |
| Status says `relay (video only)` | WebRTC negotiation or ICE path failed | Check TURN diagnostics and network policy; the bounded JPEG fallback cannot carry audio |
| Broadcast started but other admin sees "preempted" | Another admin started a session to the same device | Only one broadcaster per device at a time. Coordinate or stop the prior session. |

## Implementation files

- Server: [server/lib/turn-credentials.js](../server/lib/turn-credentials.js)
- Server: [server/routes/screen-share.js](../server/routes/screen-share.js)
- Server: [server/ws/screen-share-signaling.js](../server/ws/screen-share-signaling.js)
- Server: [server/lib/socket-permissions.js](../server/lib/socket-permissions.js) (shared workspace gate)
- Dashboard: [frontend/js/views/screen-share.js](../frontend/js/views/screen-share.js)
- Dashboard: [frontend/css/screen-share.css](../frontend/css/screen-share.css)
- Player: [server/player/screen-share-receiver.js](../server/player/screen-share-receiver.js)
