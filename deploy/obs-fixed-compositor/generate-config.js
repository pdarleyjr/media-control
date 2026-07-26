#!/usr/bin/env node
'use strict';

/**
 * Generates the deterministic MBFD OBS profile and scene collection.
 *
 * Secrets are read only from the protected service environment and are written
 * only beneath OBS_CONFIG_HOME with owner-only permissions. Nothing secret is
 * printed or stored in source control.
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const COLLECTION = 'MBFD_FIXED_COMPOSITOR';
const CAMERA_SOURCE = 'MBFD_ANNKE_CAMERA';
const CONTENT_SOURCE = 'MBFD_LIVE_CONTENT';
const SCENES = Object.freeze([
  'MBFD_CAMERA_ONLY',
  'MBFD_CONTENT_MAIN_CAMERA_PIP',
  'MBFD_CAMERA_MAIN_CONTENT_PIP',
]);

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const keyint_sec = 2;
const AUDIO_SAMPLE_RATE = 48000;

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name, fallback, minimum, maximum) {
  const raw = String(process.env[name] || fallback);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function isPrivateAddress(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost') return true;

  const family = net.isIP(host);
  if (family === 4) {
    const octets = host.split('.').map(Number);
    return (
      octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    );
  }
  if (family === 6) {
    return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
  }
  return host.endsWith('.local') || host.endsWith('.ts.net');
}

function privateUrl(name, protocols) {
  const raw = required(name);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!protocols.includes(parsed.protocol) || !isPrivateAddress(parsed.hostname)) {
    throw new Error(`${name} must use ${protocols.join(' or ')} on a private address`);
  }
  return raw;
}

function outputHome() {
  const configured = required('OBS_CONFIG_HOME');
  const resolved = path.resolve(configured);
  if (!path.isAbsolute(resolved) || resolved === path.parse(resolved).root) {
    throw new Error('OBS_CONFIG_HOME must resolve to a dedicated absolute directory');
  }
  return resolved;
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writePrivate(file, content) {
  ensureDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function transform(positionX, positionY, boundsWidth, boundsHeight) {
  return {
    alignment: 5,
    bounds: { x: boundsWidth, y: boundsHeight },
    bounds_alignment: 0,
    bounds_type: 2,
    crop_bottom: 0,
    crop_left: 0,
    crop_right: 0,
    crop_top: 0,
    position: { x: positionX, y: positionY },
    rotation: 0,
    scale: { x: 1, y: 1 },
  };
}

function sceneItem(name, id, itemTransform) {
  return {
    align: 5,
    bounds: itemTransform.bounds,
    bounds_align: itemTransform.bounds_alignment,
    bounds_type: itemTransform.bounds_type,
    crop_bottom: 0,
    crop_left: 0,
    crop_right: 0,
    crop_top: 0,
    group_item_backup: false,
    id,
    locked: true,
    name,
    pos: itemTransform.position,
    private_settings: {},
    rot: 0,
    scale: itemTransform.scale,
    scale_filter: 'lanczos',
    visible: true,
  };
}

function scene(name, items) {
  return {
    balance: 0.5,
    deinterlace_field_order: 0,
    deinterlace_mode: 0,
    enabled: true,
    flags: 0,
    hotkeys: {},
    id: 'scene',
    mixers: 255,
    monitoring_type: 0,
    name,
    prev_ver: 503447555,
    private_settings: {},
    'push-to-mute': false,
    'push-to-mute-delay': 0,
    'push-to-talk': false,
    'push-to-talk-delay': 0,
    scene_items: items,
    settings: {
      custom_size: false,
      id_counter: items.length + 1,
      items: items.map((item) => ({ name: item.name, visible: item.visible })),
    },
    sync: 0,
    versioned_id: 'scene',
    volume: 1,
  };
}

function collection(cameraUrl, receiverUrl) {
  const cameraFull = transform(0, 0, WIDTH, HEIGHT);
  const contentFull = transform(0, 0, WIDTH, HEIGHT);
  const pip = transform(1328, 32, 560, 315);

  const cameraSource = {
    balance: 0.5,
    enabled: true,
    flags: 0,
    hotkeys: {},
    id: 'ffmpeg_source',
    mixers: 255,
    monitoring_type: 0,
    name: CAMERA_SOURCE,
    private_settings: {},
    settings: {
      buffering_mb: 8,
      clear_on_media_end: false,
      close_when_inactive: false,
      input: cameraUrl,
      is_local_file: false,
      local_file: '',
      looping: false,
      restart_on_activate: false,
    },
    sync: 0,
    versioned_id: 'ffmpeg_source',
    volume: 1,
  };

  const contentSource = {
    balance: 0.5,
    enabled: true,
    flags: 0,
    hotkeys: {},
    id: 'browser_source',
    mixers: 255,
    monitoring_type: 0,
    name: CONTENT_SOURCE,
    private_settings: {},
    settings: {
      css: 'body { background-color: rgba(0, 0, 0, 0); margin: 0; overflow: hidden; }',
      height: HEIGHT,
      is_local_file: false,
      reroute_audio: true,
      restart_when_active: false,
      shutdown: false,
      url: receiverUrl,
      width: WIDTH,
    },
    sync: 0,
    versioned_id: 'browser_source',
    volume: 1,
  };

  return {
    current_program_scene: SCENES[0],
    current_scene: SCENES[0],
    current_transition: 'Cut',
    groups: [],
    modules: {},
    name: COLLECTION,
    preview_locked: true,
    quick_transitions: [],
    saved_projectors: [],
    scaling_enabled: false,
    scene_order: SCENES.map((name) => ({ name })),
    sources: [
      cameraSource,
      contentSource,
      scene(SCENES[0], [
        sceneItem(CAMERA_SOURCE, 1, cameraFull),
      ]),
      scene(SCENES[1], [
        sceneItem(CONTENT_SOURCE, 1, contentFull),
        sceneItem(CAMERA_SOURCE, 2, pip),
      ]),
      scene(SCENES[2], [
        sceneItem(CAMERA_SOURCE, 1, cameraFull),
        sceneItem(CONTENT_SOURCE, 2, pip),
      ]),
      {
        balance: 0.5,
        enabled: true,
        flags: 0,
        hotkeys: {},
        id: 'cut_transition',
        mixers: 0,
        monitoring_type: 0,
        name: 'Cut',
        private_settings: {},
        settings: {},
        sync: 0,
        versioned_id: 'cut_transition',
        volume: 1,
      },
    ],
    transitions: [{ duration: 0, id: 1, name: 'Cut' }],
  };
}

function profileIni(hardwareEncoder, videoBitrateKbps, audioBitrateKbps) {
  return `[General]
Name=${COLLECTION}

[Video]
BaseCX=${WIDTH}
BaseCY=${HEIGHT}
OutputCX=${WIDTH}
OutputCY=${HEIGHT}
FPSType=1
FPSInt=${FPS}
ScaleType=lanczos
ColorFormat=NV12
ColorSpace=709
ColorRange=Partial

[Audio]
SampleRate=${AUDIO_SAMPLE_RATE}
ChannelSetup=Stereo

[Output]
Mode=Advanced

[AdvOut]
Encoder=${hardwareEncoder}
AudioEncoder=ffmpeg_aac
TrackIndex=1
VodTrackIndex=2
ApplyServiceSettings=true
UseRescale=false
Bitrate=${videoBitrateKbps}
KeyframeInterval=${keyint_sec}
BFrames=2
AudioBitrate=${audioBitrateKbps}

[SimpleOutput]
VBitrate=${videoBitrateKbps}
ABitrate=${audioBitrateKbps}
StreamEncoder=${hardwareEncoder}
RecQuality=Stream
UseAdvanced=true
Preset=balanced

[Log]
MaxLogs=5
MaxLogSize=10
`;
}

function main() {
  const home = outputHome();
  const cameraUrl = privateUrl('OBS_CAMERA_RTSP_URL', ['rtsp:', 'rtsps:']);
  const receiverUrl = privateUrl('LIVE_PROGRAM_RECEIVER_URL', ['http:', 'https:']);
  const websocketPassword = required('OBS_WEBSOCKET_PASSWORD');
  if (websocketPassword.length < 16) {
    throw new Error('OBS_WEBSOCKET_PASSWORD must contain at least 16 characters');
  }

  const websocketPort = integer('OBS_WEBSOCKET_PORT', 4455, 1024, 65535);
  const websocketBind = String(process.env.OBS_WEBSOCKET_BIND || '127.0.0.1').trim();
  if (!isPrivateAddress(websocketBind) || websocketBind === '0.0.0.0' || websocketBind === '::') {
    throw new Error('OBS_WEBSOCKET_BIND must be a specific private or loopback address');
  }

  const hardwareEncoder = required('OBS_H264_ENCODER');
  if (!hardwareEncoder || /x264|software/i.test(hardwareEncoder)) {
    throw new Error('OBS_H264_ENCODER must name a measured hardware H.264 encoder');
  }

  const rtmpServer = required('PEERTUBE_RTMP_SERVER');
  if (!/^rtmps?:\/\//i.test(rtmpServer)) {
    throw new Error('PEERTUBE_RTMP_SERVER must be an RTMP or RTMPS URL');
  }
  const streamKey = required('PEERTUBE_STREAM_KEY');
  const videoBitrateKbps = integer('OBS_VIDEO_BITRATE_KBPS', 6000, 1000, 20000);
  const audioBitrateKbps = integer('OBS_AUDIO_BITRATE_KBPS', 160, 64, 320);

  writePrivate(
    path.join(home, 'basic', 'scenes', `${COLLECTION}.json`),
    json(collection(cameraUrl, receiverUrl)),
  );
  writePrivate(
    path.join(home, 'basic', 'profiles', COLLECTION, 'basic.ini'),
    profileIni(hardwareEncoder, videoBitrateKbps, audioBitrateKbps),
  );
  writePrivate(
    path.join(home, 'basic', 'profiles', COLLECTION, 'service.json'),
    json({
      settings: {
        bwtest: false,
        key: streamKey,
        server: rtmpServer,
        use_auth: false,
      },
      type: 'rtmp_custom',
    }),
  );
  writePrivate(
    path.join(home, 'plugin_config', 'obs-websocket', 'config.json'),
    json({
      alerts_enabled: false,
      auth_required: true,
      first_load: false,
      server_bind_address: websocketBind,
      server_enabled: true,
      server_password: websocketPassword,
      server_port: websocketPort,
    }),
  );
  writePrivate(
    path.join(home, 'global.ini'),
    `[Basic]\nProfile=${COLLECTION}\nProfileDir=${COLLECTION}\nSceneCollection=${COLLECTION}\nSceneCollectionFile=${COLLECTION}\n`,
  );

  process.stdout.write(`OBS fixed-compositor configuration generated at ${home}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`OBS fixed-compositor configuration failed: ${error.message}\n`);
  process.exitCode = 1;
}
