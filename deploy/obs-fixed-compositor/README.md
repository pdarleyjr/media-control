# MBFD fixed livestream compositor

This package generates one deterministic OBS collection with one persistent
ANNKE camera input, one persistent Media Control browser input, and exactly
three program scenes:

- `MBFD_CAMERA_ONLY`
- `MBFD_CONTENT_MAIN_CAMERA_PIP`
- `MBFD_CAMERA_MAIN_CONTENT_PIP`

The profile is 1920 x 1080 at 30 fps, uses a measured hardware H.264 encoder, a
two-second keyframe interval, and AAC audio at 48 kHz. OBS logs and systemd
journal output are bounded. The WebSocket listener is authenticated and must be
bound to loopback or one specific private address.

## Protected runtime configuration

Run `install.sh` from a candidate checkout installed at
`/opt/mbfd/media-control`. Populate `/etc/mbfd/obs-fixed-compositor.env` and
retain mode `0600`. The camera URL, OBS WebSocket password, PeerTube stream key,
and other runtime secrets must never be committed, copied into browser
JavaScript, printed in deployment output, or passed as command-line arguments.

Before selecting an encoder, inspect and benchmark the target host. Set
`OBS_H264_ENCODER` to the working OBS hardware encoder ID for that host (for
example VA-API, Quick Sync, or NVENC). The generator rejects software x264.

The browser source URL remains credential-free. Media Control authenticates the
receiver through its private bootstrap flow and derives tenancy on the server.

## Publisher modes and mutual exclusion

`LIVE_PUBLISHER_MODE` supports:

- `direct_camera`: the existing camera-edge FFmpeg publisher is authoritative.
- `fixed_compositor`: OBS is the only publisher and starts in Camera Only.

Changing modes is a controlled service restart, never a live toggle. Both
publishers share one PeerTube destination, so they must never be active at the
same time.

To move from `direct_camera` to `fixed_compositor`:

1. Confirm no class, livestream, or recording is active.
2. Stop and confirm the direct camera publisher is inactive.
3. Set `LIVE_PUBLISHER_MODE=fixed_compositor` in the protected Media
   Control runtime configuration.
4. Generate the OBS configuration and start
   `mbfd-fixed-compositor.service`.
5. Run `healthcheck.js` and confirm `MBFD_CAMERA_ONLY`.
6. Restart Media Control so the configured publisher mode becomes authoritative.
7. Perform the bounded Camera Only ingest and rollback checks.

To roll back, stop and confirm OBS output is inactive, restore
`LIVE_PUBLISHER_MODE=direct_camera`, restart Media Control, and only then
start the direct camera publisher. Do not enable automatic dual-publisher
failover.

## Installation and health

The installer copies the systemd unit and creates the protected environment
file only when absent. It deliberately does not enable or start the service.
The unit regenerates the runtime collection atomically before every start and
checks the OBS WebSocket protocol, required scenes, selected scene, and stream
state after startup.

Manual health check from the deployed repository:

```sh
set -a
. /etc/mbfd/obs-fixed-compositor.env
set +a
node deploy/obs-fixed-compositor/healthcheck.js
```

The health result contains versions, program scene, and active state only; it
does not include credentials or stream destinations.

When the PeerTube deployment exposes a protected ingest-health endpoint, set
`PEERTUBE_INGEST_HEALTH_URL` and `PEERTUBE_INGEST_HEALTH_TOKEN` in the Media
Control runtime environment. Start then polls that endpoint and rolls back the
selected publisher if PeerTube does not confirm the incoming program. Without
that explicit endpoint, the response records ingest confirmation as unavailable
instead of inferring it from the public watch page.

Do not deploy this package until the chosen host has passed the required
hardware inventory and bounded CPU/GPU/network/thermal benchmark. Source
generation and protocol simulation are not physical OBS or PeerTube acceptance.
