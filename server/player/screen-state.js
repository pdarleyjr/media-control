(function initScreenState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MbfdScreenState = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildScreenState() {
  'use strict';

  function normalizeRevision(value) {
    const revision = Number(value);
    return Number.isInteger(revision) && revision >= 0 ? revision : null;
  }

  function normalizeState(input) {
    const source = input && typeof input === 'object' ? input : {};
    return {
      screen_on: typeof source.screen_on === 'boolean' ? source.screen_on : true,
      target_revision: normalizeRevision(source.target_revision) ?? 0,
      command_revision: source.command_revision ? String(source.command_revision) : null,
    };
  }

  function createScreenStateController(options = {}) {
    const apply = typeof options.apply === 'function' ? options.apply : () => {};
    const persist = typeof options.persist === 'function' ? options.persist : () => {};
    let state = normalizeState(options.initialState);

    function snapshot() {
      return { ...state };
    }

    function paint() {
      apply(state.screen_on, snapshot());
    }

    function save() {
      persist(snapshot());
    }

    function applyCommand(command = {}) {
      if (typeof command.screen_on !== 'boolean') {
        return { applied: false, reason: 'invalid_screen_state', state: snapshot() };
      }
      const commandId = command.command_id ? String(command.command_id) : null;
      const revision = normalizeRevision(command.target_revision);
      if (revision == null && state.target_revision > 0 && commandId !== state.command_revision) {
        return { applied: false, reason: 'missing_revision', state: snapshot() };
      }
      if (revision != null && revision < state.target_revision) {
        return { applied: false, reason: 'stale_revision', state: snapshot() };
      }
      if (revision != null
          && revision === state.target_revision
          && state.command_revision
          && commandId !== state.command_revision
          && command.screen_on !== state.screen_on) {
        return { applied: false, reason: 'revision_conflict', state: snapshot() };
      }
      state = {
        screen_on: command.screen_on,
        target_revision: revision ?? state.target_revision,
        command_revision: commandId || state.command_revision,
      };
      paint();
      save();
      return { applied: true, reason: null, state: snapshot() };
    }

    function setLocal(screenOn) {
      if (typeof screenOn !== 'boolean') return snapshot();
      state = { ...state, screen_on: screenOn, command_revision: null };
      paint();
      save();
      return snapshot();
    }

    function restoreConfirmed(confirmed = {}) {
      if (typeof confirmed.screen_on !== 'boolean') return { restored: false, reason: 'missing_screen_state', state: snapshot() };
      const incomingCommand = confirmed.command_revision ? String(confirmed.command_revision) : null;
      if (state.command_revision && incomingCommand && state.command_revision !== incomingCommand) {
        return { restored: false, reason: 'command_conflict', state: snapshot() };
      }
      state = {
        ...state,
        screen_on: confirmed.screen_on,
        command_revision: incomingCommand || state.command_revision,
      };
      paint();
      save();
      return { restored: true, reason: null, state: snapshot() };
    }

    paint();
    return { applyCommand, restoreConfirmed, setLocal, snapshot };
  }

  return { createScreenStateController, normalizeState };
}));
