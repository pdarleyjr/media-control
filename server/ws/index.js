const setupDeviceSocket = require('./deviceSocket');
const setupDashboardSocket = require('./dashboardSocket');
const { setupScreenShareSignaling } = require('./screen-share-signaling');
const { canActOnDevice, getDeviceIdForSocket } = require('../lib/socket-permissions');

module.exports = function setupWebSockets(io) {
  const deviceNs = setupDeviceSocket(io);
  const dashboardNs = setupDashboardSocket(io);

  // WebRTC screen-share signaling layer.
  // Registers additional 'connection' handlers on both namespaces - Socket.IO
  // supports multiple connection handlers, they all run in order. Each handler
  // attaches its own .on(eventName) listeners; events route to the right
  // handler by name, so this composes cleanly with the existing handlers in
  // ws/dashboardSocket.js and ws/deviceSocket.js.
  const screenShare = setupScreenShareSignaling({
    dashboardNs,
    deviceNs,
    canActOnDevice,
    deviceSocketRegistry: { getDeviceId: getDeviceIdForSocket },
  });

  return { deviceNs, dashboardNs, screenShare };
};
