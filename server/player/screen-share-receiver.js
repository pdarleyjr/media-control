/**
 * Screen-share receiver - runs inside the ScreenTinker player on each display.
 *
 * Listens on the device-namespace socket for screen-share events from the
 * server (which relays them from the broadcaster's dashboard socket). When
 * a session reaches `connectionState === 'connected'`, mounts an HTML5
 * <video> element on top of the normal player canvas with the incoming
 * WebRTC track as its srcObject. While the connection is still being
 * established a small "Connecting..." chip is shown instead, so the
 * playlist underneath remains visible during handshake / ICE fallback.
 *
 * When the session ends (broadcaster stopped, preempted, or connection
 * died), removes the overlay and lets the normal playlist render resume.
 *
 * No imports / modules - loaded as a plain <script> from the player HTML.
 * Vanilla ES5-compatible syntax (var, function) so it loads on ancient
 * WebKit forks (Tizen 4, older WebOS, Fire TV stick Gen 1).
 *
 * Defensive: every event handler swallows its own errors and logs to
 * console so a malformed signaling packet from the server doesn't crash
 * the player.
 */

(function () {
  'use strict';

  if (window.__screentinkerScreenShare) return;
  window.__screentinkerScreenShare = { active: false };

  var sock = null;
  var pc = null;
  var overlayEl = null;
  var connectingChipEl = null;
  var videoEl = null;
  var iceConfig = null;
  var pendingRemoteCandidates = [];
  var teardownTimer = null;

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[screen-share-receiver]');
    try { console.log.apply(console, args); } catch (_) {}
  }
  function warn() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[screen-share-receiver]');
    try { console.warn.apply(console, args); } catch (_) {}
  }

  function ensureSocket() {
    if (sock) return sock;
    sock = window.__playerSocket || window.socket || null;
    if (!sock) return null;
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
        showConnectingChip();
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
      if (!candidate) return;
      if (!pc || !pc.remoteDescription) {
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

  // OpenRelay public TURN credentials are hardcoded here because the player's
  // device-token JWT doesn't grant access to the user-JWT-gated
  // /api/screen-share/turn-credentials route. OpenRelay creds are public by
  // design (https://www.metered.ca/tools/openrelay/) so embedding them in
  // client JS is not a leak. Media stays DTLS-SRTP encrypted; the relay
  // sees only opaque packets.
  function ensureIceConfig() {
    if (iceConfig) return Promise.resolve(iceConfig);
    iceConfig = {
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
        {
          urls: [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:80?transport=tcp',
            'turn:openrelay.metered.ca:443',
            'turns:openrelay.metered.ca:443?transport=tcp'
          ],
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ],
      iceTransportPolicy: 'all'
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
      bundlePolicy: 'max-bundle'
    });

    pc.onicecandidate = function (ev) {
      if (ev.candidate && sock && sock.connected) {
        sock.emit('device:screen-share-ice-candidate', {
          candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate
        });
      }
    };

    pc.ontrack = function (ev) {
      log('track received:', ev.track.kind);
      // Build the stream silently. We don't mount the overlay yet - that
      // waits for connectionState === 'connected' to avoid showing a black
      // overlay during a doomed ICE handshake (which would occlude the
      // normal playlist for up to 30 seconds before timeout fires).
      ensureBackgroundStream();
      var stream = ev.streams && ev.streams[0];
      if (stream && videoEl) {
        videoEl.srcObject = stream;
      } else if (videoEl) {
        if (!videoEl.srcObject) videoEl.srcObject = new MediaStream();
        videoEl.srcObject.addTrack(ev.track);
      }
    };

    pc.onconnectionstatechange = function () {
      if (!pc) return;
      var state = pc.connectionState;
      log('pc state:', state);
      if (state === 'connected') {
        if (teardownTimer) { clearTimeout(teardownTimer); teardownTimer = null; }
        mountOverlay();
        playVideo();
      } else if (state === 'failed') {
        warn('connection failed; tearing down');
        teardown();
        emitEnded();
      } else if (state === 'disconnected') {
        // Give it a few seconds for ICE restart / network recovery.
        if (teardownTimer) clearTimeout(teardownTimer);
        teardownTimer = setTimeout(function () {
          if (pc && pc.connectionState !== 'connected') {
            warn('disconnected too long; tearing down');
            teardown();
            emitEnded();
          }
        }, 5000);
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
        p = p.then(function () {
          return pc.addIceCandidate(c).catch(function () { /* tolerated */ });
        });
      });
      return p;
    }).then(function () {
      return pc.createAnswer();
    }).then(function (answer) {
      return pc.setLocalDescription(answer);
    }).then(function () {
      if (sock && sock.connected) {
        sock.emit('device:screen-share-answer', { sdp: pc.localDescription });
      }
    });
  }

  // Lightweight chip while we wait for the connection to come up. Sits in
  // the corner, doesn't occlude the playlist. Removed when the overlay
  // mounts or the session ends.
  function showConnectingChip() {
    if (connectingChipEl) return;
    connectingChipEl = document.createElement('div');
    connectingChipEl.id = 'screen-share-connecting';
    connectingChipEl.style.cssText =
      'position:fixed;top:16px;right:16px;background:rgba(59,130,246,0.95);' +
      'color:#fff;padding:8px 14px;border-radius:8px;z-index:99998;' +
      'font:13px -apple-system,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
    connectingChipEl.textContent = 'Screen share connecting…';
    document.body.appendChild(connectingChipEl);
  }

  function hideConnectingChip() {
    if (connectingChipEl) {
      try { connectingChipEl.remove(); } catch (_) {}
      connectingChipEl = null;
    }
  }

  // Pre-create the hidden video element so ontrack has somewhere to bind.
  // We don't mount it onto the page until connectionState === 'connected'.
  function ensureBackgroundStream() {
    if (videoEl) return;
    videoEl = document.createElement('video');
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = false; // receivers default to audio-on
    videoEl.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;';
  }

  function mountOverlay() {
    hideConnectingChip();
    if (overlayEl) return;
    if (!videoEl) ensureBackgroundStream();
    overlayEl = document.createElement('div');
    overlayEl.id = 'screen-share-overlay';
    overlayEl.style.cssText =
      'position:fixed;inset:0;background:#000;z-index:99999;' +
      'display:flex;align-items:center;justify-content:center;';
    overlayEl.appendChild(videoEl);
    document.body.appendChild(overlayEl);
    log('overlay mounted');
  }

  // Autoplay-policy fallback. If unmuted play() rejects (kiosk hasn't had a
  // user gesture in this page lifecycle), retry muted so the video is at
  // least visible. Audio comes back on the next user interaction via the
  // existing player JS unlock path.
  function playVideo() {
    if (!videoEl) return;
    var p = videoEl.play();
    if (p && typeof p.catch === 'function') {
      p.catch(function (err) {
        warn('play() rejected:', err && err.name);
        if (!videoEl.muted) {
          videoEl.muted = true;
          videoEl.play().catch(function (e2) {
            warn('muted-fallback play() failed:', e2 && e2.name);
          });
        }
      });
    }
  }

  function unmountOverlay() {
    hideConnectingChip();
    if (!overlayEl) {
      if (videoEl && videoEl.srcObject) {
        try { videoEl.srcObject.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
        videoEl.srcObject = null;
      }
      videoEl = null;
      return;
    }
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
    if (teardownTimer) { clearTimeout(teardownTimer); teardownTimer = null; }
    if (pc) {
      try { pc.close(); } catch (_) { /* */ }
      pc = null;
    }
    pendingRemoteCandidates = [];
    unmountOverlay();
    window.__screentinkerScreenShare.active = false;
  }

  function emitEnded() {
    if (sock && sock.connected) {
      try { sock.emit('device:screen-share-ended'); } catch (_) {}
    }
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
