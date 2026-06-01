// Resumable, chunked upload endpoint (tus protocol) so multi-GB files reach the
// app THROUGH Cloudflare. Cloudflare's edge caps any single request body (~100MB
// Free/Pro), so a plain multipart POST of a 20GB master 413s at the edge. tus
// splits the file into small PATCH requests (chunkSize set client-side < 100MB),
// each of which sails under the CF limit, and resumes after drops (ideal for
// Starlink). On completion we hand the assembled file to finalizeUpload() so it
// becomes a normal content row (same metadata/thumbnail as the multipart path).
//
// Mounted in server.js behind requireAuth + resolveTenancy via:
//   const tusServer = require('./routes/tus');
//   const tusHandle = (req,res) => tusServer.handle(req,res);
//   app.all('/api/tus', requireAuth, resolveTenancy, tusHandle);
//   app.all('/api/tus/*', requireAuth, resolveTenancy, tusHandle);
// (app.all keeps req.url = /api/tus[/<id>] so it matches `path` below; auth runs
//  first so req.user / req.workspaceId are populated when onUploadFinish fires.)
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('@tus/server');
const { FileStore } = require('@tus/file-store');
const config = require('../config');
const { finalizeUpload } = require('../lib/finalize-upload');

// Partial uploads live under the same bind-mounted uploads dir so in-flight
// resumable uploads survive a container restart.
const TUS_DIR = path.join(config.uploadsDir, 'tus');
fs.mkdirSync(TUS_DIR, { recursive: true });

const MAX_SIZE = parseInt(process.env.MAX_FILE_SIZE_BYTES, 10) || (20 * 1024 * 1024 * 1024); // 20GB default

const tusServer = new Server({
  path: '/api/tus',
  datastore: new FileStore({ directory: TUS_DIR }),
  respectForwardedHeaders: true, // we sit behind the Cloudflare tunnel
  maxSize: MAX_SIZE,
  namingFunction: () => uuidv4(),
  async onUploadFinish(req, res, upload) {
    const md = upload.metadata || {};
    const absPath = (upload.storage && upload.storage.path)
      ? upload.storage.path
      : path.join(TUS_DIR, upload.id);
    let content;
    try {
      content = await finalizeUpload({
        absPath,
        originalName: md.filename || `upload-${upload.id}`,
        mimeType: md.filetype || 'application/octet-stream',
        size: upload.size,
        userId: req.user && req.user.id,
        workspaceId: req.workspaceId,
      });
    } catch (e) {
      // tus surfaces a thrown {status_code, body} to the client.
      throw { status_code: e.status || 500, body: JSON.stringify({ error: e.message || 'Finalize failed' }) };
    }
    // finalizeUpload moved the data file out; drop the tus .json sidecar too.
    try { fs.unlinkSync(absPath + '.json'); } catch { /* ignore */ }
    return {
      status_code: 200,
      headers: { 'X-Content-Id': content.id, 'Access-Control-Expose-Headers': 'X-Content-Id' },
      body: JSON.stringify(content),
    };
  },
});

module.exports = tusServer;
