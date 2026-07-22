// Documented adapter contract between the operator store and the EXISTING
// shared socket client (frontend/js/socket.js).
//
// The baseline socket client is the single realtime channel. It already:
//   - owns the /dashboard Socket.IO connection + reconnect (socket.js:45)
//   - forwards room:snapshot / room:delta / room:resumed into the shared
//     `roomState` store (socket.js:165-178) which our operator store subscribes to
//   - emits local events: 'command-sent', 'command-ack', 'state-sync',
//     'room-snapshot', 'disconnected' (socket.js:204-219)
//
// This adapter does NOT create a second connection. It wires the operator
// store's local-command tracking to the existing local events so locally
// issued commands stay visibly REQUESTED/PENDING until the matching ack arrives,
// and so disconnects are surfaced as STALE rather than silently dropped.
//
// === Adapter contract (consumed by operator-console components) ===
// {
//   roomStore,          // the shared roomState store (socket.js `roomState`)
//   operatorStore,      // createOperatorStore({ roomStore })
//   on(event, cb),      // subscribe to socket local events
//   off(event, cb),     // unsubscribe
//   sendCommand(deviceId, type, payload, cb),  // passthrough to socket.sendCommand
//   selectTarget(type, id), clearTarget(),     // passthrough
//   requestRoomSnapshot(opts),                  // passthrough
// }
//
// Integration is ADDITIVE: the existing media-control.js view continues to use
// socket.js directly. The operator console uses this adapter instead so its
// command lifecycle is observable through the operator store. No reserved file
// is edited by this module; wiring is performed at mount time only.

export const OPERATOR_SOCKET_EVENTS = Object.freeze([
  'command-sent',
  'command-ack',
  'state-sync',
  'room-snapshot',
  'disconnected',
  'connected',
]);

export function createOperatorSocketAdapter({ socket, roomStore, operatorStore }) {
  if (!socket || typeof socket.on !== 'function') {
    throw new Error('createOperatorSocketAdapter requires the socket client (on/off/sendCommand)');
  }
  if (!roomStore || !operatorStore) {
    throw new Error('createOperatorSocketAdapter requires roomStore and operatorStore');
  }

  const handlers = {
    'command-sent': (data) => {
      if (!data?.command_id) return;
      operatorStore.trackLocalCommand({
        commandId: data.command_id,
        target: data.device_id,
        type: data.type,
      });
    },
    'command-ack': (data) => {
      const commandId = data?.command_id || data?.id || null;
      if (commandId) operatorStore.resolveLocalCommand(commandId, data);
    },
    'state-sync': (data) => {
      const commandId = data?.state?.command_revision || data?.state?.telemetry?.last_command_id || null;
      if (commandId) operatorStore.resolveLocalCommand(commandId, { ok: true, status: 'acked' });
    },
    'disconnected': () => { operatorStore.refresh(); },
    'connected': () => { operatorStore.refresh(); },
    'room-snapshot': () => { operatorStore.refresh(); },
  };

  let wired = false;

  function connect() {
    if (wired) return;
    for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler);
    operatorStore.connect();
    wired = true;
  }

  function disconnect() {
    if (!wired) return;
    for (const [event, handler] of Object.entries(handlers)) socket.off(event, handler);
    operatorStore.disconnect();
    wired = false;
  }

  return {
    roomStore,
    operatorStore,
    connect,
    disconnect,
    // Passthroughs keep the console decoupled from the socket import surface.
    on: (event, cb) => socket.on(event, cb),
    off: (event, cb) => socket.off(event, cb),
    sendCommand: (deviceId, type, payload, cb) => socket.sendCommand(deviceId, type, payload, cb),
    selectTarget: (type, id) => socket.selectTarget(type, id),
    clearTarget: () => socket.clearTarget(),
    requestRoomSnapshot: (opts) => socket.requestRoomSnapshot(opts),
  };
}
