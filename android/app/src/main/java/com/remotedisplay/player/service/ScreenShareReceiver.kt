package com.remotedisplay.player.service

import android.content.Context
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import org.webrtc.AudioTrack
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SoftwareVideoEncoderFactory
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack

/**
 * WebRTC screen-share receiver for the Android player.
 *
 * Mirrors the JS receiver in [server/player/screen-share-receiver.js]:
 *   1. On `device:screen-share-start`, lazily init PeerConnectionFactory +
 *      create RTCPeerConnection with STUN + OpenRelay TURN.
 *   2. On `device:screen-share-offer`, setRemoteDescription, drain any
 *      pre-arrived ICE candidates, createAnswer, setLocalDescription,
 *      emit `device:screen-share-answer` over the existing Socket.IO
 *      device socket.
 *   3. On `device:screen-share-ice-candidate`, addIceCandidate (or buffer
 *      until remote description is set).
 *   4. On peer ICE state == CONNECTED, surface the bound [SurfaceViewRenderer]
 *      to MainActivity via [onOverlayShouldBeVisible]; on FAILED/CLOSED
 *      or `device:screen-share-end`, hide it.
 *
 * Threading: every WebRTC call must run on the worker thread the factory
 * is created on. We pin everything to a dedicated [PeerConnection.Observer]
 * + a private Handler tied to the factory's worker thread, marshaling all
 * external entry points back to the main thread for UI.
 *
 * Audio: routes through STREAM_MUSIC so it comes out of the TV speakers
 * (the WebRTC default is STREAM_VOICE_CALL which routes through the earpiece
 * on Android phones; on Fire TV it goes to the wrong audio device unless
 * we explicitly set MODE_NORMAL on the AudioManager).
 *
 * Lifecycle: instances are owned by MainActivity. Call [release] in
 * onDestroy. Sessions are torn down on view-detach by [teardown].
 */
