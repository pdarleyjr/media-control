'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');
const { installIsolatedTestDatabase } = require('./live-stream-test-db');

installIsolatedTestDatabase('node-protocol-socket');
process.env.CLASSROOM_LOCAL_CACHE_ENABLED = 'true';
process.env.CLASSROOM_LOCAL_CACHE_NODE_ID = 'classroom-1-p3';
process.env.CLASSROOM_LOCAL_CACHE_NODE_TOKEN = 'protocol-test-token';
process.env.CLASSROOM_LOCAL_CACHE_WORKSPACE_ID = 'protocol-test-workspace';

const setupDeviceSocket = require('../ws/deviceSocket');
const { emitContentPurge } = require('../lib/node-registry');

function once(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function startServer() {
  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  setupDeviceSocket(io);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return { httpServer, io, port: httpServer.address().port };
}

async function stopServer(server, clients = []) {
  clients.forEach((client) => client.disconnect());
  await new Promise((resolve) => server.io.close(resolve));
  if (server.httpServer.listening) {
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
}

async function availablePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, child, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (child && child.exitCode != null) throw new Error(`cache-agent exited early with ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for cache-agent behavior');
}

async function connectNode(port, protocolVersion, onPurge) {
  const auth = {
    token: 'protocol-test-token',
    node_id: 'classroom-1-p3',
    node_type: 'p3',
    role: 'node',
  };
  if (protocolVersion !== undefined) auth.cache_protocol_version = protocolVersion;
  const client = connectClient(`http://127.0.0.1:${port}/device`, {
    transports: ['websocket'],
    reconnection: false,
    autoConnect: false,
    auth,
  });
  if (onPurge) client.on('node:purge-content', onPurge);
  const connected = once(client, 'connect');
  const joined = once(client, 'node:joined');
  const manifest = once(client, 'node:sync-manifest');
  client.connect();
  await connected;
  await joined;
  return { client, manifest: await manifest };
}

