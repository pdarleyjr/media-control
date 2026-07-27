# Legacy livestream compatibility policy

The active instructor UI uses one-click **Start Livestream** plus the three
fixed compositor layouts. The active instructor UI does not call
`/api/live-stream/prepare` or either `/api/live-stream/production-plan`
endpoint.

Those endpoints remain temporarily for rolling clients through Media Control
version **2.0.0** and have a **September 30, 2026** sunset. Every response
includes `Deprecation`, `Sunset`, deprecation-link, warning, and removal-version
headers, and every call is written to the Media Control activity/audit stream.

The compatibility routes cannot select or start an alternative publisher.
Publisher mode is fixed when the server process starts, mutual exclusion is
enforced by the authoritative `/start` route, and every start begins in
`MBFD_CAMERA_ONLY`. Legacy AI Director selections are rejected.

Before removal, release acceptance must show that the active web UI, mobile UI,
five Electron players, and supported automation make no compatibility-route
requests across one normal release cycle.
