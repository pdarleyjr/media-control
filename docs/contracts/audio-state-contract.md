# Audio State Contract

> Stable backend contract for classroom and program audio state.
> The UI/UX agent consumes this contract to render audio status UI.
> The managed program receiver agent owns this contract's schema and behavior.
>
> Last updated: 2026-07-22

## Purpose

This contract exposes confirmed audio state for two independent systems:

1. **Classroom playback audio** — the physical sound path from Media Control
   content through Windows to the classroom speakers/soundbar.
2. **Program audio** — the OBS/livestream/recording audio policy governing
   room microphone vs. content audio.

These are separate concerns. Classroom playback audio is what the instructor
and students hear in the room. Program audio is what goes to the livestream
and recording.

## Endpoint

```
GET /api/live-stream/audio-state
```

### Authorization

Requires an authenticated dashboard session with workspace access. The
program receiver (OBS browser source) receives this state as part of the
authoritative room snapshot via Socket.IO; it does not call this endpoint
directly.

### Response Schema

```json
{
  "classroom_audio": {
    "status": "confirmed | unconfirmed | error",
    "renderer_device_id": "string | null",
    "renderer_name": "string | null",
    "output_endpoint": "string | null",
    "muted": false,
    "volume": 0.8,
    "track_present": true,
    "autoplay_blocked": false,
    "last_confirmed_at": "2026-07-22T14:07:11Z"
  },
  "program_audio": {
    "room_mic_active": true,
    "content_audio_active": false,
    "screen_share_audio_active": false,
    "ducking_active": false,
    "recording_track_active": false,
    "stream_track_active": false
  }
}
```

### Field Definitions

#### classroom_audio

| Field | Type | Description |
|---|---|---|
| `status` | string | `confirmed` = physically verified output; `unconfirmed` = configured but not physically verified; `error` = diagnosed failure |
| `renderer_device_id` | string \| null | The display device ID that is the authoritative audio renderer. Safe identifier (not a raw device path). |
| `renderer_name` | string \| null | Human-readable name of the audio authority display. |
| `output_endpoint` | string \| null | Safe label for the Windows audio output endpoint (e.g. "HDMI Output 2"). Never a raw device path or credential. |
| `muted` | boolean | Whether the authoritative renderer is muted. |
| `volume` | number | Current volume (0.0–1.0) of the authoritative renderer. |
| `track_present` | boolean | Whether the current content has an audio track. |
| `autoplay_blocked` | boolean | Whether browser autoplay policy blocked audio. |
| `last_confirmed_at` | string \| null | ISO-8601 timestamp of last physical confirmation. Null if never confirmed. |

#### program_audio

| Field | Type | Description |
|---|---|---|
| `room_mic_active` | boolean | Whether the room microphone (ANNKE) is active on the OBS program. |
| `content_audio_active` | boolean | Whether Media Control direct content audio is active. |
| `screen_share_audio_active` | boolean | Whether screen-share direct audio is active. |
| `ducking_active` | boolean | Whether microphone ducking is currently engaged. |
| `recording_track_active` | boolean | Whether the OBS recording track is active. |
| `stream_track_active` | boolean | Whether the OBS stream track is active. |

## Socket.IO Integration

Audio state is included in the authoritative room snapshot under:

```
device:room-snapshot → snapshot.classroomProgram.audioState
```

### Revision Behavior

- Audio state changes bump the room revision.
- The receiver validates the revision is monotonically increasing.
- Older revisions are rejected (see `managed-bootstrap.js` → `validateRoomSnapshot`).

### Stale Behavior

- If `last_confirmed_at` is older than 60 seconds, `status` transitions to
  `unconfirmed`.
- If the room snapshot itself is stale (no snapshot received within
  `staleAfterMs`, default 20s), the receiver health transitions to `stale`
  and the UI should show a stale indicator.

### Error Behavior

- On audio diagnosis failure, `status` is `error` with `renderer_device_id`
  and `output_endpoint` set to null.
- The receiver health state machine transitions to `error` and surfaces the
  error code.
- Error details never include device credentials, private URLs, or tokens.

## OBS Audio Policy

The program audio state reflects the deliberate OBS audio policy:

| Scenario | Room Mic | Content Audio | Ducking |
|---|---|---|---|
| Instructor speech / silent presentation | Active | Inactive | Off |
| Media/video content with direct audio | Attenuated | Active | On |
| Camera-only view | Active | Inactive | Off |
| Screen share with audio | Controlled | Active (screen-share) | Conditional |

### Track Assignments

- **Livestream track**: room mic (ducked when content active) + content audio
- **Local recording track**: same as livestream
- **PeerTube VOD track**: same as livestream
- All tracks at 48 kHz throughout.
- No duplicated source, no monitoring loop, no feedback.

## Security Constraints

This contract MUST NOT expose:
- Device credentials or passwords
- Private/internal URLs (e.g. RTSP URLs, websocket passwords)
- Tokens or API keys
- Raw secret-bearing endpoint strings
- OBS websocket configuration

Safe user-facing identifiers only. The `renderer_device_id` is the Media
Control display ID (a UUID or `live-stream-program-*` hash), not a Windows
device path. The `output_endpoint` is a human-readable label, not a raw
hardware path.

## Validation

The receiver health state machine (`managed-bootstrap.js` →
`createReceiverHealth`) validates that the audio state is present in the
room snapshot. Missing or invalid audio state causes a transition to `error`
with code `INCOMPLETE_SNAPSHOT`.