test('old server ignores new P3 auth capability and its legacy arrays only prewarm', async () => {
  const cacheBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-old-server-new-p3-'));
  const contentId = 'old-server-legacy-video';
  const bytes = Buffer.from('old-server-new-agent');
  const item = {
    content_id: contentId,
    generation: 1,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
  const oldHttpServer = http.createServer((req, res) => {
    if (req.url === `/api/content/${contentId}/file`) {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
      return res.end(bytes);
    }
    res.writeHead(404);
    res.end();
  });
  const oldIo = new Server(oldHttpServer, { transports: ['websocket'] });
  let connectedSocket = null;
  const handshake = new Promise((resolve) => {
    oldIo.of('/device').on('connection', (socket) => {
      connectedSocket = socket;
      resolve(socket.handshake.auth);
      socket.emit('node:sync-manifest', [item]);
      socket.on('node:request-manifest', () => socket.emit('node:sync-manifest', [item]));
    });
  });
  await new Promise((resolve) => oldHttpServer.listen(0, '127.0.0.1', resolve));
  const agentPort = await availablePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'appliance', 'p3', 'room-agent', 'cache-agent.js')], {
    cwd: path.join(__dirname, '..', '..', 'appliance', 'p3', 'room-agent'),
    env: {
      ...process.env,
      NODE_PATH: path.join(__dirname, '..', 'node_modules'),
      MC_SERVER_LAN_URL: `http://127.0.0.1:${oldHttpServer.address().port}`,
      MC_NODE_ID: 'classroom-1-p3',
      MC_NODE_TOKEN: 'old-server-test-token',
      MC_AGENT_HOST: '127.0.0.1',
      MC_AGENT_PORT: String(agentPort),
      MBFD_ROOM_AGENT_CACHE_DIR: cacheBase,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const auth = await handshake;
    assert.equal(auth.cache_protocol_version, 2);
    const cachedPath = path.join(cacheBase, 'cache', 'content', contentId);
    await waitFor(() => fs.existsSync(cachedPath), child);
    assert.equal(fs.readFileSync(cachedPath).equals(bytes), true);

    connectedSocket.emit('node:sync-manifest', []);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(cachedPath), true);
  } catch (error) {
    error.message += stderr ? `\ncache-agent stderr:\n${stderr}` : '';
    throw error;
  } finally {
    if (child.exitCode == null) child.kill();
    await new Promise((resolve) => {
      if (child.exitCode != null) return resolve();
      const timer = setTimeout(resolve, 1000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await new Promise((resolve) => oldIo.close(resolve));
    if (oldHttpServer.listening) await new Promise((resolve) => oldHttpServer.close(resolve));
    fs.rmSync(cacheBase, { recursive: true, force: true });
  }
});

test('new server sends legacy arrays to old P3 nodes and after P3 rollback', async () => {
  const server = await startServer();
  const clients = [];
  try {
    const connection = await connectNode(server.port);
    clients.push(connection.client);
    assert.equal(Array.isArray(connection.manifest), true);
    const refreshed = once(connection.client, 'node:sync-manifest');
    connection.client.emit('node:request-manifest');
    assert.equal(Array.isArray(await refreshed), true);
  } finally {
    await stopServer(server, clients);
  }
});

test('new server sends authoritative v2 envelopes to new P3 nodes', async () => {
  const server = await startServer();
  const clients = [];
  try {
    const connection = await connectNode(server.port, 2);
    clients.push(connection.client);
    assert.deepEqual(connection.manifest, {
      protocol_version: 2,
      authoritative: true,
      generated_at: connection.manifest.generated_at,
      items: [],
    });
    const refreshed = once(connection.client, 'node:sync-manifest');
    connection.client.emit('node:request-manifest');
    assert.equal((await refreshed).protocol_version, 2);
  } finally {
    await stopServer(server, clients);
  }
});

test('a live heartbeat upgrades a legacy connection and immediately refreshes v2 state', async () => {
  const server = await startServer();
  const clients = [];
  try {
    const connection = await connectNode(server.port, undefined, (_payload, acknowledge) => {
      acknowledge({ ok: true, purged: true, absent_verified: true });
    });
    clients.push(connection.client);
    assert.equal(Array.isArray(connection.manifest), true);

    const upgradedManifest = once(connection.client, 'node:sync-manifest');
    connection.client.emit('node:heartbeat', { cache_protocol_version: 2 });
    const payload = await upgradedManifest;
    assert.equal(payload.protocol_version, 2);
    assert.equal(payload.authoritative, true);
    assert.deepEqual(payload.items, []);
    const purge = await emitContentPurge(server.io, {
      contentId: 'heartbeat-upgraded-purge',
      generation: 1,
      classroomCache: { enabled: true, nodeId: 'classroom-1-p3' },
    });
    assert.equal(purge.requested, true);
    assert.equal(purge.nodes[0].purged, true);
  } finally {
    await stopServer(server, clients);
  }
});

test('purge targets a live v2 node and requires verified absence', async () => {
  const server = await startServer();
  const clients = [];
  try {
    const connection = await connectNode(server.port, 2, (payload, acknowledge) => {
      acknowledge({
        ok: true,
        purged: true,
        absent_verified: true,
        content_id: payload.content_id,
      });
    });
    clients.push(connection.client);
    const result = await emitContentPurge(server.io, {
      contentId: 'socket-purge-v2',
      generation: 4,
      classroomCache: { enabled: true, nodeId: 'classroom-1-p3' },
    });

    assert.equal(result.requested, true);
    assert.equal(result.nodes[0].offline, false);
    assert.equal(result.nodes[0].purged, true);
    assert.equal(result.nodes[0].result.absent_verified, true);
  } finally {
    await stopServer(server, clients);
  }
});

test('purge reports a connected legacy node as protocol unsupported, not offline', async () => {
  const server = await startServer();
  const clients = [];
  try {
    const connection = await connectNode(server.port);
    clients.push(connection.client);
    const result = await emitContentPurge(server.io, {
      contentId: 'socket-purge-legacy',
      generation: 1,
      classroomCache: { enabled: true, nodeId: 'classroom-1-p3' },
    });

    assert.equal(result.requested, false);
    assert.equal(result.reason, 'protocol_unsupported');
    assert.equal(result.deferred_reconciliation, true);
    assert.deepEqual(result.nodes[0], {
      node_id: 'classroom-1-p3',
      requested: false,
      acknowledged: false,
      purged: false,
      offline: false,
      protocol_unsupported: true,
      deferred_reconciliation: true,
      reason: 'protocol_unsupported',
    });
  } finally {
    await stopServer(server, clients);
  }
});

test('purge reports an absent node as offline rather than protocol unsupported', async () => {
  const server = await startServer();
  try {
    const result = await emitContentPurge(server.io, {
      contentId: 'socket-purge-offline',
      generation: 1,
      classroomCache: { enabled: true, nodeId: 'classroom-1-p3' },
    });

    assert.equal(result.requested, false);
    assert.equal(result.reason, 'offline');
    assert.equal(result.nodes[0].offline, true);
    assert.equal(result.nodes[0].protocol_unsupported, false);
  } finally {
    await stopServer(server);
  }
});

test('invalid handshake protocol values remain on the legacy manifest path', async () => {
  const server = await startServer();
  const clients = [];
  try {
    for (const value of [Number.MAX_SAFE_INTEGER, -1, 'NaN', 1]) {
      const connection = await connectNode(server.port, value);
      clients.push(connection.client);
      assert.equal(Array.isArray(connection.manifest), true, String(value));
      connection.client.disconnect();
    }
  } finally {
    await stopServer(server, clients);
  }
});
