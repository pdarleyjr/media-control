'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const OBS_OP = Object.freeze({
  HELLO: 0,
  IDENTIFY: 1,
  IDENTIFIED: 2,
  EVENT: 5,
  REQUEST: 6,
  REQUEST_RESPONSE: 7,
});

function buildObsAuthentication(password, salt, challenge) {
  const secret = crypto
    .createHash('sha256')
    .update(`${String(password || '')}${String(salt || '')}`)
    .digest('base64');
  return crypto
    .createHash('sha256')
    .update(`${secret}${String(challenge || '')}`)
    .digest('base64');
}

function privateIpv4(hostname) {
  const octets = String(hostname).split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  if (octets[0] === 10 || octets[0] === 127) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  // RFC 6598 shared address space, used by Tailscale.
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;
  return false;
}

function isPrivateWebSocketUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname === '::1') return true;
  if (net.isIPv4(hostname)) return privateIpv4(hostname);
  if (net.isIPv6(hostname)) {
    return hostname === '::1'
      || hostname.startsWith('fc')
      || hostname.startsWith('fd')
      || hostname.startsWith('fe80:');
  }
  return false;
}

function protocolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class ObsWebSocketV5 {
  constructor({
    url,
    password,
    requestTimeoutMs = 5000,
    webSocketFactory = null,
    randomUUID = crypto.randomUUID,
    cameraInputName = 'MBFD_ANPVIZ_CAMERA',
    contentInputName = 'MBFD_LIVE_CONTENT',
  } = {}) {
    if (!isPrivateWebSocketUrl(url)) {
      throw protocolError('OBS_ENDPOINT_NOT_PRIVATE', 'OBS WebSocket must use a private loopback, LAN, or Tailscale address');
    }
    if (!String(password || '')) {
      throw protocolError('OBS_AUTH_REQUIRED', 'OBS WebSocket password is required');
    }
    this.url = String(url);
    this.password = String(password);
    this.requestTimeoutMs = Math.max(250, Number(requestTimeoutMs) || 5000);
    this.webSocketFactory = webSocketFactory || ((socketUrl) => new WebSocket(socketUrl));
    this.randomUUID = randomUUID;
    this.cameraInputName = cameraInputName;
    this.contentInputName = contentInputName;
    this.socket = null;
    this.connectPromise = null;
    this.pending = new Map();
    this.identifiedResolve = null;
    this.identifiedReject = null;
  }

  connect() {
    if (this.socket && this.socket.readyState === 1 && !this.connectPromise) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      this.identifiedResolve = () => {
        this.connectPromise = null;
        resolve();
      };
      this.identifiedReject = (error) => {
        this.connectPromise = null;
        reject(error);
      };
      try {
        const socket = this.webSocketFactory(this.url);
        this.socket = socket;
        socket.addEventListener('message', (event) => this.onMessage(event));
        socket.addEventListener('error', () => {
          this.rejectConnection(protocolError('OBS_CONNECTION_FAILED', 'OBS WebSocket connection failed'));
        });
        socket.addEventListener('close', () => {
          this.rejectConnection(protocolError('OBS_CONNECTION_CLOSED', 'OBS WebSocket connection closed'));
          this.rejectPending(protocolError('OBS_CONNECTION_CLOSED', 'OBS WebSocket connection closed'));
          this.socket = null;
        });
      } catch {
        this.rejectConnection(protocolError('OBS_CONNECTION_FAILED', 'OBS WebSocket connection failed'));
      }
    });
    return this.connectPromise;
  }

  rejectConnection(error) {
    if (!this.identifiedReject) return;
    const reject = this.identifiedReject;
    this.identifiedReject = null;
    this.identifiedResolve = null;
    reject(error);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  onMessage(event) {
    let frame;
    try {
      frame = JSON.parse(String(event && event.data != null ? event.data : ''));
    } catch {
      return;
    }
    if (frame.op === OBS_OP.HELLO) {
      const auth = frame.d && frame.d.authentication;
      if (!auth || !auth.salt || !auth.challenge) {
        this.rejectConnection(protocolError('OBS_AUTH_REQUIRED', 'OBS WebSocket authentication challenge is required'));
        return;
      }
      const authentication = buildObsAuthentication(this.password, auth.salt, auth.challenge);
      this.socket.send(JSON.stringify({
        op: OBS_OP.IDENTIFY,
        d: {
          rpcVersion: 1,
          authentication,
          eventSubscriptions: 0,
        },
      }));
      return;
    }
    if (frame.op === OBS_OP.IDENTIFIED) {
      const resolve = this.identifiedResolve;
      this.identifiedResolve = null;
      this.identifiedReject = null;
      if (resolve) resolve();
      return;
    }
    if (frame.op !== OBS_OP.REQUEST_RESPONSE || !frame.d) return;
    const pending = this.pending.get(String(frame.d.requestId || ''));
    if (!pending) return;
    this.pending.delete(String(frame.d.requestId));
    clearTimeout(pending.timer);
    const status = frame.d.requestStatus || {};
    if (status.result !== true) {
      pending.reject(protocolError(
        'OBS_REQUEST_FAILED',
        `OBS ${frame.d.requestType || pending.requestType} failed with code ${status.code || 'unknown'}`,
      ));
      return;
    }
    pending.resolve(frame.d.responseData || {});
  }

  async request(requestType, requestData = {}) {
    await this.connect();
    if (!this.socket || this.socket.readyState !== 1) {
      throw protocolError('OBS_CONNECTION_FAILED', 'OBS WebSocket is not connected');
    }
    const requestId = this.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(protocolError('OBS_REQUEST_TIMEOUT', `OBS ${requestType} did not respond in time`));
      }, this.requestTimeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(requestId, { requestType, resolve, reject, timer });
      this.socket.send(JSON.stringify({
        op: OBS_OP.REQUEST,
        d: { requestType, requestId, requestData },
      }));
    });
  }

  async getCurrentProgramScene() {
    const data = await this.request('GetCurrentProgramScene');
    return data.currentProgramSceneName || null;
  }

  async getVersion() {
    const data = await this.request('GetVersion');
    return {
      obsVersion: data.obsVersion || null,
      obsWebSocketVersion: data.obsWebSocketVersion || null,
      rpcVersion: Number.isFinite(Number(data.rpcVersion)) ? Number(data.rpcVersion) : null,
    };
  }

  async getSceneList() {
    const data = await this.request('GetSceneList');
    return {
      currentProgramSceneName: data.currentProgramSceneName || null,
      currentPreviewSceneName: data.currentPreviewSceneName || null,
      scenes: Array.isArray(data.scenes) ? data.scenes : [],
    };
  }

  async setCurrentProgramSceneConfirmed(sceneName) {
    await this.request('SetCurrentProgramScene', { sceneName });
    const currentProgramSceneName = await this.getCurrentProgramScene();
    if (currentProgramSceneName !== sceneName) {
      throw protocolError(
        'OBS_SCENE_NOT_CONFIRMED',
        `OBS did not confirm requested program scene ${sceneName}`,
      );
    }
    return { currentProgramSceneName };
  }

  async setInputMuted(inputName, inputMuted) {
    await this.request('SetInputMute', { inputName, inputMuted: !!inputMuted });
  }

  async setAudioPolicy(policy) {
    if (policy !== 'camera' && policy !== 'content_replace') {
      throw protocolError('INVALID_AUDIO_POLICY', 'Audio policy must be camera or content_replace');
    }
    // Fail-safe silence first, then enable exactly one source. This ordering
    // prevents even a brief camera/content mix during a policy transition.
    await this.setInputMuted(this.cameraInputName, true);
    await this.setInputMuted(this.contentInputName, true);
    if (policy === 'content_replace') {
      await this.setInputMuted(this.contentInputName, false);
    } else {
      await this.setInputMuted(this.cameraInputName, false);
    }
    return {
      policy,
      mixed: false,
      camera_muted: policy === 'content_replace',
      content_muted: policy !== 'content_replace',
    };
  }

  async health() {
    try {
      const [version, currentProgramSceneName, stream] = await Promise.all([
        this.getVersion(),
        this.getCurrentProgramScene(),
        this.getStreamStatus(),
      ]);
      return {
        available: true,
        obsVersion: version.obsVersion || null,
        obsWebSocketVersion: version.obsWebSocketVersion || null,
        currentProgramSceneName,
        stream,
      };
    } catch (error) {
      return {
        available: false,
        code: error.code || 'OBS_UNAVAILABLE',
        message: error.message || 'OBS is unavailable',
      };
    }
  }

  async getStreamStatus() {
    const data = await this.request('GetStreamStatus');
    return {
      active: data.outputActive === true,
      reconnecting: data.outputReconnecting === true,
      congestion: Number.isFinite(Number(data.outputCongestion))
        ? Number(data.outputCongestion)
        : null,
    };
  }

  async startStreaming() {
    const before = await this.getStreamStatus();
    if (!before.active) await this.request('StartStream');
    return this.getStreamStatus();
  }

  async stopStreaming() {
    const before = await this.getStreamStatus();
    if (before.active) await this.request('StopStream');
    return this.getStreamStatus();
  }

  close() {
    if (this.socket) {
      try { this.socket.close(); } catch (_) {}
    }
    this.socket = null;
    this.connectPromise = null;
    this.rejectPending(protocolError('OBS_CONNECTION_CLOSED', 'OBS WebSocket connection closed'));
  }
}

module.exports = {
  OBS_OP,
  ObsWebSocketV5,
  buildObsAuthentication,
  isPrivateWebSocketUrl,
};
