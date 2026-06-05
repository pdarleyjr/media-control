const API_BASE = '/api';

function getAuthHeaders() {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request(url, options = {}) {
  const res = await fetch(API_BASE + url, {
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...options.headers },
    ...options,
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
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// Phase 3 broadcast helper. The broadcast endpoint returns 409 with a
// { code: 'CONFIRM_ALL_REQUIRED', count } envelope when the caller targets
// every display in the workspace WITHOUT passing confirm_all:true. The generic
// request() above turns any non-2xx into a thrown Error and discards the body,
// which would throw the confirmation signal away. This helper instead resolves
// with the parsed body so the UI can detect CONFIRM_ALL_REQUIRED, prompt the
// operator, and retry with confirm_all:true. All other non-2xx responses still
// throw (matching request()).
async function requestBroadcast(payload, endpoint = '/broadcast') {
  const res = await fetch(API_BASE + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.hash = '#/login';
    window.location.reload();
    throw new Error('Session expired');
  }
  const body = await res.json().catch(() => ({ error: res.statusText }));
  // Surface the confirm-all gate to the caller instead of throwing it away.
  if (res.status === 409 && body && body.code === 'CONFIRM_ALL_REQUIRED') {
    return body;
  }
  if (!res.ok) {
    throw new Error(body.error || 'Request failed');
  }
  return body;
}

export const api = {
  // Devices
  getDevices: () => request('/devices'),
  getDevice: (id) => request(`/devices/${id}`),
  updateDevice: (id, data) => request(`/devices/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteDevice: (id) => request(`/devices/${id}`, { method: 'DELETE' }),
  identify: (deviceId) => request(`/devices/${deviceId}/identify`, { method: 'POST' }),

  // Displays
  getDisplaysState: () => request('/displays/state'),
  getDisplaysSelection: () => request('/displays/selection'),
  putDisplaysSelection: (device_ids) => request('/displays/selection', { method: 'PUT', body: JSON.stringify({ device_ids }) }),

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
  getContentItem: (id) => request(`/content/${id}`),
  deleteContent: (id) => request(`/content/${id}`, { method: 'DELETE' }),
  updateContent: (id, data) => request(`/content/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  moveContent: (id, folderId) => request(`/content/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ folder_id: folderId })
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
        } else {
          reject(new Error('Upload failed'));
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
  getWalls: () => request('/walls'),
  createWall: (data) => request('/walls', { method: 'POST', body: JSON.stringify(data) }),
  setWallDevices: (id, devices) => request(`/walls/${id}/devices`, { method: 'PUT', body: JSON.stringify({ devices }) }),
  updateWall: (id, data) => request(`/walls/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteWall: (id) => request(`/walls/${id}`, { method: 'DELETE' }),

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
  // Send one content/URL/playlist to a selection of displays. When the target
  // is every display in the workspace, the server responds 409 with
  // { code:'CONFIRM_ALL_REQUIRED', count }; broadcast() resolves with that body
  // (instead of throwing) so the UI can prompt and retry with confirm_all:true.
  broadcast: (payload) => requestBroadcast(payload),

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
    // row, then broadcast it to displays. Reuses the 409 CONFIRM_ALL_REQUIRED
    // resolve-not-throw contract: when targeting every display, the returned body
    // is { code:'CONFIRM_ALL_REQUIRED', count } so the UI can prompt and retry
    // with confirm_all:true (same as api.broadcast).
    broadcast: (path, device_ids, opts = {}) =>
      requestBroadcast({ path, device_ids, fit_mode: opts.fit_mode, confirm_all: opts.confirm_all }, '/files/broadcast'),
  },
  // Media downloads (by URL).
  downloads: {
    health: () => request('/downloads/health'),
    list: () => request('/downloads'),
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