class ScreenShareReceiver(
    private val context: Context,
    private val renderer: SurfaceViewRenderer,
    private val sendAnswer: (JSONObject) -> Unit,
    private val sendIceCandidate: (JSONObject) -> Unit,
    private val sendEnded: () -> Unit,
    private val onOverlayShouldBeVisible: (Boolean) -> Unit,
) {

    private val mainHandler = Handler(Looper.getMainLooper())
    private var eglBase: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var peerConnection: PeerConnection? = null
    private val pendingCandidates = mutableListOf<IceCandidate>()
    private var rendererInitialized = false
    private var sessionActive = false

    companion object {
        private const val TAG = "ScreenShareReceiver"

        // Layered ICE config. Matches the JS receiver one-for-one. The OpenRelay
        // credentials are intentionally public per Metered.ca's docs — embedding
        // them in client code is not a leak. Media stays DTLS-SRTP encrypted;
        // the relay only sees opaque packets.
        private fun buildIceServers(): List<PeerConnection.IceServer> {
            return listOf(
                PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer(),
                PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
                PeerConnection.IceServer.builder(
                    listOf(
                        "turn:openrelay.metered.ca:80",
                        "turn:openrelay.metered.ca:80?transport=tcp",
                        "turn:openrelay.metered.ca:443",
                        "turns:openrelay.metered.ca:443?transport=tcp",
                    )
                ).setUsername("openrelayproject")
                    .setPassword("openrelayproject")
                    .createIceServer(),
            )
        }
    }

    /**
     * Lazily initialize the EGL + PeerConnectionFactory + Renderer. Called on
     * first session-start so the cold-launch path of the player isn't slowed
     * down by WebRTC initialization (~300-500ms on Fire TV).
     */
    private fun ensureInitialized() {
        if (factory != null) return

        val initOptions = PeerConnectionFactory.InitializationOptions
            .builder(context.applicationContext)
            .setEnableInternalTracer(false)
            .createInitializationOptions()
        PeerConnectionFactory.initialize(initOptions)

        val egl = EglBase.create()
        eglBase = egl

        // Receive-only: we don't capture or encode. Software encoder factory
        // is a no-op stub satisfying the API. Decoder uses hardware MediaCodec
        // when available via DefaultVideoDecoderFactory.
        val decoderFactory = DefaultVideoDecoderFactory(egl.eglBaseContext)
        val encoderFactory = SoftwareVideoEncoderFactory()

        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(encoderFactory)
            .setVideoDecoderFactory(decoderFactory)
            .createPeerConnectionFactory()

        // Initialize the renderer surface once. Re-initializing while attached
        // crashes the EglRenderer; we guard with rendererInitialized.
        if (!rendererInitialized) {
            renderer.init(egl.eglBaseContext, null)
            renderer.setEnableHardwareScaler(true)
            rendererInitialized = true
        }

        // Route receive-side audio through TV speakers, not the phone earpiece.
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am.mode = AudioManager.MODE_NORMAL
        am.isSpeakerphoneOn = true

        Log.i(TAG, "PeerConnectionFactory + renderer initialized")
    }

    fun startSession() {
        mainHandler.post {
            runCatching {
                ensureInitialized()
                createPeerConnection()
                sessionActive = true
                Log.i(TAG, "session started")
            }.onFailure { Log.e(TAG, "startSession failed", it) }
        }
    }

    private fun createPeerConnection() {
        teardownPeer() // close any prior peer cleanly before opening a new one
        val rtcConfig = PeerConnection.RTCConfiguration(buildIceServers()).apply {
            iceTransportsType = PeerConnection.IceTransportsType.ALL
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }

        peerConnection = factory?.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                val out = JSONObject().apply {
                    put("sdpMid", candidate.sdpMid)
                    put("sdpMLineIndex", candidate.sdpMLineIndex)
                    put("candidate", candidate.sdp)
                }
                // Server expects { candidate: { sdpMid, sdpMLineIndex, candidate } }
                val envelope = JSONObject().apply { put("candidate", out) }
                runCatching { sendIceCandidate(envelope) }
                    .onFailure { Log.w(TAG, "sendIceCandidate failed: ${it.message}") }
            }

            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                Log.i(TAG, "ICE state: $state")
                when (state) {
                    PeerConnection.IceConnectionState.CONNECTED,
                    PeerConnection.IceConnectionState.COMPLETED -> {
                        mainHandler.post { onOverlayShouldBeVisible(true) }
                    }
                    PeerConnection.IceConnectionState.FAILED,
                    PeerConnection.IceConnectionState.DISCONNECTED,
                    PeerConnection.IceConnectionState.CLOSED -> {
                        // ICE FAILED is terminal; DISCONNECTED can recover but we
                        // give up after a short window to surface failure to the
                        // user. Match the JS receiver's 5s grace.
                        mainHandler.postDelayed({
                            val current = peerConnection?.iceConnectionState()
                            if (current == PeerConnection.IceConnectionState.FAILED ||
                                current == PeerConnection.IceConnectionState.DISCONNECTED ||
                                current == PeerConnection.IceConnectionState.CLOSED
                            ) {
                                Log.w(TAG, "ICE terminal ($current); tearing down session")
                                teardown(notifyServer = true)
                            }
                        }, 5000L)
                    }
                    else -> { /* CHECKING, NEW: no-op */ }
                }
            }

            override fun onAddStream(stream: MediaStream) {
                // Legacy Plan-B path; UnifiedPlan uses onAddTrack. Bind any
                // contained video track to the renderer as a belt-and-braces.
                stream.videoTracks?.firstOrNull()?.let { attachVideoTrack(it) }
                stream.audioTracks?.firstOrNull()?.let { attachAudioTrack(it) }
            }

            override fun onAddTrack(receiver: RtpReceiver, mediaStreams: Array<out MediaStream>?) {
                val track = receiver.track() ?: return
                when (track.kind()) {
                    "video" -> (track as? VideoTrack)?.let { attachVideoTrack(it) }
                    "audio" -> (track as? AudioTrack)?.let { attachAudioTrack(it) }
                }
            }

            // Unused observer callbacks (UnifiedPlan PeerConnection contract).
            override fun onSignalingChange(state: PeerConnection.SignalingState) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
            override fun onRemoveStream(stream: MediaStream) {}
            override fun onDataChannel(channel: org.webrtc.DataChannel) {}
            override fun onRenegotiationNeeded() {}
        }) ?: run {
            Log.e(TAG, "createPeerConnection returned null")
            return
        }
    }

    private fun attachVideoTrack(track: VideoTrack) {
        runCatching {
            track.setEnabled(true)
            track.addSink(renderer)
        }.onFailure { Log.e(TAG, "attachVideoTrack failed", it) }
    }

    private fun attachAudioTrack(track: AudioTrack) {
        runCatching {
            track.setEnabled(true)
            // Audio plays via the WebRTC native audio device; routing was already
            // set to STREAM_MUSIC in ensureInitialized().
        }.onFailure { Log.e(TAG, "attachAudioTrack failed", it) }
    }

    fun handleOffer(sdpPayload: JSONObject) {
        mainHandler.post {
            val pc = peerConnection ?: run {
                Log.w(TAG, "handleOffer with no peer connection; ignoring")
                return@post
            }
            val sdpType = sdpPayload.optString("type", "offer")
            val sdpDesc = sdpPayload.optString("sdp", "")
            if (sdpDesc.isEmpty()) {
                Log.w(TAG, "handleOffer with empty sdp")
                return@post
            }
            val offer = SessionDescription(SessionDescription.Type.fromCanonicalForm(sdpType), sdpDesc)
            pc.setRemoteDescription(object : SdpObserver {
                override fun onSetSuccess() {
                    drainPendingCandidates()
                    createAnswerInternal()
                }
                override fun onSetFailure(reason: String?) {
                    Log.e(TAG, "setRemoteDescription failed: $reason")
                    teardown(notifyServer = true)
                }
                override fun onCreateSuccess(p0: SessionDescription?) {}
                override fun onCreateFailure(p0: String?) {}
            }, offer)
        }
    }

    private fun createAnswerInternal() {
        val pc = peerConnection ?: return
        val constraints = MediaConstraints()
        pc.createAnswer(object : SdpObserver {
            override fun onCreateSuccess(answer: SessionDescription) {
                pc.setLocalDescription(object : SdpObserver {
                    override fun onSetSuccess() {
                        val out = JSONObject().apply {
                            put("sdp", JSONObject().apply {
                                put("type", answer.type.canonicalForm())
                                put("sdp", answer.description)
                            })
                        }
                        runCatching { sendAnswer(out) }
                            .onFailure { Log.w(TAG, "sendAnswer failed: ${it.message}") }
                    }
                    override fun onSetFailure(reason: String?) {
                        Log.e(TAG, "setLocalDescription failed: $reason")
                        teardown(notifyServer = true)
                    }
                    override fun onCreateSuccess(p0: SessionDescription?) {}
                    override fun onCreateFailure(p0: String?) {}
                }, answer)
            }
            override fun onCreateFailure(reason: String?) {
                Log.e(TAG, "createAnswer failed: $reason")
                teardown(notifyServer = true)
            }
            override fun onSetSuccess() {}
            override fun onSetFailure(p0: String?) {}
        }, constraints)
    }

    fun handleRemoteIceCandidate(candidatePayload: JSONObject) {
        mainHandler.post {
            val pc = peerConnection
            val sdpMid = candidatePayload.optString("sdpMid", "")
            val sdpMLineIndex = candidatePayload.optInt("sdpMLineIndex", 0)
            val sdp = candidatePayload.optString("candidate", "")
            if (sdp.isEmpty()) return@post
            val c = IceCandidate(sdpMid, sdpMLineIndex, sdp)
            if (pc == null || pc.remoteDescription == null) {
                pendingCandidates.add(c)
                return@post
            }
            pc.addIceCandidate(c)
        }
    }

    private fun drainPendingCandidates() {
        val pc = peerConnection ?: return
        val snapshot = pendingCandidates.toList()
        pendingCandidates.clear()
        for (c in snapshot) {
            runCatching { pc.addIceCandidate(c) }
                .onFailure { Log.w(TAG, "drained addIceCandidate failed: ${it.message}") }
        }
    }

    fun endSession() {
        mainHandler.post {
            Log.i(TAG, "session end from server")
            teardown(notifyServer = false)
        }
    }

    private fun teardown(notifyServer: Boolean) {
        if (!sessionActive && peerConnection == null) return
        sessionActive = false
        teardownPeer()
        pendingCandidates.clear()
        onOverlayShouldBeVisible(false)
        if (notifyServer) {
            runCatching { sendEnded() }
                .onFailure { Log.w(TAG, "sendEnded failed: ${it.message}") }
        }
    }

    private fun teardownPeer() {
        peerConnection?.let { pc ->
            runCatching { pc.close() }.onFailure { Log.w(TAG, "pc.close failed: ${it.message}") }
            runCatching { pc.dispose() }.onFailure { Log.w(TAG, "pc.dispose failed: ${it.message}") }
        }
        peerConnection = null
    }

    /**
     * Final release. Owners must call this from Activity.onDestroy to free
     * native resources. After release the receiver cannot be reused; create
     * a new instance for any subsequent sessions.
     */
    fun release() {
        teardown(notifyServer = false)
        runCatching {
            if (rendererInitialized) {
                renderer.release()
                rendererInitialized = false
            }
        }.onFailure { Log.w(TAG, "renderer.release failed: ${it.message}") }
        runCatching { factory?.dispose() }.onFailure { Log.w(TAG, "factory.dispose failed: ${it.message}") }
        factory = null
        runCatching { eglBase?.release() }.onFailure { Log.w(TAG, "eglBase.release failed: ${it.message}") }
        eglBase = null
    }
}
