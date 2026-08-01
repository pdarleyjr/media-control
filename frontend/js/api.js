const API_BASE = '/api';

function getAuthHeaders() {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function normalizeApiPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\\\u0000-\u001f]/.test(value)) {
    throw new TypeError('API path must be a root-relative path');
  }
  const candidate = new URL(`${API_BASE}${value}`, window.location.origin);
  if (
    candidate.origin !== window.location.origin
    || !candidate.pathname.startsWith(`${API_BASE}/`)
    || candidate.username
    || candidate.password
    || candidate.hash
  ) {
    throw new TypeError('API path must remain on the current origin');
  }
  return `${candidate.pathname}${candidate.search}`;
}

async function request(url, options = {}) {
  const { headers: optionHeaders = {}, ...requestOptions } = options;
  const res = await fetch(normalizeApiPath(url), {
    ...requestOptions,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...optionHeaders },
  });
  if (res.status === 401) {
    // Token expired or invalid - redirect to login
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.hash = '#/login';
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const error = new Error(err.error || 'Request failed');
    error.status = res.status;
    error.code = err.code;
    error.details = err;
    throw error;
  }
  return res.json();
}

async function requestForm(url, formData, options = {}) {
  const res = await fetch(normalizeApiPath(url), {
    method: options.method || 'POST',
    headers: { ...getAuthHeaders(), ...(options.headers || {}) },
    body: formData,
  });
  if (res.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.hash = '#/login';
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const error = new Error(body.error || 'Request failed');
    error.status = res.status;
    error.code = body.code;
    error.details = body;
    throw error;
  }
  return res.json();
}

// All routine broadcast entry points share this helper. The operator preference
// is permanent: routing executes immediately without takeover/replace popups.
// Destructive controls (blank, retire, delete, stop live) do not use this path
// and retain their own confirmations.
async function requestBroadcast(payload, endpoint = '/broadcast') {
  const authorizedPayload = {
    ...(payload || {}),
    confirm_all: true,
    confirm_wall_replace: true,
  };
  const res = await fetch(normalizeApiPath(endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(authorizedPayload),
  });
  if (res.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.hash = '#/login';
    window.location.reload();
    throw new Error('Session expired');
  }
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    const error = new Error(body.error || 'Request failed');
    error.status = res.status;
    error.code = body.code;
    error.details = body;
    throw error;
  }
  return body;
}

async function requestStatus(url) {
  const res = await fetch(normalizeApiPath(url), {
    headers: { Accept: 'application/json', ...getAuthHeaders() },
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.hash = '#/login';
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || 'Request failed');
  }
  return res.json();
}

function contentMutationApplied(current, desired = {}) {
  if (!current || typeof current !== 'object') return false;
  return Object.entries(desired).every(([field, expected]) => {
    if (field === 'expected_version') return true;
    if (field === 'archived') {
      return Boolean(current.visibility?.archived_at ?? current.archived_at) === Boolean(expected);
    }
    if (field === 'access_level') {
      return (current.visibility?.access_level || current.access_level || 'private') === expected;
    }
    if (field === 'folder_id' || field === 'remote_url' || field === 'default_fit_mode') {
      return (current[field] || null) === (expected || null);
    }
    return current[field] === expected;
  });
}

// A proxy/browser connection can disappear after SQLite commits but before the
// response reaches the operator. Re-read the authoritative row before calling
// a content write "failed"; this makes rename/archive idempotent from the UI's
// point of view and avoids the false-failure state seen during transient drops.
async function reconcileContentMutation(id, desired, mutate) {
  try {
    return await mutate();
  } catch (error) {
    // Authentication/authorization failures are definitive and must retain the
    // normal login/access-denied behavior.
    if (error?.status === 401 || error?.status === 403) throw error;
    try {
      const current = await request(`/content/${id}`);
      if (contentMutationApplied(current, desired)) return current;
    } catch {
      // Preserve the original mutation error; the verification read is only a
      // recovery path and must not replace the more useful primary failure.
    }
    throw error;
  }
}

