// MBFD Media Control — per-user Nextcloud raw-FS microservice client.
//
// Wraps the box's two existing FastAPI services on the mbfd-ai Docker network
// (see config.nextcloud.userfsUrl / writeUrl):
//   - nextcloud-user-fs  (READ,  container :8000 / host :8003)
//   - nextcloud-write    (WRITE, container :8000 / host :8005)
//
// SECURITY / TRUST BOUNDARY (HARD GUARDRAIL):
// The microservices scope every operation by the `X-OpenWebUI-User-Email`
// header and TRUST IT BLINDLY (anyone on the network who sets it becomes that
// user). media-control is the trust boundary: callers here MUST pass the email
// from `req.user.email` (set by requireAuth from the JWT) — NEVER a client-
// supplied header. Every method takes `email` as its first argument and throws
// NextcloudNotConnectedError when it is falsy, so a route that forgot to wire
// the JWT email surfaces "not connected" instead of silently leaking.
//
// Both services ALSO require a service-level bearer token (config.nextcloud
// userfsToken / writeToken) so a rogue container can't reach them at all.
//
// Read is text-only (the :8003 /read_file returns a UTF-8 string capped at the
// service's MAX_READ_BYTES) — see readFile() for the binary caveat.

const config = require('../config');

const READ_TIMEOUT_MS = 15000;
const WRITE_TIMEOUT_MS = 60000;

