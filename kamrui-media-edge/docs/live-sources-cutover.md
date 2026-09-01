# Live-source cutover: podium and Guest publisher

This is the only deployment workflow for the podium/Guest source-topology
change. It is deliberately narrower than the repository-wide maintenance
workflow and does not deploy the Camera API or Media Control application.

Use the committed script from the reviewed edge checkout:

```bash
sudo bash ./scripts/deploy-live-sources-cutover.sh --dry-run
```

The default is read-only with respect to KAMRUI's active configuration,
container, firewall, and backups. It verifies the KAMRUI host identity, current
MediaMTX `v1.19.3` container identity, local Anpviz API path health, an idle
Guest publisher path, renderer inputs, and the committed immutable image
reference. It creates only a protected temporary directory and removes it when
finished.

`--apply` is prohibited until Agent 3 has authorized a maintenance window,
reviewed a passing dry-run, coordinated the separately owned source-contract
release, and accepted the physical Guest-Laptop gate. It requires a deliberate
acknowledgement:

```bash
sudo env MBFD_LIVE_SOURCES_CUTOVER_AUTHORIZATION=YES \
  bash ./scripts/deploy-live-sources-cutover.sh --apply
```

Optionally supply a fresh destination below the approved backup root:

```bash
sudo env MBFD_LIVE_SOURCES_CUTOVER_AUTHORIZATION=YES \
  bash ./scripts/deploy-live-sources-cutover.sh --apply \
  --snapshot-dir /home/peter/mbfd-backups/live-sources-cutover-YYYYMMDDTHHMMSSZ
```

Do not reuse historical Zowie audio snapshots. The script creates a fresh,
mode-restricted rollback snapshot from the current runtime immediately before
any active file is replaced. Its `rollback-manifest.json` contains the original
Compose bytes, rendered configuration bytes, protected render input, runtime
inspect capture, checksums, MediaMTX version, image ID, immutable RepoDigest,
and start metadata. It also records the specific Guest RTMP UFW baseline as a
SHA-256-covered `runtime/guest-rtmp-firewall-before.json` artifact and a
cross-checked `firewall.guest_rtmp` manifest object:

```json
{
  "guest_ip": "<DHCP-reserved Guest IPv4>",
  "kamrui_ip": "<wired KAMRUI IPv4>",
  "port": 1935,
  "protocol": "tcp",
  "present_before_cutover": false
}
```

`present_before_cutover: false` is the normal accepted baseline because the
cutover refuses to add a duplicate exact rule. It is recorded rather than
assumed: if the exact rule already existed in a future observed baseline, a
rollback restores that state instead of deleting it. A legacy `latest` Compose
is recorded only as a `verified-legacy` snapshot with its exact observed
immutable runtime identity; the cutover never pulls `latest`.

## What the script can perform

After a successful preflight and snapshot, apply mode can only:

1. Render the committed MediaMTX template to a protected temporary location.
2. Validate Compose and the required source/authentication contract.
3. Run a disposable, network-isolated MediaMTX `v1.19.3` parser container.
4. Atomically replace only `/opt/mbfd/media-stack/mediamtx.yml` and
   `/opt/mbfd/media-stack/docker-compose.mediamtx.yml`.
5. Pull the already-pinned MediaMTX image and recreate only `mbfd-mediamtx`
   with `docker compose ... up -d --no-deps --force-recreate mediamtx`.
6. Verify the exact image/version, running state, Anpviz health, the podium
   path, and an idle Guest publisher path through the local API.
7. Add exactly one UFW allow rule from the DHCP-reserved Guest IPv4 to the
   wired KAMRUI IPv4 on TCP `1935`, only after those checks pass.

If a failure occurs after either active MediaMTX file could have changed, the
cutover error handler invokes the same feature-specific rollback wrapper with
the fresh verified snapshot. The wrapper restores only the snapshot-recorded
Guest RTMP rule state and then calls the lower-level source-only primitive. It
does not attempt rollback for a preflight-only failure because no active state
has changed. Preserve the snapshot and escalate if an automatic rollback fails.

## Manual rollback after a successful cutover

After a successful podium/Guest cutover, the one approved manual rollback
command is:

```bash
sudo bash ./scripts/rollback-live-sources-cutover.sh \
  /home/peter/mbfd-backups/<verified-cutover-snapshot>
```

Do not manually delete a UFW rule before this command, and do not run
`scripts/rollback.sh` directly as the operator procedure. `rollback.sh` remains
the lower-level, verified MediaMTX/source-only restore primitive; the
feature-specific wrapper is the required inverse of the successful cutover.

The wrapper first validates the same protected snapshot and its firewall
artifact. It accepts only a well-formed, unambiguous exact tuple of Guest IPv4,
wired KAMRUI IPv4, TCP, and port `1935`. It restores that tuple to the
recorded baseline with fail-closed ordering:

1. If `present_before_cutover` is `false`, remove the exact
   `Guest-IP -> KAMRUI-IP TCP/1935` rule if present. Its absence is idempotent.
2. Invoke the verified source-only `scripts/rollback.sh` primitive, which
   restores MediaMTX and verifies the captured immutable image, version, and
   Anpviz paths.
3. If `present_before_cutover` is `true`, preserve the exact pre-existing
   rule; if it is unexpectedly absent, restore it only after source recovery
   succeeds.
4. Confirm that the exact Guest rule now matches the recorded baseline and
   that unrelated numbered UFW rules are unchanged.

The wrapper never resets UFW, applies no broad firewall policy, and leaves an
unrelated UFW rule, including a different source or another TCP/1935 rule, alone.
It fails closed if the snapshot, firewall identity, or rule state is malformed
or ambiguous. If it cannot revoke a rule whose recorded baseline is absent, it
stops and reports failure without claiming rollback GREEN. If the subsequent
MediaMTX restore fails, it reports failure clearly; the Guest ingress remains
closed when the recorded baseline requires it.

## Cannot perform

This workflow cannot create accounts or groups, make broad ownership or ACL
changes, modify record storage, install packages, alter privileged policy,
update application code, alter unrelated units or services, tune networking,
change switch settings or MTU, configure OBS, modify the ZowieBox, use a broad
firewall reset, or change Anpviz publisher identity. It has no route to deploy
the Camera API, recording components, or Media Control.

For this feature, never use `scripts/upgrade.sh deploy`. That broader workflow
is retained for separate work but is outside this cutover's authorization.

## Expected topology and remaining gates

The resulting MediaMTX topology is:

| Path | Contract |
| --- | --- |
| `anpviz-video` | Existing RTSP pull, preserved |
| `anpviz-main` | Existing P3 publisher, preserved |
| `podium-computer` | Existing ZowieBox RTSP pull |
| `guest-computer` | Credential- and IP-restricted Guest RTMP publisher |

Physical acceptance remains a separate gate. The Guest Laptop's wired
Ethernet/dongle, DHCP reservation, route to KAMRUI, RTMP port reachability, and
power policy are **UNVERIFIED / PENDING PHYSICAL ACCEPTANCE** until collected
on that actual laptop. Do not configure or start OBS merely because this script
and its staging checks pass.

The Zowie AAC source repair is also a separate physical task: the source must
provide valid AAC SDP before `podium-computer` can be accepted as media-ready.
