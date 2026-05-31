# MBFD Media Control Studio — Deploy & Rollback Runbook

Live: **https://media-control.mbfdhub.com** · Server: GMKtec (`ssh gmktec`) · Container/compose project + service: **`media-control`** · Deploy dir: **`/home/mbfd/media-control`** (app source under `app/`, internal port `3001` → host `127.0.0.1:8096`, CF tunnel `mbfdhub-gmktec`).

## Key paths
- App checkout: `/home/mbfd/media-control/app`
- DB (container): `/app/data/db/remote_display.db` · DB volume: `media-control_media_control_db`
- Uploads: `/app/server/uploads` (bind `/home/mbfd/media-control/data/uploads/`)
- DB backups: `/home/mbfd/backups/remote_display.<epoch>.db`
- Env: `/home/mbfd/media-control/.env` (Ollama / Nextcloud creds / DISABLE_REGISTRATION live here — NEVER in the repo)

## Deploy (server cannot auth to private GitHub → git bundle over scp)
From a workstation with the repo:
```sh
git bundle create /tmp/mc.bundle <prev-sha>..<branch>
scp /tmp/mc.bundle gmktec:/tmp/mc.bundle
ssh gmktec '
  cd /home/mbfd/media-control/app
  git fetch /tmp/mc.bundle <branch>
  git checkout -B <branch> FETCH_HEAD
  cd /home/mbfd/media-control
  # ALWAYS back up the DB before a deploy that touches schema.sql / database.js:
  docker run --rm -v media-control_media_control_db:/db -v /home/mbfd/backups:/out alpine \
    cp /db/remote_display.db /out/remote_display.$(date +%s).db
  CACHEBUST=$(git -C app rev-parse HEAD) docker compose -p media-control build --build-arg CACHEBUST=$CACHEBUST media-control
  docker compose -p media-control up -d media-control'
```
`CACHEBUST` is REQUIRED (BuildKit over-caches the COPY layer).

### Schema-change safety drill (do this BEFORE rebuilding on a schema change)
`db.exec(schema)` runs the WHOLE `schema.sql` at boot — a SQL typo crashes boot and takes the app down. Validate first:
```sh
ssh gmktec 'cd /home/mbfd/media-control/app && docker cp server/db/schema.sql media-control:/tmp/s.sql && \
  docker exec -w /app/server media-control node -e "const D=require(\"better-sqlite3\");const fs=require(\"fs\");const db=new D(\":memory:\");db.exec(fs.readFileSync(\"/tmp/s.sql\",\"utf8\"));console.log(\"SCHEMA_OK\")"'
```
Only rebuild if it prints `SCHEMA_OK`.

## Rollback (code)
```sh
ssh gmktec '
  cd /home/mbfd/media-control/app && git checkout -B main <previous_good_sha>
  cd /home/mbfd/media-control
  CACHEBUST=<previous_good_sha> docker compose -p media-control build --build-arg CACHEBUST=<previous_good_sha> media-control
  docker compose -p media-control up -d media-control'
```
Known-good SHAs: `f1cc6f2` (pre-studio classroom UX) · `c4e2510` (studio complete: Home/Presentations/AI/Player/Editor/Files/Downloads/Audit).

## Rollback (database)
The studio schema is purely additive (`CREATE TABLE IF NOT EXISTS` + try/catch'd `ALTER ADD COLUMN`) — rolling back code does NOT require a DB rollback. If you must restore a DB snapshot:
```sh
ssh gmktec '
  docker compose -p media-control stop media-control
  docker run --rm -v media-control_media_control_db:/db -v /home/mbfd/backups:/out alpine \
    sh -c "cp /out/remote_display.<EPOCH>.db /db/remote_display.db"
  docker compose -p media-control up -d media-control'
```
Restore uploads from a tarball the same way against the uploads bind dir.

## Health checks after deploy
```sh
ssh gmktec 'docker compose -p media-control ps; for p in /app /player /js/app.js; do echo "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8096$p) $p"; done'
```
Expect container `healthy` and `200` for each path. Then load https://media-control.mbfdhub.com/app (hard-refresh once after a frontend deploy — the network-first service worker pulls the new assets).

## Headless UI testing (Cloudflare-OTP-gated app)
`ssh -N -L 8096:127.0.0.1:8096 gmktec` then drive Playwright at `http://localhost:8096` (bypasses CF Access). To view authed UI without disturbing a real account, mint a short-lived view-only JWT server-side: `docker exec -i -w /app/server media-control node` ← `jwt.sign({id:<userId>}, require("./config").jwtSecret, {expiresIn:"30m"})`, then set it as `localStorage.token`.

## Module feature flags (disable a module without touching the core player)
In `.env`: `ENABLE_PRESENTATION_STUDIO`, `ENABLE_AI_DECK_BUILDER`, `ENABLE_MEDIA_DOWNLOADER`, `ENABLE_NEXTCLOUD_SYNC`, `ENABLE_VIDEO_WALL_STUDIO`, `ENABLE_BROADCAST_CENTER` (default on; set `=false` to disable). Recreate the container after editing `.env`.

## Operator follow-ups (to fully enable two modules)
- **Files (Nextcloud):** set `NEXTCLOUD_URL` / `NEXTCLOUD_USER` / `NEXTCLOUD_PASS` (a Nextcloud app-password) in `.env`. Because Nextcloud is behind CF Access, point `NEXTCLOUD_URL` at an internal origin OR add a CF Access service-token bypass for `/remote.php/dav`.
- **Downloads:** add `yt-dlp` (+ `ffmpeg`) to the Dockerfile (`apk add --no-cache yt-dlp ffmpeg`) and rebuild; until then `/api/downloads/health` reports `available:false` and jobs fail fast with a clear message.

## Security notes
- Ollama (`172.17.0.1:11434`) is reached server-side only; it must stay bound to localhost/bridge and NEVER be exposed through Cloudflare. AI is never called from the browser.
- Deck playback (`/player/deck/:id`) is intentionally public (under the CF-Access-bypassed `/player/*`) so displays load decks without OTP; deck IDs are unguessable UUIDs. Add short-lived signed tokens here if stronger gating is needed.
- Do NOT tighten the dashboard CSP (`server.js`): the UI depends on `scriptSrcAttr`/`styleSrcAttr` `unsafe-inline`.