// Minimal extension -> mime map for readFile()'s best-effort mime. The raw-FS
// read service does not return a content-type, so we infer one from the name.
const EXT_MIME = Object.freeze({
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  json: 'application/json',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

// Typed error so routes can map "not connected" / upstream failures to the
// right HTTP status without string-sniffing.
class NextcloudNotConnectedError extends Error {
  constructor(message) {
    super(message || 'Nextcloud not connected');
    this.name = 'NextcloudNotConnectedError';
    this.code = 'NC_NOT_CONNECTED';
  }
}

function nc() { return config.nextcloud || {}; }

// The email MUST originate from req.user.email — see the file header. Reject
// falsy here so a mis-wired route fails loud instead of leaking another tree.
function requireEmail(email) {
  if (!email || typeof email !== 'string') {
    throw new NextcloudNotConnectedError('Nextcloud requires an authenticated user email');
  }
  return email;
}

function mimeForName(name) {
  const dot = String(name || '').lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return EXT_MIME[String(name).slice(dot + 1).toLowerCase()] || 'application/octet-stream';
}

// POST JSON to one of the two services with both gates set:
//   - Authorization: Bearer <service token>   (network-level gate)
//   - X-OpenWebUI-User-Email: <email>          (per-user scoping gate)
// `base`/`token` pick which service. Throws NextcloudNotConnectedError on a
// transport failure / timeout, and a plain Error carrying `.status` on a
// non-2xx (so callers can pass the upstream status through, e.g. 404/415).
async function post(base, token, path, email, body, timeoutMs) {
  if (!base) throw new NextcloudNotConnectedError('Nextcloud microservice URL not configured');
  const headers = {
    'Content-Type': 'application/json',
    'X-OpenWebUI-User-Email': requireEmail(email),
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  let res;
  try {
    res = await fetch(base.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // Network error, DNS failure, or timeout — the service is unreachable.
    throw new NextcloudNotConnectedError('Nextcloud microservice unreachable: ' + (e && e.message ? e.message : e));
  }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j && j.detail ? j.detail : ''; } catch { /* non-JSON body */ }
    const err = new Error(`Nextcloud ${path} -> ${res.status}${detail ? ': ' + detail : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function postRead(path, email, body, timeoutMs) {
  return post(nc().userfsUrl, nc().userfsToken, path, email, body, timeoutMs || READ_TIMEOUT_MS);
}
function postWrite(path, email, body, timeoutMs) {
  return post(nc().writeUrl, nc().writeToken, path, email, body, timeoutMs || WRITE_TIMEOUT_MS);
}

// Normalize a :8003 list entry { name, path, type, size, mtime } into the
// frontend's existing file shape { name, is_dir, size, modified, path }.
// `mtime` is epoch SECONDS (float) -> ISO string so the UI's `new Date(...)`
// keeps rendering as it did for the old WebDAV path.
function normalizeEntry(e) {
  const isDir = e && e.type === 'directory';
  let modified = '';
  if (e && typeof e.mtime === 'number' && isFinite(e.mtime)) {
    modified = new Date(e.mtime * 1000).toISOString();
  }
  return {
    name: e && e.name ? e.name : '',
    is_dir: isDir,
    size: e && typeof e.size === 'number' ? e.size : 0,
    modified,
    path: e && e.path ? e.path : '',
    mime_type: isDir ? '' : mimeForName(e && e.name ? e.name : ''),
  };
}

// ---------------------- READ (nextcloud-user-fs) ----------------------

// List a directory relative to the caller's Files root ('' = root).
// Returns the frontend file shape, folders first then alpha (the service
// already sorts that way; we preserve order).
async function listDir(email, relPath) {
  const data = await postRead('/list_directory', email, { path: relPath || '' });
  const entries = data && Array.isArray(data.entries) ? data.entries : [];
  return entries.map(normalizeEntry);
}

// Read a file. NOTE: the :8003 read service is TEXT-ONLY — it returns a UTF-8
// decoded string (errors replaced) capped at its MAX_READ_BYTES (~2MB), with NO
// content-type. We surface the plan's documented { buffer, mime, name, size }
// shape by re-encoding the returned text and inferring mime from the name. This
// is fine for text; it is LOSSY for binary (image/video/pptx) because the bytes
// were already mangled by the upstream UTF-8 replace. Broadcasting binary media
// (Task P6-5) therefore needs a binary read endpoint on the service — flagged.
async function readFile(email, relPath) {
  const data = await postRead('/read_file', email, { path: relPath || '' });
  const name = String(relPath || '').split('/').pop() || 'file';
  const buffer = Buffer.from(data && typeof data.content === 'string' ? data.content : '', 'utf-8');
  return {
    buffer,
    mime: mimeForName(name),
    name,
    size: data && typeof data.size === 'number' ? data.size : buffer.length,
  };
}

// Metadata for one file/dir.
function getInfo(email, relPath) {
  return postRead('/get_file_info', email, { path: relPath || '' });
}

// Glob search under a subtree.
function search(email, relPath, pattern, maxResults) {
  return postRead('/search_files', email, {
    path: relPath || '',
    pattern,
    max_results: maxResults || 200,
  });
}

// Nested directory tree (limited depth).
function tree(email, relPath, maxDepth) {
  return postRead('/directory_tree', email, { path: relPath || '', max_depth: maxDepth || 3 });
}

// ---------------------- WRITE (nextcloud-write) ----------------------

// Save base64-encoded bytes to a path in the caller's Files. `base64` may be a
// raw base64 string or a data: URL (the service tolerates the prefix).
function writeBase64(email, relPath, base64, mime, ifExists) {
  return postWrite('/save_base64_file', email, {
    path: relPath,
    content_base64: base64,
    if_exists: ifExists || 'overwrite',
    // mime is not consumed by the service (it writes raw bytes); kept in the
    // signature for call-site clarity and future use.
  });
}

// Create a folder (and missing parents) — idempotent on the service side.
function createFolder(email, relPath) {
  return postWrite('/create_folder', email, { path: relPath });
}

// Move/rename within the caller's Files.
function moveFile(email, source, destination, overwrite) {
  return postWrite('/move_file', email, { source, destination, overwrite: !!overwrite });
}

// Delete (soft — the service moves it to the user's 'AI Trash', recoverable).
function deleteFile(email, relPath) {
  return postWrite('/delete_file', email, { path: relPath });
}

// ---------------------- health ----------------------

// Light connectivity probe for the per-user read path: list the Files root.
// Resolves (never rejects) to { connected, error? } so a route can render a
// "connected / not connected" banner without try/catch.
async function health(email) {
  if (!email) return { connected: false, error: 'not authenticated' };
  try {
    await listDir(email, '');
    return { connected: true };
  } catch (e) {
    return { connected: false, error: String(e && e.message ? e.message : e) };
  }
}

module.exports = {
  NextcloudNotConnectedError,
  // read
  listDir, readFile, getInfo, search, tree,
  // write
  writeBase64, createFolder, moveFile, deleteFile,
  // health + helpers (exported for unit tests)
  health, normalizeEntry, mimeForName,
};
