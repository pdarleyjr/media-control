const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

async function createExportZip() {
  const { createZipArchive } = require('../lib/zip-archive');
  const archive = createZipArchive({ zlib: { level: 1 } });
  const chunks = [];
  archive.on('data', (chunk) => chunks.push(chunk));
  const completed = once(archive, 'end');
  archive.append(JSON.stringify({ format: 'screentinker-export-v2' }), { name: 'export.json' });
  await archive.finalize();
  await completed;
  return Buffer.concat(chunks);
}

test('multipart ZIP import opens the independently issued temp upload and cleans all artifacts', async (t) => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-status-import-test-'));
  process.env.DB_PATH = path.join(testRoot, 'status-import.db');
  process.env.JWT_SECRET = 'status-import-test-secret-with-sufficient-length';

  const express = require('express');
  const jwt = require('jsonwebtoken');
  const config = require('../config');
  const { db } = require('../db/database');
  const router = require('../routes/status');
  const importRoot = path.join(os.tmpdir(), 'screentinker-import');
  const extractPrefix = 'screentinker-import-extract-';
  const extractBefore = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(extractPrefix)));
  const uploadBefore = new Set(fs.readdirSync(importRoot));

  db.prepare("INSERT INTO users (id,email,name,role) VALUES ('status-user','status@example.test','Status User','user')").run();

  const app = express();
  app.use('/api/status', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  const zip = await createExportZip();
  const unauthenticatedForm = new FormData();
  unauthenticatedForm.append('file', new Blob([zip], { type: 'application/zip' }), 'export.zip');
  const unauthenticatedResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/status/import`, {
    method: 'POST',
    body: unauthenticatedForm,
  });
  assert.equal(unauthenticatedResponse.status, 401);
  assert.deepEqual(fs.readdirSync(importRoot).filter((name) => !uploadBefore.has(name)), []);

  const token = jwt.sign({ id: 'status-user', current_workspace_id: 'status-workspace' }, config.jwtSecret);
  const form = new FormData();
  form.append('file', new Blob([zip], { type: 'application/zip' }), 'export.zip');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/status/import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await response.json();

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const uploadAfter = fs.readdirSync(importRoot).filter((name) => !uploadBefore.has(name));
  const extractAfter = fs.readdirSync(os.tmpdir())
    .filter((name) => name.startsWith(extractPrefix) && !extractBefore.has(name));
  assert.deepEqual(uploadAfter, []);
  assert.deepEqual(extractAfter, []);
});
