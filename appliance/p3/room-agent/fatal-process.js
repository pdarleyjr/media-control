'use strict';

const fs = require('node:fs');

const INSTALL_KEY = Symbol.for('mbfd.p3.fatal-process-logging');

function installFatalProcessLogging(label) {
  if (process[INSTALL_KEY]) return;
  process[INSTALL_KEY] = true;
  const prefix = String(label || 'p3-agent').replace(/[\r\n]/g, '').slice(0, 64);

  // This monitor observes fatal failures without replacing Node's default exit
  // behavior. Synchronous stderr keeps the diagnostic even when the supervisor
  // immediately starts a fresh process.
  const writeFatal = (error, origin) => {
    const detail = error && error.stack ? error.stack : String(error);
    try {
      fs.writeSync(process.stderr.fd, `[${prefix}] ${origin || 'uncaughtException'}: ${detail}\n`);
    } catch (_) { /* Node will still terminate non-zero. */ }
  };

  process.on('uncaughtExceptionMonitor', (error, origin) => {
    writeFatal(error, origin);
  });
  process.on('unhandledRejection', (reason) => {
    writeFatal(reason, 'unhandledRejection');
    process.exit(1);
  });
}

module.exports = { installFatalProcessLogging };
