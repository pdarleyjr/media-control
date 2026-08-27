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
and start metadata. A legacy `latest` Compose is recorded only as a
`verified-legacy` snapshot with its exact observed immutable runtime identity;
the cutover never pulls `latest`.

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
script removes only the exact Guest RTMP rule it added and invokes
`scripts/rollback.sh` with the fresh verified snapshot. It does not attempt
rollback for a preflight-only failure because no active state has changed.
Preserve the snapshot and escalate if an automatic rollback fails.

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
