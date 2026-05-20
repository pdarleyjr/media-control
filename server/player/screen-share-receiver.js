/**
 * Screen-share receiver - runs inside the ScreenTinker player on each display.
 *
 * Listens on the device-namespace socket for screen-share events from the
 * server (which relays them from the broadcaster's dashboard socket). When a
 * session starts, mounts an HTML5 <video> element on top of the normal player
 * canvas with the incoming WebRTC track as its srcObject. When the session
 * ends (broadcaster stopped, preempted, or connection died), removes the
 * overlay and lets the normal playlist render resume.
 *
 * No imports / modules - this is loaded as a plain <script> from the player
 * HTML. It expects the device socket to already exist on window.__playerSocket
 * (set by the existing player JS), and ICE servers to be fetched lazily
 * the first time a session starts.
 *
 * Defensive: every event handler swallows its own errors and logs to console
 * so a malformed signaling packet from the server doesn't crash the player.
 */

(function () {
  'use strict';

  if (window.__screentinkerScreenShare) return;
  window.__screentinkerScreenShare = { active: false };

  var sock = null;
  var pc = null;
  var overlayEl = null;
  var videoEl = null;
  var iceConfig = null;
  var pendingRemoteCandidates = [];

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[screen-share-receiver]');
    console.log.apply(console, args);
  }
  function warn() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[screen-share-receiver]');
    console.warn.apply(console, args);
  }

  function ensureSocket() {
    if (sock) return sock;
    sock = window.__playerSocket || window.socket || null;
    if (!sock) {
      // Player has its own connect logic; we wait for it.
      return null;
    }
    wireSocketListeners();
    return sock;
  }

  function wireSocketListeners() {
    if (sock.__screenShareWired) return;
    sock.__screenShareWired = true;

    sock.on('device:screen-share-start', function () {
      log('session start');
      window.__screentinkerScreenShare.active = true;
      ensureIceConfig().then(function () {
        createPeerConnection();
      }).catch(function (e) {
        warn('failed to prepare ICE config:', e);
      });
    });

    sock.on('device:screen-share-offer', function (data) {
      log('offer received');
      handleOffer(data && data.sdp).catch(function (e) {
        warn('handleOffer failed:', e);
        emitEnded();
      });
    });

    sock.on('device:screen-share-ice-candidate', function (data) {
      var candidate = data && data.candidate;
      if (!candidate || !pc) {
        if (candidate) pendingRemoteCandidates.push(candidate);
        return;
      }
      if (!pc.remoteDescription) {
        pendingRemoteCandidates.push(candidate);
        return;
      }
      pc.addIceCandidate(candidate).catch(function (e) {
        warn('addIceCandidate failed:', e);
      });
    });

    sock.on('device:screen-share-end', function (data) {
      log('session end', data || {});
      teardown();
    });
  }

  function ensureIceConfig() {
    if (iceConfig) return Promise.resolve(iceConfig);
    // The player's device-token JWT doesn't grant access to the user-JWT-only
    // /api/screen-share/turn-credentials route. For now use STUN-only on the
    // receiver side - the broadcaster already gets the full TURN config.
    // Trickle ICE + symmetric NAT failures will fall back to TURN candidates
    // contributed by the broadcaster, which DOES get the full creds.
    iceConfig = {
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
      ],
      iceTransportPolicy: 'all',
    };
    return Promise.resolve(iceConfig);
  }

  function createPeerConnection() {
    if (pc) {
      try { pc.close(); } catch (_) { /* */ }
      pc = null;
    }
    pc = new RTCPeerConnection({
      iceServers: iceConfig.iceServers,
      iceTransportPolicy: iceConfig.iceTransportPolicy,
      bundlePolicy: 'max-bundle',
    });

    pc.onicecandidate = function (ev) {
      if (ev.candidate && sock) {
        sock.emit('device:screen-share-ice-candidate', {
          candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate,
        });
      }
    };

    pc.ontrack = function (ev) {
      log('track received:', ev.track.kind);
      mountOverlay();
      var stream = ev.streams && ev.streams[0];
      if (stream && videoEl) {
        videoEl.srcObject = stream;
      } else if (videoEl) {
        // No stream group - assemble from track
        if (!videoEl.srcObject) videoEl.srcObject = new MediaStream();
        videoEl.srcObject.addTrack(ev.track);
      }
    };

    pc.onconnectionstatechange = function () {
      log('pc state:', pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        // Give it a couple seconds in case ICE restart works.
        setTimeout(function () {
          if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
            warn('connection lost; tearing down');
            teardown();
            emitEnded();
          }
        }, 3000);
      }
    };
  }

  function handleOffer(sdp) {
    if (!sdp) return Promise.reject(new Error('empty sdp'));
    if (!pc) createPeerConnection();
    return pc.setRemoteDescription(sdp).then(function () {
      // Drain any candidates that arrived before the remote description.
      var drained = pendingRemoteCandidates.slice();
      pendingRemoteCandidates = [];
      var p = Promise.resolve();
      drained.forEach(function (c) {
        p = p.then(function () { return pc.addIceCandidate(c).catch(function () {}); });
      });
      return p;
    }).then(function () {
      return pc.createAnswer();
    }).then(function (answer) {
      return pc.setLocalDescription(answer).then(function () { return answer; });
    }).then(function () {
      sock.emit('device:screen-share-answer', { sdp: pc.localDescription });
    });
  }

  function mountOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'screen-share-overlay';
    overlayEl.style.cssText =
      'position:fixed;inset:0;background:#000;z-index:99999;' +
      'display:flex;align-items:center;justify-content:center;';
    videoEl = document.createElement('video');
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    // Receive-side audio is enabled by default; broadcasters who don't include
    // audio will simply have a silent track.
    videoEl.muted = false;
    videoEl.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;';
    overlayEl.appendChild(videoEl);
    document.body.appendChild(overlayEl);
    log('overlay mounted');
  }

  function unmountOverlay() {
    if (!overlayEl) return;
    try {
      if (videoEl && videoEl.srcObject) {
        videoEl.srcObject.getTracks().forEach(function (t) { t.stop(); });
        videoEl.srcObject = null;
      }
      overlayEl.remove();
    } catch (e) { warn('unmount error:', e); }
    overlayEl = null;
    videoEl = null;
    log('overlay removed');
  }

  function teardown() {
    if (pc) {
      try { pc.close(); } catch (_) { /* */ }
      pc = null;
    }
    pendingRemoteCandidates = [];
    unmountOverlay();
    window.__screentinkerScreenShare.active = false;
  }

  function emitEnded() {
    if (sock) sock.emit('device:screen-share-ended');
  }

  // Connection bootstrap: the player JS sets window.__playerSocket once
  // device authentication completes. Poll briefly until it shows up.
  function bootstrap() {
    if (ensureSocket()) {
      log('ready');
      return;
    }
    setTimeout(bootstrap, 250);
  }

  // Run after the page is interactive so window.__playerSocket has a chance
  // to be assigned.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
