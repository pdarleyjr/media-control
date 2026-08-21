const fs = require('node:fs');
const util = require('node:util');

function formatFatalReason(reason) {
  if (reason && typeof reason.stack === 'string') return reason.stack;
  if (reason instanceof Error) return reason.message;
  return util.inspect(reason, { depth: 4, breakLength: Infinity });
}

function writeFatalEvent(eventName, reason) {
  const line = `[fatal] ${eventName}: ${formatFatalReason(reason)}\n`;
  fs.writeSync(2, line);
}

function installFatalProcessHandlers() {
  // Observe uncaught exceptions without replacing Node's default fatal action.
  process.on('uncaughtExceptionMonitor', (error) => {
    writeFatalEvent('uncaughtException', error);
  });

  // Installing an unhandledRejection listener suppresses Node's default action,
  // so terminate explicitly after the synchronous diagnostic is recorded.
  process.on('unhandledRejection', (reason) => {
    writeFatalEvent('unhandledRejection', reason);
    process.exit(1);
  });
}

module.exports = { installFatalProcessHandlers };
