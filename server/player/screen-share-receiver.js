/**
 * Screen-share receiver - runs inside the Media Control player on each display.
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
  var setupTimer = null;

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

    sock.on('device:screen-share-start', function (data) {
      // wall_tile is optional: { screen_rect, player_rect } describing this
      // device's slice of the broadcast canvas. When present the overlay
      // becomes a tile of the wall (positioned via vw/vh with overflow:hidden
      // on the body so off-tile content is clipped). Absent => fullscreen.
      var wallTile = (data && data.wall_tile) || null;
      window.__screentinkerScreenShare.wallTile = wallTile;
      log('session start', wallTile ? 'wall-tile' : 'fullscreen');
      window.__screentinkerScreenShare.active = true;
      armSetupWatchdog();
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
        clearSetupWatchdog();
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
    clearSetupWatchdog();
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

  function clearSetupWatchdog() {
    if (setupTimer) { clearTimeout(setupTimer); setupTimer = null; }
  }

  function armSetupWatchdog() {
    clearSetupWatchdog();
    setupTimer = setTimeout(function () {
      warn('screen-share setup timed out before offer/connection');
      teardown();
      emitEnded();
    }, 15000);
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

    var wallTile = window.__screentinkerScreenShare.wallTile;
    if (wallTile && wallTile.screen_rect && wallTile.player_rect) {
      // Wall-tile mode. Mirrors the playlist's wall-stage CSS:
      //   stage left = (player.x - screen.x) / screen.w * 100 vw
      //   stage top  = (player.y - screen.y) / screen.h * 100 vh
      //   stage size = (player.w / screen.w) * 100 vw, (player.h / screen.h) * 100 vh
      // The stage commonly extends beyond the device's 100vw/100vh viewport
      // (e.g. 300vw wide for a 3-tile-wide row); body overflow:hidden clips it
      // so each TV shows only its slice of the broadcast.
      var s = wallTile.screen_rect, p = wallTile.player_rect;
      if (s.w > 0 && s.h > 0) {
        var left = ((p.x - s.x) / s.w) * 100;
        var top = ((p.y - s.y) / s.h) * 100;
        var width = (p.w / s.w) * 100;
        var height = (p.h / s.h) * 100;
        overlayEl.style.cssText =
          'position:fixed;background:#000;z-index:99999;overflow:hidden;' +
          'left:' + left + 'vw;top:' + top + 'vh;' +
          'width:' + width + 'vw;height:' + height + 'vh;';
        // Video fills the stage and is stretched (object-fit:fill) to match
        // the wall aspect. Each device sees only the visible-viewport slice.
        videoEl.style.cssText =
          'width:100%;height:100%;object-fit:fill;background:#000;display:block;';
        // Keep the page itself from showing scrollbars when the stage extends
        // outside the viewport (playerContainer already has overflow:hidden in
        // wall-mode, but the overlay sits at body level on top).
        document.documentElement.style.overflow = 'hidden';
        document.body.style.overflow = 'hidden';
      }
    } else {
      // Fullscreen mode (existing single-display behavior).
      overlayEl.style.cssText =
        'position:fixed;inset:0;background:#000;z-index:99999;' +
        'display:flex;align-items:center;justify-content:center;';
    }
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
    // Restore body / html overflow if wall-tile mode set them. Idempotent —
    // setting style.overflow = '' falls back to the stylesheet default.
    try {
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
    } catch (_) { /* */ }
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
    window.__screentinkerScreenShare.wallTile = null;
    log('overlay removed');
  }

  function teardown() {
    if (teardownTimer) { clearTimeout(teardownTimer); teardownTimer = null; }
    clearSetupWatchdog();
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
