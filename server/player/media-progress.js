/*
 * Software-only media progress telemetry.  This deliberately reports what the
 * renderer browser can observe; it never represents physical pixel, audio, or
 * touchscreen confirmation.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MbfdMediaProgress = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULT_STALL_THRESHOLD_MS = 30000;
  var SAFE_MESSAGES = {
    HLS_MANIFEST_LOAD_ERROR: 'HLS manifest could not be loaded.',
    HLS_FRAG_PARSING_ERROR: 'HLS media could not be decoded.',
    PLAYBACK_SOURCE_ERROR: 'Playback source could not be reached.',
    PLAYBACK_BUFFER_ERROR: 'Playback buffer could not advance.',
    PLAYBACK_DECODE_ERROR: 'Playback media could not be decoded.',
    PLAYBACK_UNKNOWN_ERROR: 'Playback failed.',
  };
  var SAFE_CODES = {
    HLS_MANIFEST_LOAD_ERROR: true,
    HLS_FRAG_PARSING_ERROR: true,
    PLAYBACK_SOURCE_ERROR: true,
    PLAYBACK_BUFFER_ERROR: true,
    PLAYBACK_DECODE_ERROR: true,
    PLAYBACK_UNKNOWN_ERROR: true,
    HTML5_MEDIA_ERR_ABORTED: true,
    HTML5_MEDIA_ERR_NETWORK: true,
    HTML5_MEDIA_ERR_DECODE: true,
    HTML5_MEDIA_ERR_SRC_NOT_SUPPORTED: true,
  };

  function finite(value) {
    if (value == null || value === '') return null;
    try {
      var number = Number(value);
      return Number.isFinite(number) ? number : null;
    } catch (_) {
      return null;
    }
  }

  function safeProperty(input, key) {
    try {
      return input == null ? null : input[key];
    } catch (_) {
      return null;
    }
  }

  function safeString(value) {
    try {
      return String(value == null ? '' : value);
    } catch (_) {
      return '';
    }
  }

  function safeCode(value, fallback) {
    var code = safeString(value || fallback || 'PLAYBACK_UNKNOWN_ERROR').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
      .replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
    return code || fallback || 'PLAYBACK_UNKNOWN_ERROR';
  }

  function allowlistedCode(value, fallback) {
    if (!safeString(value)) return fallback;
    var code = safeCode(value, '');
    return SAFE_CODES[code] ? code : fallback;
  }

  function safeMessage(code, fallback) {
    // Telemetry is diagnostic data, not a log transport.  Never permit an
    // exception message, URL, header, or vendor response to cross this API.
    return SAFE_MESSAGES[code] || fallback || SAFE_MESSAGES.PLAYBACK_UNKNOWN_ERROR;
  }

  function normalizePlaybackError(input) {
    var explicitCategory = safeString(safeProperty(input, 'category')).toUpperCase();
    var fatal = safeProperty(input, 'fatal') === true;
    var recoverable = safeProperty(input, 'recoverable');
    if (['NETWORK', 'MANIFEST', 'MEDIA', 'DECODE', 'SOURCE', 'BUFFER', 'UNKNOWN'].indexOf(explicitCategory) >= 0) {
      var explicitCode = allowlistedCode(safeProperty(input, 'code'),
        explicitCategory === 'NETWORK' || explicitCategory === 'SOURCE' || explicitCategory === 'MANIFEST'
          ? 'PLAYBACK_SOURCE_ERROR'
          : (explicitCategory === 'BUFFER' ? 'PLAYBACK_BUFFER_ERROR'
            : (explicitCategory === 'DECODE' ? 'PLAYBACK_DECODE_ERROR' : 'PLAYBACK_UNKNOWN_ERROR')));
      var explicitMessage = SAFE_MESSAGES[explicitCode]
        || (explicitCategory === 'NETWORK' || explicitCategory === 'SOURCE' || explicitCategory === 'MANIFEST'
          ? SAFE_MESSAGES.PLAYBACK_SOURCE_ERROR
          : (explicitCategory === 'BUFFER' ? SAFE_MESSAGES.PLAYBACK_BUFFER_ERROR
            : (explicitCategory === 'DECODE' ? SAFE_MESSAGES.PLAYBACK_DECODE_ERROR : SAFE_MESSAGES.PLAYBACK_UNKNOWN_ERROR)));
      return {
        category: explicitCategory,
        code: explicitCode,
        fatal: fatal,
        recoverable: !fatal && recoverable !== false,
        message: safeMessage(explicitCode, explicitMessage),
      };
    }
    var source = safeString(safeProperty(input, 'source')).toLowerCase();
    var type = safeString(safeProperty(input, 'type')).toLowerCase();
    var detailValue = safeProperty(input, 'details');
    if (detailValue == null || detailValue === '') detailValue = safeProperty(input, 'code');
    var rawDetails = safeString(detailValue);
    var details = rawDetails.toLowerCase();
    var category = 'UNKNOWN';
    var code = 'PLAYBACK_UNKNOWN_ERROR';
    if (source === 'html5' && /^\d+$/.test(rawDetails)) {
      var mediaCode = Number(rawDetails);
      if (mediaCode === 1) { category = 'MEDIA'; code = 'HTML5_MEDIA_ERR_ABORTED'; }
      else if (mediaCode === 2) { category = 'NETWORK'; code = 'HTML5_MEDIA_ERR_NETWORK'; }
      else if (mediaCode === 3) { category = 'DECODE'; code = 'HTML5_MEDIA_ERR_DECODE'; }
      else if (mediaCode === 4) { category = 'SOURCE'; code = 'HTML5_MEDIA_ERR_SRC_NOT_SUPPORTED'; }
    } else if (source === 'youtube') {
      category = /^(2|5|100|101|150)$/.test(String(rawDetails)) ? 'SOURCE' : 'MEDIA';
      code = category === 'SOURCE' ? 'PLAYBACK_SOURCE_ERROR' : 'PLAYBACK_UNKNOWN_ERROR';
    } else if (source === 'hls' && /manifest/.test(details)) {
      category = type === 'networkerror' ? 'NETWORK' : 'MANIFEST';
      code = /manifestloaderror/.test(details) ? 'HLS_MANIFEST_LOAD_ERROR' : 'PLAYBACK_SOURCE_ERROR';
    } else if (source === 'hls' && /(parsing|decode)/.test(details)) {
      category = 'DECODE'; code = /fragparsingerror/.test(details) ? 'HLS_FRAG_PARSING_ERROR' : 'PLAYBACK_DECODE_ERROR';
    } else if (source === 'hls' && /buffer/.test(details)) {
      category = 'BUFFER'; code = 'PLAYBACK_BUFFER_ERROR';
    } else if (source === 'hls' && /network/.test(type + ' ' + details)) {
      category = 'NETWORK'; code = 'PLAYBACK_SOURCE_ERROR';
    } else if (/(decode|media)/.test(type + ' ' + details)) {
      category = 'DECODE'; code = 'PLAYBACK_DECODE_ERROR';
    } else if (/(buffer|stalled|waiting)/.test(type + ' ' + details)) {
      category = 'BUFFER'; code = 'PLAYBACK_BUFFER_ERROR';
    } else if (/(source|network|fetch|load)/.test(type + ' ' + details)) {
      category = 'SOURCE'; code = 'PLAYBACK_SOURCE_ERROR';
    }
    code = allowlistedCode(code, category === 'NETWORK' || category === 'SOURCE' || category === 'MANIFEST'
      ? 'PLAYBACK_SOURCE_ERROR'
      : (category === 'BUFFER' ? 'PLAYBACK_BUFFER_ERROR'
        : (category === 'DECODE' ? 'PLAYBACK_DECODE_ERROR' : 'PLAYBACK_UNKNOWN_ERROR')));
    var message = SAFE_MESSAGES[code] || (category === 'NETWORK' || category === 'SOURCE'
      ? SAFE_MESSAGES.PLAYBACK_SOURCE_ERROR
      : (category === 'BUFFER' ? SAFE_MESSAGES.PLAYBACK_BUFFER_ERROR
        : (category === 'DECODE' ? SAFE_MESSAGES.PLAYBACK_DECODE_ERROR : SAFE_MESSAGES.PLAYBACK_UNKNOWN_ERROR)));
    return {
      category: category,
      code: code,
      fatal: fatal,
      recoverable: !fatal,
      message: safeMessage(code, message),
    };
  }

  function readDecodedFrames(video) {
    if (!video || typeof video.getVideoPlaybackQuality !== 'function') return null;
    try {
      var quality = video.getVideoPlaybackQuality();
      var raw = quality && quality.totalVideoFrames;
      if (raw == null || raw === '') return null;
      var number = Number(raw);
      return Number.isFinite(number) && number >= 0 ? number : null;
    } catch (_) {
      return null;
    }
  }

  function normalizeRendererProgressReport(report) {
    if (!report || typeof report !== 'object') return null;
    var errorInput = safeProperty(report, 'error');
    var normalizedError = errorInput && typeof errorInput === 'object'
      ? normalizePlaybackError(errorInput) : null;
    var commandId = safeString(safeProperty(report, 'command_id')).trim().slice(0, 128) || null;
    var playbackState = safeString(safeProperty(report, 'playback_state'));
    return {
      renderer_session_id: safeString(safeProperty(report, 'renderer_session_id')).trim().slice(0, 128) || null,
      content_generation: safeString(safeProperty(report, 'content_generation')).trim().slice(0, 128) || null,
      playback_state: ['IDLE', 'LOADING', 'PLAYING_PROGRESS', 'PAUSED', 'STALLED', 'RECOVERING', 'ERROR'].indexOf(playbackState) >= 0
        ? playbackState : 'IDLE',
      expected_playing: safeProperty(report, 'expected_playing') === true,
      decoded_frame_available: safeProperty(report, 'decoded_frame_available') === true,
      last_media_progress_at: finite(safeProperty(report, 'last_media_progress_at')),
      last_decoded_frame_progress_at: finite(safeProperty(report, 'last_decoded_frame_progress_at')),
      last_confirmed_render_progress_at: finite(safeProperty(report, 'last_confirmed_render_progress_at')),
      stall_started_at: finite(safeProperty(report, 'stall_started_at')),
      recovered_at: finite(safeProperty(report, 'recovered_at')),
      command_id: commandId,
      command_confirmation_at: commandId ? finite(safeProperty(report, 'command_confirmation_at')) : null,
      error: normalizedError ? Object.assign({}, normalizedError, {
        first_seen_at: finite(safeProperty(errorInput, 'first_seen_at')),
        last_seen_at: finite(safeProperty(errorInput, 'last_seen_at')),
        recovered_at: finite(safeProperty(errorInput, 'recovered_at')),
        active: safeProperty(errorInput, 'active') === true,
      }) : null,
      physical_pixels_observed: false,
    };
  }

  function createMediaProgressTracker(options) {
    options = options || {};
    var threshold = Math.max(1000, finite(options.stallThresholdMs) || DEFAULT_STALL_THRESHOLD_MS);
    var previousTime = null;
    var previousFrames = null;
    var lastMediaProgressAt = null;
    var lastFrameProgressAt = null;
    var expectedPlayingSinceAt = null;
    var stallStartedAt = null;
    var recoveredAt = null;
    var lastState = 'IDLE';
    var activeError = null;
    var lastError = null;
    var recoveryPending = false;
    var activeCommand = null;
    var seekInProgress = false;
    var generation = 0;
    var generationId = null;

    function reset() {
      previousTime = null;
      previousFrames = null;
      lastMediaProgressAt = null;
      lastFrameProgressAt = null;
      expectedPlayingSinceAt = null;
      stallStartedAt = null;
      recoveredAt = null;
      lastState = 'IDLE';
      activeError = null;
      lastError = null;
      recoveryPending = false;
      activeCommand = null;
      seekInProgress = false;
      generation += 1;
    }

    function setCommand(commandId, commandOptions) {
      var id = String(commandId || '').trim();
      if (!id) { activeCommand = null; return; }
      commandOptions = commandOptions || {};
      var applicableAt = finite(commandOptions.now);
      if (activeCommand && activeCommand.generation === generation && activeCommand.id === id) return false;
      activeCommand = {
        id: id.slice(0, 128),
        applicableAt: applicableAt == null ? Date.now() : applicableAt,
        generation: generation,
        confirmationAt: null,
        baselineEstablished: false,
        timeBaselineObserved: false,
        frameBaselineObserved: false,
        baselineTime: null,
        baselineFrames: null,
        awaitingPostSeekBaseline: seekInProgress,
      };
      return true;
    }

    function setGeneration(nextGenerationId) {
      var normalized = String(nextGenerationId == null ? '' : nextGenerationId).trim().slice(0, 128) || null;
      if (normalized === generationId) return false;
      generationId = normalized;
      reset();
      return true;
    }

    function establishCommandBaseline(command, currentTime, hasTime, frames, hasFrames) {
      command.baselineEstablished = true;
      command.timeBaselineObserved = hasTime;
      command.frameBaselineObserved = hasFrames;
      command.baselineTime = hasTime ? currentTime : null;
      command.baselineFrames = hasFrames ? frames : null;
    }

    function commandAdvanced(command, currentTime, hasTime, frames, hasFrames) {
      if (!command || !command.baselineEstablished) return false;
      if (hasFrames) {
        if (!command.frameBaselineObserved) {
          command.frameBaselineObserved = true;
          command.baselineFrames = frames;
          return false;
        }
        if (frames > command.baselineFrames) {
          command.baselineFrames = frames;
          if (hasTime) { command.timeBaselineObserved = true; command.baselineTime = currentTime; }
          return true;
        }
        return false;
      }
      if (!hasTime) return false;
      if (!command.timeBaselineObserved) {
        command.timeBaselineObserved = true;
        command.baselineTime = currentTime;
        return false;
      }
      if (currentTime > command.baselineTime + 0.025) {
        command.baselineTime = currentTime;
        return true;
      }
      return false;
    }

    function observe(sample) {
      sample = sample || {};
      var now = finite(sample.now);
      if (now == null) now = Date.now();
      var currentTime = finite(sample.current_time);
      var frames = finite(sample.decoded_frames);
      var hasTime = currentTime != null;
      var hasFrames = frames != null;
      var seekingNow = sample.seeking === true;
      var explicitSeekTransition = sample.seek_transition === true;
      var seekCompletionSample = !seekingNow && (explicitSeekTransition || seekInProgress);
      var seekTransition = seekingNow || explicitSeekTransition || seekCompletionSample;
      if (seekingNow) seekInProgress = true;
      else if (seekCompletionSample) seekInProgress = false;
      // A first observation establishes a baseline only. It is not evidence
      // that media time or decoded frames have advanced.
      var timeAdvanced = hasTime && previousTime != null && currentTime > previousTime + 0.025;
      var framesAdvanced = hasFrames && previousFrames != null && frames > previousFrames;
      if (hasTime) previousTime = currentTime;
      if (hasFrames) previousFrames = frames;
      // Seeking changes a clock without proving decoded/rendered progress.
      if (timeAdvanced && !seekTransition) lastMediaProgressAt = now;
      if (framesAdvanced && !seekTransition) lastFrameProgressAt = now;

      var normalizedError = sample.error ? normalizePlaybackError(sample.error) : null;
      if (normalizedError) {
        if (!activeError || activeError.code !== normalizedError.code) {
          activeError = Object.assign({}, normalizedError, { first_seen_at: now, last_seen_at: now, recovered_at: null, active: true });
        } else {
          activeError.last_seen_at = now;
          activeError.fatal = normalizedError.fatal;
          activeError.recoverable = normalizedError.recoverable;
        }
        lastError = activeError;
      } else if (activeError) {
        activeError = null;
        lastError = Object.assign({}, lastError, { recovered_at: now, active: false });
        recoveredAt = now;
        recoveryPending = true;
      }

      var expected = sample.expected_playing === true && sample.paused !== true
        && sample.ended !== true && sample.seeking !== true;
      if (expected && expectedPlayingSinceAt == null) expectedPlayingSinceAt = now;
      if (!expected) expectedPlayingSinceAt = null;
      var progressed = !seekTransition && (hasFrames ? framesAdvanced : timeAdvanced);
      var state;
      if (activeError) state = 'ERROR';
      else if (sample.seeking === true) state = 'LOADING';
      else if (sample.paused === true) state = 'PAUSED';
      else if (!expected) state = 'IDLE';
      else if (progressed && (recoveryPending || lastState === 'STALLED')) {
        state = 'RECOVERING'; recoveredAt = now; recoveryPending = false; stallStartedAt = null;
      } else {
        var relevantProgressAt = hasFrames ? lastFrameProgressAt : lastMediaProgressAt;
        var lastProgressAt = relevantProgressAt == null ? expectedPlayingSinceAt : relevantProgressAt;
        if (lastProgressAt != null && now - lastProgressAt >= threshold) {
          state = 'STALLED'; if (stallStartedAt == null) stallStartedAt = now;
        } else state = sample.loading === true ? 'LOADING' : 'PLAYING_PROGRESS';
      }
      if (state !== 'STALLED' && state !== 'RECOVERING' && !expected) stallStartedAt = null;
      lastState = state;

      if (activeCommand && activeCommand.generation === generation && activeCommand.confirmationAt == null) {
        // `applicableAt` and observation `now` are both renderer-local epoch
        // milliseconds (Date.now or the same injected test clock). They are
        // never compared with server receipt time or another clock domain.
        if (now < activeCommand.applicableAt) {
          // Causally earlier observations cannot establish a command baseline.
        } else if (seekingNow) {
          activeCommand.awaitingPostSeekBaseline = true;
        } else if (seekCompletionSample || activeCommand.awaitingPostSeekBaseline) {
          establishCommandBaseline(activeCommand, currentTime, hasTime, frames, hasFrames);
          activeCommand.awaitingPostSeekBaseline = false;
        } else if (!activeCommand.baselineEstablished) {
          establishCommandBaseline(activeCommand, currentTime, hasTime, frames, hasFrames);
        } else if (commandAdvanced(activeCommand, currentTime, hasTime, frames, hasFrames)) {
          activeCommand.confirmationAt = now;
        }
      }
      var confirmedRenderProgressAt = hasFrames ? lastFrameProgressAt : lastMediaProgressAt;
      return {
        playback_state: state,
        expected_playing: expected,
        decoded_frame_available: hasFrames,
        last_media_progress_at: lastMediaProgressAt,
        last_decoded_frame_progress_at: lastFrameProgressAt,
        last_confirmed_render_progress_at: confirmedRenderProgressAt,
        stall_started_at: stallStartedAt,
        recovered_at: recoveredAt,
        error: lastError ? Object.assign({}, lastError) : null,
        command_id: activeCommand && activeCommand.confirmationAt != null ? activeCommand.id : null,
        command_confirmation_at: activeCommand && activeCommand.confirmationAt != null ? activeCommand.confirmationAt : null,
        physical_pixels_observed: false,
      };
    }

    return { observe: observe, reset: reset, setCommand: setCommand, stallThresholdMs: threshold };
  }

  function RendererProgressRegistry(options) {
    options = options || {};
    this.maxEntries = Math.max(1, Math.floor(finite(options.maxEntries) || 50));
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.entries = new Map();
  }
  RendererProgressRegistry.prototype.record = function (displayId, report) {
    var id = String(displayId || '').trim();
    if (!id || !report || typeof report !== 'object') return null;
    report = normalizeRendererProgressReport(report);
    if (!report) return null;
    var observedAt = finite(this.now()) || Date.now();
    var prior = this.entries.get(id) || null;
    var rendererSessionId = report.renderer_session_id;
    var contentGeneration = report.content_generation;
    var lifecycleChanged = prior && (
      (rendererSessionId != null && rendererSessionId !== prior.renderer_session_id)
      || (contentGeneration != null && contentGeneration !== prior.content_generation)
    );
    var clientProgressAt = finite(report.last_confirmed_render_progress_at);
    var confirmedAt = lifecycleChanged ? null : (prior && prior.last_confirmed_render_progress_at || null);
    if (clientProgressAt != null && (!prior || lifecycleChanged || clientProgressAt > prior.client_render_progress_at)) confirmedAt = observedAt;
    var normalizedError = report.error;
    var entry = {
      observed_at: observedAt,
      renderer_session_id: rendererSessionId,
      content_generation: contentGeneration,
      playback_state: report.playback_state,
      expected_playing: report.expected_playing,
      decoded_frame_available: report.decoded_frame_available,
      last_media_progress_at: report.last_media_progress_at,
      last_decoded_frame_progress_at: report.last_decoded_frame_progress_at,
      last_confirmed_render_progress_at: confirmedAt,
      client_render_progress_at: clientProgressAt,
      stall_started_at: report.stall_started_at,
      recovered_at: report.recovered_at,
      command_id: lifecycleChanged ? null : (String(report.command_id || '').slice(0, 128) || null),
      command_confirmation_at: lifecycleChanged ? null : (report.command_id && finite(report.command_confirmation_at) != null ? observedAt : null),
      error: normalizedError ? Object.assign({}, normalizedError, {
        first_seen_at: report.error.first_seen_at, last_seen_at: report.error.last_seen_at,
        recovered_at: report.error.recovered_at, active: report.error.active,
      }) : null,
      physical_pixels_observed: false,
    };
    this.entries.delete(id);
    this.entries.set(id, entry);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    return Object.assign({}, entry, { client_render_progress_at: undefined });
  };
  RendererProgressRegistry.prototype.get = function (displayId) {
    var entry = this.entries.get(String(displayId || ''));
    return entry ? Object.assign({}, entry, { client_render_progress_at: undefined }) : null;
  };
  RendererProgressRegistry.prototype.clear = function () { this.entries.clear(); };

  return { DEFAULT_STALL_THRESHOLD_MS: DEFAULT_STALL_THRESHOLD_MS, createMediaProgressTracker: createMediaProgressTracker, normalizePlaybackError: normalizePlaybackError, normalizeRendererProgressReport: normalizeRendererProgressReport, readDecodedFrames: readDecodedFrames, RendererProgressRegistry: RendererProgressRegistry };
});
