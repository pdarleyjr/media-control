(function initDeviceContract(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MbfdDeviceContract = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildDeviceContract() {
  'use strict';

  const CONTRACT_VERSION = 1;
  const PLAYBACK_STATUSES = new Set(['loading', 'ready', 'playing', 'paused', 'stopped', 'error']);

  function uuid() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function text(value) {
    return value == null ? '' : String(value).trim();
  }

  function error(code, message, details) {
    return { ok: false, error: { code, message, details: details == null ? undefined : details } };
  }

  function actionFrom(input, payload) {
    return text(payload && payload.action) || text(input && input.action)
      || (text(input && input.type) !== 'device:command' && text(input && input.type) !== 'transport'
        ? text(input && input.type)
        : '');
  }

  function validateCommand(envelope) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return error('invalid_envelope', 'Command must be an object');
    }
    if (envelope.version !== CONTRACT_VERSION) return error('unsupported_version', 'Unsupported command contract version');
    if (envelope.type !== 'device:command') return error('invalid_type', 'Command type must be device:command');
    if (!text(envelope.command_id)) return error('invalid_command_id', 'command_id is required');
    if (!Number.isFinite(Date.parse(envelope.issued_at))) return error('invalid_issued_at', 'issued_at must be an ISO timestamp');
    if (envelope.target_scope !== 'display' && envelope.target_scope !== 'wall') {
      return error('invalid_target_scope', 'target_scope must be display or wall');
    }
    if (envelope.target_scope === 'display' && !text(envelope.device_id)) return error('missing_device_id', 'device_id is required');
    if (envelope.target_scope === 'wall' && !text(envelope.wall_id)) return error('missing_wall_id', 'wall_id is required');
    if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
      return error('invalid_payload', 'payload must be an object');
    }
    const action = text(envelope.payload.action);
    if (!action) return error('invalid_action', 'payload.action is required');
    if (action === 'go_to_slide') {
      const slide = Number(envelope.payload.slide ?? envelope.payload.page ?? envelope.payload.slide_index);
      if (!Number.isInteger(slide) || slide < 1) return error('invalid_slide', 'go_to_slide requires a positive integer slide');
    }
    if (action === 'seek') {
      const position = Number(envelope.payload.position_seconds ?? envelope.payload.position ?? envelope.payload.time);
      if (!Number.isFinite(position) || position < 0) return error('invalid_seek', 'seek requires a non-negative position');
    }
    return { ok: true, value: envelope };
  }

  function createCommand(input) {
    const source = input || {};
    const payload = source.payload && typeof source.payload === 'object' && !Array.isArray(source.payload)
      ? { ...source.payload }
      : {};
    const action = actionFrom(source, payload);
    if (action) payload.action = action;
    const deviceId = text(source.device_id || source.deviceId);
    const wallId = text(source.wall_id || source.wallId);
    const targetScope = source.target_scope || (wallId && !deviceId ? 'wall' : 'display');
    return {
      version: CONTRACT_VERSION,
      type: 'device:command',
      command_id: text(source.command_id || source.commandId) || uuid(),
      issued_at: source.issued_at || new Date().toISOString(),
      ...(deviceId ? { device_id: deviceId } : {}),
      ...(wallId ? { wall_id: wallId } : {}),
      target_scope: targetScope,
      payload,
    };
  }

  function normalizeCommand(input, defaults) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const canonical = source.type === 'device:command' && source.version === CONTRACT_VERSION;
    const value = canonical
      ? {
        ...source,
        ...(source.device_id || !defaults?.device_id ? {} : { device_id: defaults.device_id }),
        ...(source.wall_id || !defaults?.wall_id ? {} : { wall_id: defaults.wall_id }),
      }
      : createCommand({ ...(defaults || {}), ...source });
    const validation = validateCommand(value);
    if (!validation.ok) return validation;
    return { ok: true, value, legacy: !canonical };
  }

  function normalizeState(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const playbackStatus = PLAYBACK_STATUSES.has(source.playback_status)
      ? source.playback_status
      : (PLAYBACK_STATUSES.has(source.render_state) ? source.render_state : 'ready');
    const revision = Number(source.state_revision);
    return {
      ...source,
      device_id: text(source.device_id),
      playback_status: playbackStatus,
      updated_at: source.updated_at || new Date().toISOString(),
      state_revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    };
  }

  function createAck(input) {
    const source = input || {};
    const ok = source.ok !== false;
    const sourceError = source.error;
    const normalizedError = ok ? null : (
      sourceError && typeof sourceError === 'object'
        ? { code: text(sourceError.code) || 'command_failed', message: text(sourceError.message) || 'Command failed', ...(sourceError.details == null ? {} : { details: sourceError.details }) }
        : { code: 'command_failed', message: text(sourceError) || 'Command failed' }
    );
    return {
      version: CONTRACT_VERSION,
      type: 'device:ack',
      command_id: text(source.command_id),
      device_id: text(source.device_id),
      ok,
      error: normalizedError,
      state: source.state ? normalizeState(source.state) : null,
      completed_at: source.completed_at || new Date().toISOString(),
    };
  }

  return {
    CONTRACT_VERSION,
    createAck,
    createCommand,
    normalizeCommand,
    normalizeState,
    validateCommand,
  };
}));