export const api = {
  getSystemVersion: () => request('/system/version'),
  // Devices
  getDevices: () => request('/devices', { cache: 'no-store' }),
  getDevice: (id) => request(`/devices/${id}`),
  updateDevice: (id, data) => request(`/devices/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteDevice: (id, etag) => request(`/devices/${id}`, {
    method: 'DELETE',
    headers: etag ? { 'If-Match': etag } : {},
  }),
  retireDevice: (id) => request(`/devices/${id}/retire`, { method: 'POST' }),
  restoreDevice: (id) => request(`/devices/${id}/restore`, { method: 'POST' }),
  getDeviceDeletionImpact: (id) => request(`/devices/${id}/deletion-impact`),
  identify: (deviceId) => request(`/devices/${deviceId}/identify`, { method: 'POST' }),

  // Displays
  getDisplaysState: () => request('/displays/state'),
  getDisplaysSelection: () => request('/displays/selection'),
  putDisplaysSelection: (device_ids) => request('/displays/selection', { method: 'PUT', body: JSON.stringify({ device_ids }) }),
  getControlPreferences: () => request('/displays/control-preferences'),
  patchControlPreferences: (prefs, revision) => request('/displays/control-preferences', {
    method: 'PATCH',
    headers: revision !== undefined ? { 'If-Match': String(revision) } : {},
    body: JSON.stringify(prefs),
  }),

  // High-performance coordinate canvases. Legacy displays remain on /devices.
  canvas: {
    list: () => request('/advanced-canvas'),
    get: (id) => request(`/advanced-canvas/${id}`),
    publish: (id, layers) => request(`/advanced-canvas/${id}/scene`, {
      method: 'PUT',
      body: JSON.stringify({ layers }),
    }),
    clear: (id) => request(`/advanced-canvas/${id}/clear`, { method: 'POST' }),
    setActive: (id, active) => request(`/advanced-canvas/${id}/active`, {
      method: 'POST',
      body: JSON.stringify({ active: active === true }),
    }),
    ice: () => request('/screen-share/turn-credentials'),
  },

  // Provisioning
  pairDevice: (pairing_code, name) => request('/provision/pair', {
    method: 'POST',
    body: JSON.stringify({ pairing_code, name })
  }),

  // Content
  getContent: (folderId) => {
    if (folderId === undefined) return request('/content');
    const q = folderId === null ? 'root' : encodeURIComponent(folderId);
    return request(`/content?folder_id=${q}`);
  },
  getGovernedContent: (filters = {}) => {
    const query = new URLSearchParams();
    if (filters.folderId !== undefined) query.set('folder_id', filters.folderId === null ? 'root' : filters.folderId);
    if (filters.visibility) query.set('visibility', filters.visibility);
    if (filters.type) query.set('type', filters.type);
    if (filters.search) query.set('search', filters.search);
    if (filters.mine) query.set('owner', 'me');
    if (filters.owner) query.set('owner', filters.owner);
    if (filters.archived) query.set('archived', filters.archived);
    if (filters.processing) query.set('processing', filters.processing);
    if (filters.codec) query.set('codec', filters.codec);
    if (filters.dimensions) query.set('dimensions', filters.dimensions);
    if (filters.source) query.set('source', filters.source);
    if (filters.thumbnail) query.set('thumbnail', filters.thumbnail);
    if (filters.p3) query.set('p3', filters.p3);
    if (filters.favorite) query.set('favorite', '1');
    if (filters.limit) query.set('limit', String(filters.limit));
    if (filters.offset) query.set('offset', String(filters.offset));
    const suffix = query.toString();
    return request(`/content${suffix ? `?${suffix}` : ''}`);
  },
  getContentItem: (id) => request(`/content/${id}`),
  deleteContent: (id) => request(`/content/${id}`, { method: 'DELETE' }),
  updateContent: (id, data) => reconcileContentMutation(
    id,
    data,
    () => request(`/content/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  ),
  moveContent: (id, folderId) => request(`/content/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ folder_id: folderId })
  }),
  // Authenticated content download. Fetches the file as a Blob with the bearer
  // token in the Authorization header (NEVER in the URL) and resolves with the
  // blob + a sanitized filename parsed from Content-Disposition. The caller
  // triggers the save-to-disk via a temporary object URL.
  downloadContent: async (id) => {
    const res = await fetch(normalizeApiPath(`/content/${id}/download`), {
      headers: getAuthHeaders(),
    });
    if (res.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.hash = '#/login';
      window.location.reload();
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const error = new Error(err.error || 'Download failed');
      error.status = res.status;
      error.code = err.code;
      throw error;
    }
    const blob = await res.blob();
    let filename = '';
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i);
    if (m) filename = decodeURIComponent(m[1]);
    return { blob, filename };
  },
  requestContentPublication: (id) => request(`/content/${id}/publication-request`, { method: 'POST' }),
  duplicateContent: (id) => request(`/content/${id}/duplicate`, { method: 'POST' }),
  archiveContent: (id, archived = true, confirmRevoke = false) => reconcileContentMutation(
    id,
    { archived },
    () => request(`/content/${id}/archive`, {
      method: 'PUT',
      body: JSON.stringify({ archived, confirm_revoke: confirmRevoke }),
    }),
  ),
  getContentUsage: (id) => request(`/content/${id}/usage`),
  listContentCaptions: (id, { includeBody = false } = {}) => request(`/captions/content/${encodeURIComponent(id)}${includeBody ? '?include_body=1' : ''}`, {
    headers: { 'Cache-Control': 'no-store' },
  }),
  uploadContentCaption: (id, file, details = {}) => {
    const form = new FormData();
    form.append('caption_file', file);
    form.append('language_code', details.language_code || 'en');
    form.append('label', details.label || details.language_code || 'English');
    form.append('kind', details.kind === 'subtitles' ? 'subtitles' : 'captions');
    form.append('is_default', details.is_default === true ? 'true' : 'false');
    return requestForm(`/captions/content/${encodeURIComponent(id)}`, form);
  },
  getContentLibrarySummary: () => request('/content/library-summary'),
  getContentSavedViews: () => request('/content/saved-views'),
  createContentSavedView: (name, query) => request('/content/saved-views', {
    method: 'POST',
    body: JSON.stringify({ name, query }),
  }),
  deleteContentSavedView: (id) => request(`/content/saved-views/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }),
  setContentFavorite: (id, favorite) => request(`/content/${encodeURIComponent(id)}/favorite`, {
    method: favorite ? 'PUT' : 'DELETE',
  }),
  updateContentThumbnail: (id, {
    file = null,
    timestampSeconds = 0,
    position = 'center',
  } = {}) => {
    const form = new FormData();
    if (file) form.append('poster', file);
    form.append('timestamp_seconds', String(timestampSeconds));
    form.append('position', position);
    return requestForm(`/content/${encodeURIComponent(id)}/thumbnail/studio`, form);
  },
  regenerateContentThumbnail: (id) => request(
    `/content/${encodeURIComponent(id)}/thumbnail/regenerate`,
    { method: 'POST' },
  ),
  getMediaJobs: ({ contentId = '', limit = 100 } = {}) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (contentId) query.set('content_id', contentId);
    return request(`/content/jobs?${query.toString()}`);
  },
  retryMediaJob: (id) => request(`/content/jobs/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
  }),
  cancelMediaJob: (id) => request(`/content/jobs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  }),
  setDefaultContentCaption: (captionId) => request(
    `/captions/${encodeURIComponent(captionId)}/default`,
    { method: 'PUT' },
  ),
  deleteContentCaption: (captionId) => request(
    `/captions/${encodeURIComponent(captionId)}`,
    { method: 'DELETE' },
  ),
  searchContentCaptions: (query) => request(
    `/captions/search?q=${encodeURIComponent(query)}`,
  ),
  getMediaObservability: () => request('/media-observability', {
    headers: { 'Cache-Control': 'no-store' },
  }),
  prepareContentForClass: (contentIds) => request('/classroom-preparation', {
    method: 'POST',
    body: JSON.stringify({
      content_ids: (Array.isArray(contentIds) ? contentIds : [contentIds]).filter(Boolean),
    }),
  }),
  getClassroomPreparation: (id) => request(`/classroom-preparation/${encodeURIComponent(id)}`, {
    headers: { 'Cache-Control': 'no-store' },
  }),
  retryClassroomPreparation: (id) => request(`/classroom-preparation/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
  }),
  cancelClassroomPreparation: (id) => request(`/classroom-preparation/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }),
  transferContent: (id, ownerUserId) => request(`/content/${id}/transfer`, {
    method: 'PUT', body: JSON.stringify({ owner_user_id: ownerUserId }),
  }),
  getTemplateAssignments: (id) => request(`/content/${id}/template-assignments`),
  updateTemplateAssignments: (id, workspaceIds) => request(`/content/${id}/template-assignments`, {
    method: 'PUT', body: JSON.stringify({ workspace_ids: workspaceIds }),
  }),
  getPublicationRequests: () => request('/content/publication-requests'),
  reviewPublicationRequest: (requestId, decision, reason = '') => request(`/content/publication-requests/${requestId}`, {
    method: 'PUT',
    body: JSON.stringify({ decision, reason }),
  }),

  // Folders
  getFolders: () => request('/folders'),
  createFolder: (name, parentId) => request('/folders', {
    method: 'POST',
    body: JSON.stringify({ name, parent_id: parentId || null })
  }),
  renameFolder: (id, name) => request(`/folders/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name })
  }),
  moveFolder: (id, parentId) => request(`/folders/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ parent_id: parentId || null })
  }),
  deleteFolder: (id) => request(`/folders/${id}`, { method: 'DELETE' }),
  uploadContent: async (file, onProgress) => {
    const formData = new FormData();
    formData.append('file', file);

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/content`);
      const token = localStorage.getItem('token');
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else if (xhr.status === 401) {
          localStorage.removeItem('token');
          localStorage.removeItem('user');
          window.location.hash = '#/login';
          window.location.reload();
          reject(new Error('Session expired'));
        } else {
          let message = 'Upload failed';
          try { message = JSON.parse(xhr.responseText).error || message; } catch { /* keep fallback */ }
          reject(new Error(message));
        }
      };
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(formData);
    });
  },

  // Resumable chunked upload (tus) for large files. Splits the file into 32MB
  // PATCH requests so each stays under Cloudflare's ~100MB edge body limit and
  // the upload survives connection drops (Starlink). Requires the vendored
  // tus-js-client (window.tus, loaded in index.html). The server finalize hook
  // creates the content row and returns its id in the X-Content-Id header.
  uploadContentResumable: (file, onProgress) => new Promise((resolve, reject) => {
    if (!window.tus || !window.tus.Upload) return reject(new Error('Resumable uploader not loaded'));
    const token = localStorage.getItem('token');
    let contentId = null;
    const upload = new window.tus.Upload(file, {
      endpoint: `${API_BASE}/tus`,
      chunkSize: 32 * 1024 * 1024, // 32MB < Cloudflare 100MB edge limit
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
      removeFingerprintOnSuccess: true,
      metadata: { filename: file.name, filetype: file.type || 'application/octet-stream' },
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      onError: (err) => reject(err),
      onProgress: (sent, total) => { if (onProgress && total) onProgress(Math.round((sent / total) * 100)); },
      onAfterResponse: (req, res) => {
        try { const id = res.getHeader && res.getHeader('X-Content-Id'); if (id) contentId = id; } catch { /* ignore */ }
      },
      onSuccess: () => resolve(contentId ? { id: contentId } : {}),
    });
    // Resume an interrupted upload of the same file if one exists.
    upload.findPreviousUploads().then((prev) => {
      if (prev && prev.length) upload.resumeFromPreviousUpload(prev[0]);
      upload.start();
    }).catch(() => upload.start());
  }),

  addRemoteContent: (url, name, mime_type) => request('/content/remote', {
    method: 'POST',
    body: JSON.stringify({ url, name, mime_type })
  }),

  addYoutubeContent: (url, name) => request('/content/youtube', {
    method: 'POST',
    body: JSON.stringify({ url, name })
  }),

  // Assignments
  getAssignments: (deviceId) => request(`/assignments/device/${deviceId}`),
  addAssignment: (deviceId, data) => request(`/assignments/device/${deviceId}`, {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updateAssignment: (id, data) => request(`/assignments/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAssignment: (id) => request(`/assignments/${id}`, { method: 'DELETE' }),
  reorderAssignments: (deviceId, order) => request(`/assignments/device/${deviceId}/reorder`, {
    method: 'POST',
    body: JSON.stringify({ order })
  }),

  // Widgets
  getWidgets: () => request('/widgets'),

  // Device Groups
  getGroups: () => request('/groups'),
  createGroup: (name, color) => request('/groups', { method: 'POST', body: JSON.stringify({ name, color }) }),
  deleteGroup: (id) => request(`/groups/${id}`, { method: 'DELETE' }),
  getGroupDevices: (id) => request(`/groups/${id}/devices`),
  addDeviceToGroup: (groupId, device_id) => request(`/groups/${groupId}/devices`, { method: 'POST', body: JSON.stringify({ device_id }) }),
  removeDeviceFromGroup: (groupId, deviceId) => request(`/groups/${groupId}/devices/${deviceId}`, { method: 'DELETE' }),
  sendGroupCommand: (groupId, type, payload) => request(`/groups/${groupId}/command`, { method: 'POST', body: JSON.stringify({ type, payload }) }),

  // Video walls
  getWalls: () => request('/walls', { cache: 'no-store' }),
  getWall: (id) => request(`/walls/${id}`),
  createWall: (data) => request('/walls', { method: 'POST', body: JSON.stringify(data) }),
  setWallDevices: (id, devices, expected_revision) => request(`/walls/${id}/devices`, { method: 'PUT', body: JSON.stringify({ devices, expected_revision }) }),
  updateWall: (id, data) => request(`/walls/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  updateWallLayout: (id, data) => request(`/walls/${id}/layout`, { method: 'PUT', body: JSON.stringify(data) }),
  syncWallRegions: (id, expected_revision) => request(`/walls/${id}/regions/sync`, {
    method: 'PUT',
    body: JSON.stringify({ expected_revision }),
  }),
  deleteWall: (id) => request(`/walls/${id}`, { method: 'DELETE' }),

  // Admin status snapshots
  getNodeStatus: () => requestStatus('/status/nodes'),

  // Playlists
  getPlaylists: () => request('/playlists'),
  createPlaylist: (name, description) => request('/playlists', { method: 'POST', body: JSON.stringify({ name, description }) }),
  getPlaylist: (id) => request(`/playlists/${id}`),
  updatePlaylist: (id, data) => request(`/playlists/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePlaylist: (id) => request(`/playlists/${id}`, { method: 'DELETE' }),
  getPlaylistItems: (id) => request(`/playlists/${id}/items`),
  addPlaylistItem: (id, data) => request(`/playlists/${id}/items`, { method: 'POST', body: JSON.stringify(data) }),
  updatePlaylistItem: (id, itemId, data) => request(`/playlists/${id}/items/${itemId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePlaylistItem: (id, itemId) => request(`/playlists/${id}/items/${itemId}`, { method: 'DELETE' }),
  reorderPlaylistItems: (id, order) => request(`/playlists/${id}/items/reorder`, { method: 'POST', body: JSON.stringify({ order }) }),
  assignPlaylistToDevice: (playlistId, device_id) => request(`/playlists/${playlistId}/assign`, { method: 'POST', body: JSON.stringify({ device_id }) }),
  publishPlaylist: (id) => request(`/playlists/${id}/publish`, { method: 'POST' }),
  discardPlaylistDraft: (id) => request(`/playlists/${id}/discard`, { method: 'POST' }),

  // Device Groups - Playlist
  groupAssignPlaylist: (groupId, playlist_id) => request(`/groups/${groupId}/assign-playlist`, { method: 'POST', body: JSON.stringify({ playlist_id }) }),

  // ==================== Phase 4: Layouts ====================
  // Thin wrapper over the layouts routes. applyPreset() asks the server to
  // generate a standard set of layout_zones on an existing layout (replacing
  // the current zones). The editor then re-fetches the layout to reflect the
  // newly generated zones. Preset keys are validated server-side; the UI just
  // forwards the chosen key. Follows the same request()/Bearer pattern as the
  // rest of the API surface.
  layouts: {
    list: () => request('/layouts'),
    // Fetch a single layout WITH its zones (server attaches layout.zones).
    get: (layoutId) => request(`/layouts/${layoutId}`),
    // Create a layout in the caller's current workspace. Returns { id, zones, ... }.
    create: (data) => request('/layouts', { method: 'POST', body: JSON.stringify(data) }),
    applyPreset: (layoutId, preset) => request(`/layouts/${layoutId}/apply-preset`, {
      method: 'POST',
      body: JSON.stringify({ preset }),
    }),
    // Update a zone IN PLACE (preserves its id, so content→zone bindings survive).
    updateZone: (layoutId, zoneId, data) => request(`/layouts/${layoutId}/zones/${zoneId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
    // Bulk-save the whole zone set atomically. The server reconciles slot-wise
    // (surviving zones keep their ids) and runs the diff in ONE transaction, so
    // a mid-save failure can't leave the layout half-wiped. Returns the server's
    // authoritative reconciled zones.
    saveZones: (layoutId, zones) => request(`/layouts/${layoutId}/zones`, {
      method: 'PUT',
      body: JSON.stringify({ zones }),
    }),
    // Assign (or clear) a layout on a device. Pass { layout_id: null } to clear.
    assignToDevice: (deviceId, layout_id) => request(`/layouts/device/${deviceId}`, {
      method: 'PUT',
      body: JSON.stringify({ layout_id }),
    }),
  },

  // ==================== Phase 3: Scenes (Operational Activities) ====================
  // A scene is a named snapshot of which content/playlist shows on which
  // display. trigger() pushes the snapshot to all of the scene's displays in
  // one tap; capture() snapshots the current state of the given displays into
  // a new scene.
  scenes: {
    list: () => request('/scenes'),
    create: (data) => request('/scenes', { method: 'POST', body: JSON.stringify(data) }),
    get: (id) => request(`/scenes/${id}`),
    update: (id, data) => request(`/scenes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id) => request(`/scenes/${id}`, { method: 'DELETE' }),
    getPlacements: (id) => request(`/scenes/${id}/placements`),
    setPlacements: (id, placements) => request(`/scenes/${id}/placements`, { method: 'PUT', body: JSON.stringify({ placements }) }),
    trigger: (id) => request(`/scenes/${id}/trigger`, { method: 'POST' }),
    capture: (data) => request('/scenes/capture', { method: 'POST', body: JSON.stringify(data) }),
  },

  // ==================== Phase 3: Fast broadcast ====================
  // Send one content/URL/playlist to a selection of displays. The shared helper
  // applies the saved no-confirmation routing policy.
  broadcastPreflight: (payload) => request('/broadcast/preflight', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
    headers: { 'Cache-Control': 'no-store' },
  }),
  broadcast: (payload) => requestBroadcast(payload),
  broadcastStatus: (requestId) => request(`/broadcast/${encodeURIComponent(requestId)}`, {
    headers: { 'Cache-Control': 'no-store' },
  }),

  liveSources: {
    list: () => request('/live-sources', {
      headers: { 'Cache-Control': 'no-store' },
    }),
  },

  // ==================== MBFD live stream orchestration ====================
  liveStream: {
    display: () => request('/live-stream/display'),
    status: () => request('/live-stream/status'),
    // Fast operator poll (<500ms target). Uses director/state + cached deep probes.
    operatorState: () => request('/live-stream/operator-state'),
    composition: () => request('/live-stream/composition', {
      headers: { 'Cache-Control': 'no-store' },
    }),
    compositionContent: (body) => request('/live-stream/composition/content', {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }),
    compositionLayout: (body) => request('/live-stream/composition/layout', {
      method: 'PUT',
      body: JSON.stringify(body || {}),
    }),
    compositionClear: (body) => request('/live-stream/composition/content', {
      method: 'DELETE',
      body: JSON.stringify(body || {}),
    }),
    start: (options = {}) => request('/live-stream/start', { method: 'POST', body: JSON.stringify(options) }),
    stop: () => request('/live-stream/stop', { method: 'POST' }),
    clearContent: () => request('/live-stream/clear-content', { method: 'POST' }),
    refresh: () => request('/live-stream/refresh', { method: 'POST' }),
    recordingStatus: () => request('/live-stream/recording/status'),
    recordingPreflight: (body) => request('/live-stream/recording/preflight', { method: 'POST', body: JSON.stringify(body || {}) }),
    recordingStart: (body) => request('/live-stream/recording/start', { method: 'POST', body: JSON.stringify(body || {}) }),
    recordingStop: (body) => request('/live-stream/recording/stop', { method: 'POST', body: JSON.stringify(body || {}) }),
  },

  // PeerTube post-class recording review and publication workflow.
  peertubeReplays: {
    list: () => request('/peertube-replays'),
    pending: () => request('/peertube-replays/pending'),
    health: () => request('/peertube-replays/health'),
    playbackGrant: (id, download = false) => request(`/peertube-replays/${encodeURIComponent(id)}/playback-grant`, {
      method: 'POST', body: JSON.stringify({ download: download === true }),
    }),
    add: (id, visibility, title) => request(`/peertube-replays/${encodeURIComponent(id)}/localize`, {
      method: 'POST', body: JSON.stringify({ visibility, title }),
    }),
    discard: (id) => request(`/peertube-replays/${encodeURIComponent(id)}/discard`, { method: 'POST' }),
    retry: (id) => request(`/peertube-replays/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
    archive: (id) => request(`/peertube-replays/${encodeURIComponent(id)}/archive`, { method: 'POST' }),
    visibility: (id, visibility) => request(`/peertube-replays/${encodeURIComponent(id)}/visibility`, {
      method: 'PATCH', body: JSON.stringify({ visibility }),
    }),
    visibilityRequest: (id) => request(`/peertube-replays/${encodeURIComponent(id)}/visibility-request`, {
      method: 'POST', body: JSON.stringify({ visibility: 'ORGANIZATION_SHARED' }),
    }),
    approveOrganization: (id) => request(`/peertube-replays/${encodeURIComponent(id)}/organization-publication/approve`, {
      method: 'POST',
    }),
  },

  // ==================== MBFD Media Control Studio: Presentations ====================
  presentations: {
    list: () => request('/presentations'),
    get: (id) => request(`/presentations/${id}`),
    create: (data) => request('/presentations', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/presentations/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id) => request(`/presentations/${id}`, { method: 'DELETE' }),
    publish: (id) => request(`/presentations/${id}/publish`, { method: 'POST' }),
    duplicate: (id) => request(`/presentations/${id}/duplicate`, { method: 'POST' }),
    // Upload an image for use on a slide. Returns { content_id, url, thumbnail_url, width, height, filename }.
    // url is the public /player/asset/:id path the deck player loads. Multipart via XHR for progress.
    uploadAsset: (presId, file, onProgress) => new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('file', file);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/presentations/${presId}/assets`);
      const token = localStorage.getItem('token');
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error('Bad response')); } }
        else if (xhr.status === 401) {
          localStorage.removeItem('token'); localStorage.removeItem('user');
          window.location.hash = '#/login'; window.location.reload();
          reject(new Error('Session expired'));
        } else { let m = 'Upload failed'; try { m = JSON.parse(xhr.responseText).error || m; } catch {} reject(new Error(m)); }
      };
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(fd);
    }),
  },

  // Schedules (content/playlist windows per display or group; RRULE recurrence).
  schedules: {
    list: () => request('/schedules'),
    create: (data) => request('/schedules', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/schedules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id) => request(`/schedules/${id}`, { method: 'DELETE' }),
    // Recurrence-expanded events for a device's week (server expands RRULEs).
    week: (deviceId, date) => request(`/schedules/week?device_id=${encodeURIComponent(deviceId)}${date ? '&date=' + encodeURIComponent(date) : ''}`),
  },

  // Audit / activity log (workspace activity trail; admins see all).
  getActivity: (limit = 100) => request(`/activity?limit=${encodeURIComponent(limit)}`),

  // Files (per-user Nextcloud raw-FS proxy).
  files: {
    health: () => request('/files/health'),
    list: (path = '') => request('/files' + (path ? ('?path=' + encodeURIComponent(path)) : '')),
    // Import an image/video from the caller's OWN Nextcloud into a local content
    // row, then broadcast it to displays through the shared routing policy.
    broadcast: (path, device_ids, opts = {}) => {
      const targets = Array.isArray(opts.targets) ? opts.targets : [];
      const targetPayload = targets.length ? { targets } : { device_ids };
      return requestBroadcast({ path, ...targetPayload, fit_mode: opts.fit_mode }, '/files/broadcast');
    },
    importForCanvas: (path) => request('/files/broadcast', {
      method: 'POST',
      body: JSON.stringify({ path, import_only: true }),
    }),
  },
  // Media downloads (by URL).
  downloads: {
    health: () => request('/downloads/health'),
    list: (options = {}) => request('/downloads', options),
    create: (url, title) => request('/downloads', { method: 'POST', body: JSON.stringify({ url, title }) }),
  },

  // AI Deck Builder (server-side Ollama; async job → poll). Frontend never hits Ollama.
  ai: {
    health: () => request('/ai/health'),
    generateDeck: (data) => request('/ai/generate-deck', { method: 'POST', body: JSON.stringify(data) }),
    job: (id) => request(`/ai/jobs/${id}`),
  },

  // Current user
  getMe: () => request('/auth/me'),
  updateMe: (data) => request('/auth/me', { method: 'PUT', body: JSON.stringify(data) }),
  switchWorkspace: (workspaceId) => request('/auth/switch-workspace', { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId }) }),
  renameWorkspace: (id, data) => request(`/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Workspace members + invites (slice 2A read-only)
  getWorkspaceMembers: (id) => request(`/workspaces/${id}/members`),
  getWorkspaceInvites: (id) => request(`/workspaces/${id}/invites`),

  // Workspace member/invite mutations (slice 2B). All admin-only server-side
  // (canAdminWorkspace gate). Server returns translated English error messages
  // mapped to i18n keys via mapMutationError() in workspace-members.js.
  inviteWorkspaceMember: (workspaceId, data) => request(`/workspaces/${workspaceId}/invites`, { method: 'POST', body: JSON.stringify(data) }),
  cancelWorkspaceInvite: (workspaceId, inviteId) => request(`/workspaces/${workspaceId}/invites/${inviteId}`, { method: 'DELETE' }),
  updateWorkspaceMemberRole: (workspaceId, userId, role) => request(`/workspaces/${workspaceId}/members/${userId}`, { method: 'PUT', body: JSON.stringify({ role }) }),
  removeWorkspaceMember: (workspaceId, userId) => request(`/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' }),

  // Slice 2C - accept a workspace invite by id (post-auth flow)
  acceptInvite: (inviteId) => request(`/auth/accept-invite/${inviteId}`, { method: 'POST' }),

  // Admin - Users
  getUsers: () => request('/auth/users'),
  deleteUser: (id) => request(`/auth/users/${id}`, { method: 'DELETE' }),
  resetUserPassword: (id, password) => request(`/auth/users/${id}/password`, {
    method: 'PUT',
    body: JSON.stringify({ password }),
  }),
};
