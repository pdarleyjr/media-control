#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  ObsWebSocketV5,
} = require(path.join(__dirname, '..', '..', 'server', 'lib', 'obs-websocket-v5'));

const REQUIRED_SCENES = Object.freeze([
  'MBFD_CAMERA_ONLY',
  'MBFD_CONTENT_MAIN_CAMERA_PIP',
  'MBFD_CAMERA_MAIN_CONTENT_PIP',
]);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitBudget() {
  const index = process.argv.indexOf('--wait-ms');
  if (index < 0) return 0;
  const value = Number.parseInt(process.argv[index + 1], 10);
  if (!Number.isInteger(value) || value < 0 || value > 120000) {
    throw new Error('--wait-ms must be between 0 and 120000');
  }
  return value;
}

async function check() {
  const client = new ObsWebSocketV5({
    url: process.env.OBS_WEBSOCKET_URL || 'ws://127.0.0.1:4455',
    password: process.env.OBS_WEBSOCKET_PASSWORD,
    requestTimeoutMs: 5000,
  });

  try {
    const version = await client.getVersion();
    const sceneList = await client.getSceneList();
    const currentProgramSceneName = await client.getCurrentProgramScene();
    const streaming = await client.getStreamStatus();
    const actualScenes = sceneList.scenes.map((scene) => scene.sceneName);
    const missing = REQUIRED_SCENES.filter((scene) => !actualScenes.includes(scene));
    if (missing.length > 0) {
      throw new Error(`required OBS scenes missing: ${missing.join(', ')}`);
    }
    if (!REQUIRED_SCENES.includes(currentProgramSceneName)) {
      throw new Error(`unexpected OBS program scene: ${currentProgramSceneName}`);
    }
    return {
      ok: true,
      obs_version: version.obsVersion,
      websocket_version: version.obsWebSocketVersion,
      current_program_scene: currentProgramSceneName,
      output_active: streaming.active === true,
      required_scenes: REQUIRED_SCENES,
    };
  } finally {
    await client.close();
  }
}

async function main() {
  const budget = waitBudget();
  const deadline = Date.now() + budget;
  let lastError;
  do {
    try {
      const result = await check();
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await wait(Math.min(1000, Math.max(1, deadline - Date.now())));
    }
  } while (Date.now() <= deadline);

  throw lastError;
}

main().catch((error) => {
  process.stderr.write(`OBS fixed-compositor healthcheck failed: ${error.message}\n`);
  process.exitCode = 1;
});
