# Recording long-test handoff

The long-duration recording test is deliberately user-run. Automation must not
run `user-long-recording-test.sh`.

On the Kamrui, first confirm the classroom is idle and no recording,
livestream, upload, or synchronization is active. Put the API token in a
protected file without printing it, then run:

```bash
install -m 0600 /dev/stdin "/run/user/$UID/mbfd-camera-api.token"
# Paste the token, press Enter, then Ctrl+D.
export MBFD_USER_AUTHORIZED_LONG_TEST=YES
export LONG_TEST_DURATION_SECONDS=3600
export CAMERA_API_TOKEN_FILE="/run/user/$UID/mbfd-camera-api.token"
/opt/mbfd/media-stack/scripts/user-long-recording-test.sh
```

1. Start the command and record the displayed session ID.
2. Observe the elapsed time, current segment, supervisor/FFmpeg state, track
   health, growth, disk, camera, CPU, RAM, temperature, and API indicators.
3. Leave it running for the desired authorized duration.
4. Press Ctrl+C for an early safe stop, or let the duration expire.
5. Wait for finalization and checksum validation.
6. Open the immutable `report.json` and `report.md` paths printed at completion.
7. Report the printed `failure_code` and session ID if the command exits nonzero.

Optionally set `RUN_SYNC_AFTER_TEST=true` to perform the normal verified sync
after finalization. The harness continuously appends health samples, tolerates
temporary API unavailability while the independently supervised systemd unit
or configured Docker container continues, and writes read-only JSON and
Markdown reports containing the stop result, final
metadata, `ffprobe`, SHA-256 comparison, samples, and sync result. It never
starts a livestream, uploads, publishes, or deletes a recording.

For the Docker backend, each health sample records the named container,
immutable image identity, Docker running state, and container PID. The
supervisor gate remains green only while the same full container and image
identities remain running, including across an API restart. A changed identity
or unavailable Docker runtime is a fail-closed result.

Before deploying the API changes, provision the same new random signing secret
as `CAMERA_CONTROL_SIGNING_SECRET` in Media Control and
`CAMERA_SERVICE_SIGNING_SECRET` in the Kamrui camera environment. They must
match and must not reuse the API bearer token. Until both sides are configured,
archive, restore, permanent deletion, and explicit PeerTube deletion fail
closed with 503/401.

Also configure matching current key identity values:
`CAMERA_CONTROL_SIGNING_KEY_ID` / `CAMERA_SERVICE_SIGNING_KEY_ID` and
`CAMERA_CONTROL_SIGNING_KEY_VERSION` /
`CAMERA_SERVICE_SIGNING_KEY_VERSION`. For rotation, first deploy the new
current key to Kamrui while retaining the old key in its
`CAMERA_SERVICE_PREVIOUS_SIGNING_*` variables, then switch Media Control to the
new current key. Remove the previous edge key only after all callers use the
new version.

Acceptance still requires the user to play the resulting file and physically
confirm continuous video, intelligible classroom audio, correct duration, and
no visible outage. A generated report is evidence, not by itself a physical
pass.
