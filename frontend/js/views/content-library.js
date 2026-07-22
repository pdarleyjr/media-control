import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc, isPlatformAdmin } from '../utils.js';
import { t } from '../i18n.js';

function formatFileSize(bytes) {
  if (!bytes) return '--';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// Document classification for the tile fallback. A PDF/Office/ODF row without a
// thumbnail must NOT render <img src=/file> (that points an image element at
// raw document bytes → broken image); show a type glyph + label instead. Once a
// background-generated thumbnail attaches, the thumbnail_path <img> path is used.
function isDocMime(mt) {
  return /pdf|presentation|powerpoint|word|spreadsheet|excel|opendocument/.test(mt || '');
}
function docGlyph(mt) {
  if (/pdf/.test(mt)) return '📕';
  if (/presentation|powerpoint/.test(mt)) return '📊';
  if (/spreadsheet|excel/.test(mt)) return '📈';
  if (/word|opendocument\.text/.test(mt)) return '📄';
  return '📄';
}
function docLabel(mt) {
  if (/pdf/.test(mt)) return t('content.type_pdf');
  if (/presentation|powerpoint/.test(mt)) return t('content.type_slides');
  if (/spreadsheet|excel/.test(mt)) return t('content.type_sheet');
  if (/word|opendocument\.text/.test(mt)) return t('content.type_doc');
  return t('content.type_document');
}

const VISIBILITIES = ['private', 'workspace_shared', 'organization_shared', 'platform_template'];

function visibilityLabel(level) {
  return t(`content.visibility.${VISIBILITIES.includes(level) ? level : 'private'}`);
}

function contentTypeLabel(content) {
  if (content.mime_type === 'video/youtube') return t('content.type_youtube');
  if (content.remote_url) return t('content.type_remote');
  if (content.mime_type?.startsWith('video/')) return t('content.type_video');
  if (isDocMime(content.mime_type)) return docLabel(content.mime_type);
  return t('content.type_image');
}

function governedActions(content) {
  const permissions = content.permissions || {};
  const pending = content.visibility?.publication_request_status === 'pending';
  return `
    ${permissions?.can_edit ? `<button class="btn btn-secondary btn-sm" data-edit-content="${content.id}">${t('content.btn_edit')}</button>` : ''}
    ${permissions?.can_request_organization && !pending ? `<button class="btn btn-secondary btn-sm" data-request-publication="${content.id}">${t('content.btn_request_org')}</button>` : ''}
    ${pending ? `<span class="content-request-status">${t('content.request_pending')}</span>` : ''}
    ${permissions?.can_duplicate ? `<button class="btn btn-secondary btn-sm" data-duplicate-content="${content.id}">${t('content.btn_duplicate')}</button>` : ''}
    ${permissions?.can_transfer ? `<button class="btn btn-secondary btn-sm" data-transfer-content="${content.id}">${t('content.btn_transfer')}</button>` : ''}
    ${permissions?.can_change_visibility && content.visibility?.access_level === 'platform_template' ? `<button class="btn btn-secondary btn-sm" data-template-assignments="${content.id}">${t('content.btn_assign_workspaces')}</button>` : ''}
    ${permissions?.can_archive ? `<button class="btn btn-secondary btn-sm" data-archive-content="${content.id}" data-archived="${content.visibility?.archived_at ? 'true' : 'false'}">${content.visibility?.archived_at ? t('content.btn_restore') : t('content.btn_archive')}</button>` : ''}
    ${permissions?.can_delete ? `<button class="btn btn-danger btn-sm" data-delete-content="${content.id}">${t('content.btn_delete')}</button>` : ''}
  `;
}

export function render(container) {
  let currentUser = {};
  try { currentUser = JSON.parse(localStorage.getItem('user') || '{}'); } catch { /* keep empty identity */ }
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${t('content.title')} <span class="help-tip" data-tip="${t('content.help_tip')}">?</span></h1>
        <div class="subtitle">${t('content.subtitle')}</div>
      </div>
    </div>

    <div class="content-toolbar" style="display:flex;gap:16px;margin-bottom:24px">
      <div class="upload-area" id="uploadArea" style="flex:1;margin-bottom:0">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <p>${t('content.drop')}</p>
        <p class="upload-hint">${t('content.upload_hint')}</p>
        <input type="file" id="fileInput" style="display:none" multiple accept="video/*,image/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/msword,application/vnd.ms-excel,application/vnd.ms-powerpoint,application/vnd.oasis.opendocument.text,application/vnd.oasis.opendocument.spreadsheet,application/vnd.oasis.opendocument.presentation">
        <div class="upload-progress" id="uploadProgress" style="display:none">
          <div class="upload-progress-bar">
            <div class="upload-progress-fill" id="uploadProgressFill" style="width:0%"></div>
          </div>
          <p style="font-size:12px;color:var(--text-secondary);margin-top:6px" id="uploadProgressText">${t('content.upload_progress')}</p>
        </div>
      </div>
      <div style="width:320px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;align-items:center;gap:8px;color:var(--text-primary);font-weight:500">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
          ${t('content.remote_url')}
        </div>
        <p style="font-size:12px;color:var(--text-muted)">${t('content.remote_desc')}</p>
        <input type="text" id="remoteUrlInput" class="input" placeholder="${t('content.remote_url_placeholder')}">
        <input type="text" id="remoteNameInput" class="input" placeholder="${t('content.remote_name_placeholder')}">
        <select id="remoteMimeType" class="input" style="background:var(--bg-input)">
          <option value="video/mp4">${t('content.mime.video_mp4')}</option>
          <option value="video/webm">${t('content.mime.video_webm')}</option>
          <option value="image/jpeg">${t('content.mime.image_jpeg')}</option>
          <option value="image/png">${t('content.mime.image_png')}</option>
        </select>
        <button class="btn btn-primary" id="addRemoteBtn">${t('content.remote_add_btn')}</button>
      </div>
      <div style="width:320px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;align-items:center;gap:8px;color:var(--text-primary);font-weight:500">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19.13C5.12 19.56 12 19.56 12 19.56s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.43z"/>
            <polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02"/>
          </svg>
          ${t('content.youtube')}
        </div>
        <p style="font-size:12px;color:var(--text-muted)">${t('content.youtube_desc')}</p>
        <input type="text" id="youtubeUrlInput" class="input" placeholder="${t('content.youtube_url_placeholder')}">
        <input type="text" id="youtubeNameInput" class="input" placeholder="${t('content.youtube_name_placeholder')}">
        <button class="btn btn-primary" id="addYoutubeBtn">${t('content.youtube_add_btn')}</button>
      </div>
    </div>
    </div>

    <div class="content-governance-toolbar" aria-label="${t('content.filters_label')}">
      <input type="search" id="contentSearch" class="input" placeholder="${t('content.search_placeholder')}" value="${esc(state.filters.search)}">
      <select id="contentVisibilityFilter" class="input" aria-label="${t('content.filter_visibility')}">
        <option value="">${t('content.filter_all_visibility')}</option>
        ${VISIBILITIES.map(level => `<option value="${level}" ${state.filters.visibility === level ? 'selected' : ''}>${visibilityLabel(level)}</option>`).join('')}
      </select>
      <select id="contentTypeFilter" class="input" aria-label="${t('content.filter_type')}">
        <option value="">${t('content.filter_all_types')}</option>
        <option value="video" ${state.filters.type === 'video' ? 'selected' : ''}>${t('content.type_video')}</option>
        <option value="image" ${state.filters.type === 'image' ? 'selected' : ''}>${t('content.type_image')}</option>
        <option value="application" ${state.filters.type === 'application' ? 'selected' : ''}>${t('content.type_document')}</option>
      </select>
      <label class="content-filter-check"><input type="checkbox" id="contentMineFilter" ${state.filters.mine ? 'checked' : ''}> ${t('content.filter_mine')}</label>
      <label class="content-filter-check"><input type="checkbox" id="contentArchivedFilter" ${state.filters.archived ? 'checked' : ''}> ${t('content.filter_archived')}</label>
      <button class="btn btn-secondary btn-sm" id="newFolderBtn">${t('content.new_folder_btn')}</button>
      ${isPlatformAdmin(currentUser) || ['org_owner', 'org_admin'].includes(currentUser.current_org_role || currentUser.org_role)
        ? `<button class="btn btn-secondary btn-sm" data-review-publications>${t('content.review_requests')}</button>` : ''}
    </div>
    <div id="folderBreadcrumb" style="display:flex;gap:6px;align-items:center;margin-bottom:12px;font-size:13px;flex-wrap:wrap"></div>
    <div id="folderGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:16px"></div>
    <div class="content-grid" id="contentGrid">
      <div class="empty-state" style="grid-column:1/-1"><h3>${t('common.loading')}</h3></div>
    </div>
  `;

  // File upload handling
  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('fileInput');

  uploadArea.addEventListener('click', () => fileInput.click());

  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });

  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });

  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change', () => {
    handleFiles(fileInput.files);
    fileInput.value = '';
  });

  // Remote URL handling
  document.getElementById('addRemoteBtn').addEventListener('click', async () => {
    const url = document.getElementById('remoteUrlInput').value.trim();
    const name = document.getElementById('remoteNameInput').value.trim();
    const mimeType = document.getElementById('remoteMimeType').value;
    if (!url) {
      showToast(t('content.error_enter_url'), 'error');
      return;
    }
    try {
      await api.addRemoteContent(url, name, mimeType);
      showToast(t('content.toast.remote_added'), 'success');
      document.getElementById('remoteUrlInput').value = '';
      document.getElementById('remoteNameInput').value = '';
      loadContent();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // YouTube URL handling
  document.getElementById('addYoutubeBtn').addEventListener('click', async () => {
    const url = document.getElementById('youtubeUrlInput').value.trim();
    const name = document.getElementById('youtubeNameInput').value.trim();
    if (!url) {
      showToast(t('content.error_enter_youtube_url'), 'error');
      return;
    }
    try {
      await api.addYoutubeContent(url, name);
      showToast(t('content.toast.youtube_added'), 'success');
      document.getElementById('youtubeUrlInput').value = '';
      document.getElementById('youtubeNameInput').value = '';
      loadContent();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Governed filters execute server-side so shared/template/archived results are
  // never inferred from whatever happened to be loaded in the current grid.
  let searchTimer;
  document.getElementById('contentSearch').oninput = (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filters.search = event.target.value.trim(); loadContent(); }, 250);
  };
  document.getElementById('contentVisibilityFilter').onchange = (event) => { state.filters.visibility = event.target.value; loadContent(); };
  document.getElementById('contentTypeFilter').onchange = (event) => { state.filters.type = event.target.value; loadContent(); };
  document.getElementById('contentMineFilter').onchange = (event) => { state.filters.mine = event.target.checked; loadContent(); };
  document.getElementById('contentArchivedFilter').onchange = (event) => { state.filters.archived = event.target.checked; loadContent(); };
  container.querySelector('[data-review-publications]')?.addEventListener('click', showPublicationReviewModal);

  // Create folder in the current folder.
  document.getElementById('newFolderBtn').onclick = async () => {
    const name = prompt(t('content.prompt_folder_name'));
    if (!name || !name.trim()) return;
    try {
      await api.createFolder(name.trim(), state.currentFolderId);
      showToast(t('content.toast.folder_created_named', { name }), 'success');
      loadContent();
    } catch (err) { showToast(err.message, 'error'); }
  };

  loadContent();
}

// View state — current folder navigation. Lives at module scope so the back button
// and other handlers can read it without threading it through every callback.
const state = {
  currentFolderId: null, // null = root
  folders: [],           // all folders for this user (flat tree)
  filters: { search: '', visibility: '', type: '', mine: false, archived: false },
};

async function handleFiles(files) {
  const progress = document.getElementById('uploadProgress');
  const progressFill = document.getElementById('uploadProgressFill');
  const progressText = document.getElementById('uploadProgressText');

  for (const file of files) {
    progress.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.textContent = t('content.upload_progress_named', { name: file.name });

    try {
      // Large files (>90MB) go through the resumable tus path so they clear
      // Cloudflare's ~100MB per-request edge limit; smaller files use the
      // simple multipart POST. Falls back to multipart if tus isn't loaded.
      const useResumable = !!(window.tus && window.tus.Upload) && file.size > 90 * 1024 * 1024;
      const uploader = useResumable ? api.uploadContentResumable : api.uploadContent;
      await uploader(file, (pct) => {
        progressFill.style.width = pct + '%';
        progressText.textContent = t('content.upload_progress_named_pct', { name: file.name, pct });
      });
      showToast(t('content.toast.uploaded_named', { name: file.name }), 'success');
    } catch (err) {
      showToast(t('content.toast.upload_failed_named', { name: file.name, error: err.message }), 'error');
    }
  }

  progress.style.display = 'none';
  loadContent();
}

async function loadContent() {
  const grid = document.getElementById('contentGrid');
  const folderGrid = document.getElementById('folderGrid');
  const breadcrumb = document.getElementById('folderBreadcrumb');
  if (!grid || !folderGrid || !breadcrumb) return;

  try {
    const [content, folders] = await Promise.all([
      api.getGovernedContent({
        // The root governance view intentionally spans owner/workspace/org/template
        // sources. Folder navigation narrows to an explicit owned folder.
        folderId: state.currentFolderId === null ? undefined : state.currentFolderId,
        visibility: state.filters.visibility,
        type: state.filters.type,
        search: state.filters.search,
        mine: state.filters.mine,
        archived: state.filters.archived ? 'include' : '',
      }),
      api.getFolders(),
    ]);
    state.folders = folders;

    // Breadcrumb path: walk parent_id chain from current folder up to root.
    const folderById = new Map(folders.map(f => [f.id, f]));
    const path = [];
    let cursor = state.currentFolderId ? folderById.get(state.currentFolderId) : null;
    while (cursor) {
      path.unshift(cursor);
      cursor = cursor.parent_id ? folderById.get(cursor.parent_id) : null;
    }
    breadcrumb.innerHTML = `
      <a href="#" data-folder-nav="" style="color:var(--text-secondary);text-decoration:none">${t('content.breadcrumb_root')}</a>
      ${path.map(f => `
        <span style="color:var(--text-muted)">/</span>
        <a href="#" data-folder-nav="${f.id}" style="color:var(--text-primary);text-decoration:none">${esc(f.name)}</a>
      `).join('')}
      ${state.currentFolderId ? `
        <button class="btn btn-secondary btn-sm" id="renameFolderBtn" style="margin-left:auto">${t('content.rename_btn')}</button>
        <button class="btn btn-danger btn-sm" id="deleteFolderBtn">${t('content.delete_folder_btn')}</button>
      ` : ''}
    `;
    breadcrumb.querySelectorAll('[data-folder-nav]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const id = a.dataset.folderNav;
        state.currentFolderId = id || null;
        loadContent();
      });
      // Make breadcrumb segments drop targets too — otherwise the only way to move
      // a file out of a folder is via the edit modal. Dropping on "All Content"
      // moves to root; dropping on a parent name moves there.
      a.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('text/content-id')) return;
        e.preventDefault();
        a.style.background = 'var(--primary)';
        a.style.color = '#fff';
        a.style.padding = '2px 8px';
        a.style.borderRadius = '4px';
      });
      a.addEventListener('dragleave', () => {
        a.style.background = '';
        a.style.color = '';
        a.style.padding = '';
        a.style.borderRadius = '';
      });
      a.addEventListener('drop', async (e) => {
        e.preventDefault();
        a.style.background = ''; a.style.color = ''; a.style.padding = ''; a.style.borderRadius = '';
        const contentId = e.dataTransfer.getData('text/content-id');
        if (!contentId) return;
        const targetFolderId = a.dataset.folderNav || null; // empty string = root
        try {
          await api.moveContent(contentId, targetFolderId);
          showToast(targetFolderId ? t('content.toast.moved') : t('content.toast.moved_to_root'), 'success');
          loadContent();
        } catch (err) { showToast(err.message, 'error'); }
      });
    });
    const renameBtn = breadcrumb.querySelector('#renameFolderBtn');
    if (renameBtn) renameBtn.onclick = async () => {
      const current = folderById.get(state.currentFolderId);
      const name = prompt(t('content.prompt_rename_folder'), current?.name || '');
      if (!name || !name.trim() || name === current?.name) return;
      try {
        await api.renameFolder(state.currentFolderId, name.trim());
        showToast(t('content.toast.folder_renamed'), 'success');
        loadContent();
      } catch (err) { showToast(err.message, 'error'); }
    };
    const deleteBtn = breadcrumb.querySelector('#deleteFolderBtn');
    if (deleteBtn) deleteBtn.onclick = async () => {
      if (!confirm(t('content.confirm_delete_folder'))) return;
      try {
        const parentId = folderById.get(state.currentFolderId)?.parent_id || null;
        await api.deleteFolder(state.currentFolderId);
        showToast(t('content.toast.folder_deleted'), 'success');
        state.currentFolderId = parentId;
        loadContent();
      } catch (err) { showToast(err.message, 'error'); }
    };

    // Render subfolders of the current folder.
    const subfolders = folders.filter(f => (f.parent_id || null) === state.currentFolderId);
    folderGrid.innerHTML = subfolders.map(f => `
      <div class="folder-card" data-folder-id="${f.id}" data-name="${esc(f.name)}"
           style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);padding:14px;cursor:pointer;display:flex;align-items:center;gap:10px"
           data-drop-folder="${f.id}">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <div style="font-size:14px;font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</div>
      </div>
    `).join('');
    folderGrid.querySelectorAll('.folder-card').forEach(card => {
      card.addEventListener('click', () => {
        state.currentFolderId = card.dataset.folderId;
        loadContent();
      });
      // Drop target for dragging content items into this folder.
      card.addEventListener('dragover', (e) => { e.preventDefault(); card.style.outline = '2px solid var(--primary)'; });
      card.addEventListener('dragleave', () => { card.style.outline = ''; });
      card.addEventListener('drop', async (e) => {
        e.preventDefault();
        card.style.outline = '';
        const contentId = e.dataTransfer.getData('text/content-id');
        if (!contentId) return;
        try {
          await api.moveContent(contentId, card.dataset.folderId);
          showToast(t('content.toast.moved'), 'success');
          loadContent();
        } catch (err) { showToast(err.message, 'error'); }
      });
    });

    if (!content.length) {
      grid.innerHTML = subfolders.length ? '' : `
        <div class="empty-state" style="grid-column:1/-1">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
            <polyline points="13 2 13 9 20 9"/>
          </svg>
          <h3>${state.currentFolderId ? t('content.empty_folder_title') : t('content.no_content')}</h3>
          <p>${state.currentFolderId ? t('content.empty_folder_desc') : t('content.no_content_desc')}</p>
        </div>
      `;
      return;
    }

    grid.innerHTML = content.map(c => `
      <div class="content-item ${c.visibility?.archived_at ? 'is-archived' : ''}" draggable="${c.permissions?.can_edit ? 'true' : 'false'}" data-content-id="${c.id}" data-folder="${c.folder || ''}">
        <div class="content-item-preview">
          ${c.mime_type === 'video/youtube'
            ? `<div style="position:relative;width:100%;height:100%;background:#000;display:flex;align-items:center;justify-content:center">
                <img src="${esc(c.thumbnail_url || c.thumbnail_path)}" alt="${esc(c.filename)}" loading="lazy" style="width:100%;height:100%;object-fit:cover">
                <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="red" stroke="none">
                    <path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19.13C5.12 19.56 12 19.56 12 19.56s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.43z"/>
                    <polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02" fill="white"/>
                  </svg>
                </div>
              </div>`
          : c.remote_url
            ? `<div class="video-icon" style="flex-direction:column;gap:4px">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                </svg>
                <span style="font-size:10px;color:var(--text-muted)">${t('content.type_remote_short')}</span>
              </div>`
            : c.thumbnail_url || c.thumbnail_path
              ? `<img src="${esc(c.thumbnail_url || c.thumbnail_path)}" alt="${esc(c.filename)}" loading="lazy">`
              : c.mime_type?.startsWith('video/')
                ? `<div class="video-icon">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                  </div>`
                : isDocMime(c.mime_type)
                  ? `<div class="video-icon" style="flex-direction:column;gap:4px">
                      <span style="font-size:32px;line-height:1">${docGlyph(c.mime_type)}</span>
                      <span style="font-size:10px;color:var(--text-muted)">${esc(docLabel(c.mime_type))}</span>
                    </div>`
                : `<img src="${esc(c.thumbnail_url || c.file_url || `/api/content/${c.id}/file`)}" alt="${esc(c.filename)}" loading="lazy">`
          }
        </div>
        <div class="content-item-body">
          <div class="content-item-heading">
            <div class="content-item-name" title="${esc(c.filename)}">${esc(c.filename)}</div>
            <span class="content-visibility-badge visibility-${esc(c.visibility?.access_level || 'private')}">${visibilityLabel(c.visibility?.access_level)}</span>
          </div>
          <div class="content-item-size">
            ${contentTypeLabel(c)}
            ${c.duration_sec ? ` &middot; ${Math.floor(c.duration_sec / 60)}:${String(Math.floor(c.duration_sec % 60)).padStart(2, '0')}` : ''}
            ${c.file_size ? ' &middot; ' + formatFileSize(c.file_size) : ''}
            ${c.width && c.height ? ` &middot; ${c.width}x${c.height}` : ''}
          </div>
          <div class="content-governance-meta">
            <span>${t('content.owner')}: ${esc(c.visibility?.owner_name || t('content.owner_unknown'))}</span>
            <span>${t('content.version', { version: c.version || 1 })}</span>
            ${c.source_content_id ? `<span>${t('content.source_copy')}</span>` : ''}
            ${c.usage_count ? `<span>${t('content.in_use', { count: c.usage_count })}</span>` : ''}
          </div>
        </div>
        <div class="content-item-actions">
          ${governedActions(c)}
        </div>
      </div>
    `).join('');

    // Drag-to-move: each content item exposes its id; folder cards are the drop targets.
    grid.querySelectorAll('.content-item').forEach(item => {
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/content-id', item.dataset.contentId);
        e.dataTransfer.effectAllowed = 'move';
      });
    });

    // Delete handler via event delegation
    grid.onclick = async (e) => {
      // Preview on click (not on delete button)
      const previewTarget = e.target.closest('.content-item-preview');
      if (previewTarget) {
        const item = previewTarget.closest('.content-item');
        const id = item?.dataset.contentId;
        if (id) {
          const c = content.find(x => x.id === id);
          if (c) showPreview(c);
        }
        return;
      }

      // Edit button
      const editBtn = e.target.closest('[data-edit-content]');
      if (editBtn) {
        const id = editBtn.dataset.editContent;
        const c = content.find(x => x.id === id);
        if (c) showEditModal(c, loadContent);
        return;
      }

      const requestBtn = e.target.closest('[data-request-publication]');
      if (requestBtn) {
        requestBtn.disabled = true;
        try {
          await api.requestContentPublication(requestBtn.dataset.requestPublication);
          showToast(t('content.toast.publication_requested'), 'success');
          loadContent();
        } catch (err) { showToast(err.message, 'error'); requestBtn.disabled = false; }
        return;
      }

      const duplicateBtn = e.target.closest('[data-duplicate-content]');
      if (duplicateBtn) {
        duplicateBtn.disabled = true;
        try {
          await api.duplicateContent(duplicateBtn.dataset.duplicateContent);
          showToast(t('content.toast.duplicated'), 'success');
          loadContent();
        } catch (err) { showToast(err.message, 'error'); duplicateBtn.disabled = false; }
        return;
      }

      const transferBtn = e.target.closest('[data-transfer-content]');
      if (transferBtn) {
        const item = content.find(entry => entry.id === transferBtn.dataset.transferContent);
        if (item) showTransferModal(item, loadContent);
        return;
      }

      const assignmentsBtn = e.target.closest('[data-template-assignments]');
      if (assignmentsBtn) {
        const item = content.find(entry => entry.id === assignmentsBtn.dataset.templateAssignments);
        if (item) showTemplateAssignmentsModal(item, loadContent);
        return;
      }

      const archiveBtn = e.target.closest('[data-archive-content]');
      if (archiveBtn) {
        const restoring = archiveBtn.dataset.archived === 'true';
        const message = restoring ? t('content.confirm_restore') : t('content.confirm_archive');
        if (!confirm(message)) return;
        archiveBtn.disabled = true;
        try {
          await api.archiveContent(archiveBtn.dataset.archiveContent, !restoring);
          showToast(restoring ? t('content.toast.restored') : t('content.toast.archived'), 'success');
          loadContent();
        } catch (err) {
          if (err.code === 'CONTENT_IN_USE') {
            const usage = await api.getContentUsage(archiveBtn.dataset.archiveContent).catch(() => err.details);
            showUsageConflict(usage);
          } else showToast(err.message, 'error');
          archiveBtn.disabled = false;
        }
        return;
      }

      const btn = e.target.closest('[data-delete-content]');
      if (!btn) return;
      e.stopPropagation();
      const id = btn.dataset.deleteContent;

      // If already confirming, do the delete
      if (btn.dataset.confirming === 'true') {
        try {
          btn.disabled = true;
          btn.textContent = t('content.btn_deleting');
          await api.deleteContent(id);
          showToast(t('content.toast.deleted'), 'success');
          loadContent();
        } catch (err) {
          showToast(err.message, 'error');
          btn.disabled = false;
          btn.textContent = t('content.btn_delete');
          btn.dataset.confirming = 'false';
        }
        return;
      }

      // First click - show confirm state
      btn.dataset.confirming = 'true';
      btn.innerHTML = t('content.btn_confirm_delete');
      btn.style.background = 'var(--danger)';
      btn.style.color = 'white';
      // Reset after 3 seconds if not clicked
      setTimeout(() => {
        if (btn.dataset.confirming === 'true') {
          btn.dataset.confirming = 'false';
          btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> ${t('content.btn_delete')}`;
          btn.style.background = '';
          btn.style.color = '';
        }
      }, 3000);
    };

  } catch (err) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>${t('content.failed_to_load')}</h3><p>${esc(err.message)}</p></div>`;
  }
}

function showEditModal(contentItem, onSave) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';

  const isRemote = !!contentItem.remote_url;

  overlay.innerHTML = `
    <div class="modal" style="max-width:500px;width:95vw">
      <div class="modal-header">
        <h3>${t('content.edit_modal_title')}</h3>
        <button class="btn-icon" id="closeEditModal">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>${t('content.label_filename')}</label>
          <input type="text" id="editFilename" class="input" value="${esc(contentItem.filename)}">
        </div>
        ${isRemote ? `
        <div class="form-group">
          <label>${t('content.label_remote_url_field')}</label>
          <input type="text" id="editRemoteUrl" class="input" value="${esc(contentItem.remote_url)}">
        </div>
        ` : ''}
        <div class="form-group">
          <label>${t('content.label_mime_type')}</label>
          <select id="editMimeType" class="input" style="background:var(--bg-input)">
            <option value="video/mp4" ${contentItem.mime_type === 'video/mp4' ? 'selected' : ''}>${t('content.mime.video_mp4')}</option>
            <option value="video/webm" ${contentItem.mime_type === 'video/webm' ? 'selected' : ''}>${t('content.mime.video_webm')}</option>
            <option value="image/jpeg" ${contentItem.mime_type === 'image/jpeg' ? 'selected' : ''}>${t('content.mime.image_jpeg')}</option>
            <option value="image/png" ${contentItem.mime_type === 'image/png' ? 'selected' : ''}>${t('content.mime.image_png')}</option>
            <option value="image/gif" ${contentItem.mime_type === 'image/gif' ? 'selected' : ''}>${t('content.mime.image_gif')}</option>
            <option value="image/webp" ${contentItem.mime_type === 'image/webp' ? 'selected' : ''}>${t('content.mime.image_webp')}</option>
            <option value="application/pdf" ${contentItem.mime_type === 'application/pdf' ? 'selected' : ''}>PDF document</option>
            <option value="application/vnd.openxmlformats-officedocument.wordprocessingml.document" ${contentItem.mime_type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? 'selected' : ''}>Word (.docx)</option>
            <option value="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ${contentItem.mime_type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ? 'selected' : ''}>Excel (.xlsx)</option>
            <option value="application/vnd.openxmlformats-officedocument.presentationml.presentation" ${contentItem.mime_type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ? 'selected' : ''}>PowerPoint (.pptx)</option>
          </select>
        </div>
        <div class="form-group">
          <label>${t('content.label_folder')}</label>
          <select id="editFolderId" class="input" style="background:var(--bg-input)">
            <option value="">${t('content.folder_root_option')}</option>
            ${state.folders.map(f => `<option value="${f.id}" ${contentItem.folder_id === f.id ? 'selected' : ''}>${esc(folderPath(f, state.folders))}</option>`).join('')}
          </select>
        </div>
        ${contentItem.permissions?.can_change_visibility ? `
        <div class="form-group">
          <label>${t('content.label_visibility')}</label>
          <select id="editAccessLevel" class="input" style="background:var(--bg-input)">
            ${(contentItem.permissions.allowed_visibilities || []).map(level => `
              <option value="${level}" ${contentItem.visibility?.access_level === level ? 'selected' : ''}>${visibilityLabel(level)}</option>
            `).join('')}
          </select>
          <p class="content-field-hint">${t('content.visibility_hint')}</p>
        </div>
        ` : ''}
        <div class="form-group">
          <label>Default display fit</label>
          <select id="editFitMode" class="input" style="background:var(--bg-input)">
            <option value="" ${!contentItem.default_fit_mode ? 'selected' : ''}>Auto (contain in solo, fill on wall)</option>
            <option value="contain" ${contentItem.default_fit_mode === 'contain' ? 'selected' : ''}>Contain — letterbox, preserve aspect</option>
            <option value="cover" ${contentItem.default_fit_mode === 'cover' ? 'selected' : ''}>Cover — crop to fill screen</option>
            <option value="fill" ${contentItem.default_fit_mode === 'fill' ? 'selected' : ''}>Fullscreen — stretch to fill (recommended for video walls)</option>
          </select>
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">Default for new playlist additions. Existing playlist items keep their own per-item override.</p>
        </div>
        ${!isRemote ? `
        <div class="form-group">
          <label>${t('content.label_replace_file')}</label>
          <input type="file" id="editFileReplace" accept="video/*,image/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/msword,application/vnd.ms-excel,application/vnd.ms-powerpoint,application/vnd.oasis.opendocument.text,application/vnd.oasis.opendocument.spreadsheet,application/vnd.oasis.opendocument.presentation" style="font-size:13px;color:var(--text-secondary)">
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('content.replace_file_hint')}</p>
        </div>
        ` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="cancelEditBtn">${t('common.cancel')}</button>
        <button class="btn btn-primary" id="saveEditBtn">${t('content.save_changes')}</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.querySelector('#closeEditModal').onclick = () => overlay.remove();
  overlay.querySelector('#cancelEditBtn').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  overlay.querySelector('#saveEditBtn').onclick = async () => {
    const filename = overlay.querySelector('#editFilename').value.trim();
    const mimeType = overlay.querySelector('#editMimeType').value;
    const remoteUrl = overlay.querySelector('#editRemoteUrl')?.value.trim();
    const replaceFile = overlay.querySelector('#editFileReplace')?.files[0];

    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: 'Bearer ' + token };

      // Update metadata
      const folderId = overlay.querySelector('#editFolderId')?.value || '';
      const fitMode = overlay.querySelector('#editFitMode')?.value || '';
      const accessLevel = overlay.querySelector('#editAccessLevel')?.value;
      const updateData = {};
      if (filename !== contentItem.filename) updateData.filename = filename;
      if (mimeType !== contentItem.mime_type) updateData.mime_type = mimeType;
      if (remoteUrl !== undefined && remoteUrl !== contentItem.remote_url) updateData.remote_url = remoteUrl;
      if ((contentItem.folder_id || '') !== folderId) updateData.folder_id = folderId || null;
      if ((contentItem.default_fit_mode || '') !== fitMode) updateData.default_fit_mode = fitMode || null;
      if (accessLevel && accessLevel !== contentItem.visibility?.access_level) updateData.access_level = accessLevel;

      let expectedVersion = Number(contentItem.version) || 1;
      if (Object.keys(updateData).length > 0) {
        updateData.expected_version = expectedVersion;
        const updated = await api.updateContent(contentItem.id, updateData);
        expectedVersion = Number(updated?.version) || expectedVersion + 1;
      }

      // Replace file if provided
      if (replaceFile) {
        const formData = new FormData();
        formData.append('file', replaceFile);
        formData.append('expected_version', String(expectedVersion));
        const response = await fetch('/api/content/' + contentItem.id + '/replace', {
          method: 'PUT',
          headers,
          body: formData
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || t('content.error_update_failed'));
        }
      }

      overlay.remove();
      showToast(t('content.toast.updated'), 'success');
      if (onSave) onSave();
    } catch (err) {
      showToast(err.message || t('content.error_update_failed'), 'error');
    }
  };
}

function showPreview(content) {
  const isYoutube = content.mime_type === 'video/youtube';
  const isVideo = !isYoutube && content.mime_type?.startsWith('video/');
  const src = content.remote_url || content.file_url || `/api/content/${content.id}/file`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div style="background:var(--bg-secondary);border-radius:var(--radius-lg);max-width:90vw;max-height:90vh;overflow:hidden;position:relative">
      <button style="position:absolute;top:8px;right:8px;z-index:1;background:rgba(0,0,0,0.7);border:none;color:white;width:32px;height:32px;border-radius:50%;font-size:18px;cursor:pointer" id="closePreview">&times;</button>
      <div style="max-width:80vw;max-height:80vh">
        ${isYoutube
          ? `<iframe src="${(() => { try { const u = new URL(src); if (!u.searchParams.has('mute')) u.searchParams.set('mute','1'); if (!u.searchParams.has('enablejsapi')) u.searchParams.set('enablejsapi','1'); if (!u.searchParams.has('origin')) u.searchParams.set('origin', window.location.origin); return u.toString(); } catch { return src; } })()}" style="width:80vw;height:45vw;max-height:80vh;display:block;border:none" allow="autoplay;encrypted-media" allowfullscreen></iframe>`
          : isVideo
            ? `<video src="${esc(src)}" controls autoplay style="max-width:80vw;max-height:80vh;display:block"></video>`
            : `<img src="${esc(src)}" style="max-width:80vw;max-height:80vh;display:block">`
        }
      </div>
      <div style="padding:12px 16px;border-top:1px solid var(--border)">
        <div style="font-weight:500">${esc(content.filename)}</div>
        <div style="font-size:12px;color:var(--text-muted)">${esc(content.mime_type)} ${content.remote_url ? `(${t('content.type_remote')})` : ''}</div>
      </div>
    </div>
  `;
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#closePreview').onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

function showUsageConflict(usage = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  const playlists = Array.isArray(usage.playlists) ? usage.playlists : [];
  const assignments = Array.isArray(usage.assignments) ? usage.assignments : [];
  const references = Array.isArray(usage.references) ? usage.references : [];
  overlay.innerHTML = `
    <div class="modal content-governance-modal" role="dialog" aria-modal="true" aria-labelledby="usageConflictTitle">
      <div class="modal-header">
        <h3 id="usageConflictTitle">${t('content.in_use_title')}</h3>
        <button class="btn-icon" data-close-modal aria-label="${t('common.close')}">&times;</button>
      </div>
      <div class="modal-body">
        <p>${t('content.in_use_desc', { count: usage.usage_count || playlists.length + assignments.length })}</p>
        ${playlists.length ? `<h4>${t('content.usage_playlists')}</h4><ul>${playlists.map(item => `<li>${esc(item.name || item.id)}</li>`).join('')}</ul>` : ''}
        ${assignments.length ? `<h4>${t('content.usage_displays')}</h4><ul>${assignments.map(item => `<li>${esc(item.device_name || item.device_id || item.id)}</li>`).join('')}</ul>` : ''}
        ${references.length ? `<h4>${t('content.usage_routes')}</h4><ul>${references.map(item => `<li>${esc(item.type)}: ${esc(item.name || item.id)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="modal-footer"><button class="btn btn-primary" data-close-modal>${t('common.close')}</button></div>
    </div>`;
  overlay.querySelectorAll('[data-close-modal]').forEach(button => { button.onclick = () => overlay.remove(); });
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

async function showTransferModal(contentItem, onSave) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal content-governance-modal" role="dialog" aria-modal="true" aria-labelledby="transferContentTitle">
      <div class="modal-header">
        <div><h3 id="transferContentTitle">${t('content.transfer_title')}</h3><p class="content-modal-subtitle">${esc(contentItem.filename)}</p></div>
        <button class="btn-icon" data-close-modal aria-label="${t('common.close')}">&times;</button>
      </div>
      <div class="modal-body" data-transfer-body><div class="empty-state"><h3>${t('common.loading')}</h3></div></div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-close-modal>${t('common.cancel')}</button>
        <button class="btn btn-primary" data-transfer-save disabled>${t('content.transfer_save')}</button>
      </div>
    </div>`;
  overlay.querySelectorAll('[data-close-modal]').forEach(button => { button.onclick = () => overlay.remove(); });
  overlay.onclick = event => { if (event.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);

  const body = overlay.querySelector('[data-transfer-body]');
  const save = overlay.querySelector('[data-transfer-save]');
  try {
    const members = await api.getWorkspaceMembers(contentItem.workspace_id);
    const eligible = members.filter(member => member.user_id && member.user_id !== contentItem.user_id);
    if (!eligible.length) {
      body.innerHTML = `<div class="empty-state"><h3>${t('content.transfer_empty')}</h3><p>${t('content.transfer_empty_desc')}</p></div>`;
      return;
    }
    body.innerHTML = `
      <div class="form-group">
        <label for="transferOwnerId">${t('content.transfer_owner_label')}</label>
        <select id="transferOwnerId" class="input" style="background:var(--bg-input)">
          <option value="">${t('content.transfer_owner_placeholder')}</option>
          ${eligible.map(member => `<option value="${esc(member.user_id)}">${esc(member.name || member.email)}${member.name && member.email ? ` — ${esc(member.email)}` : ''}</option>`).join('')}
        </select>
        <p class="content-field-hint">${t('content.transfer_warning')}</p>
      </div>`;
    const select = body.querySelector('#transferOwnerId');
    select.onchange = () => { save.disabled = !select.value; };
    save.onclick = async () => {
      if (!select.value) return;
      save.disabled = true;
      try {
        await api.transferContent(contentItem.id, select.value);
        overlay.remove();
        showToast(t('content.toast.transferred'), 'success');
        if (onSave) onSave();
      } catch (err) {
        showToast(err.message, 'error');
        save.disabled = false;
      }
    };
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><h3>${t('content.transfer_failed')}</h3><p>${esc(err.message)}</p></div>`;
  }
}

async function showTemplateAssignmentsModal(contentItem, onSave) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal content-governance-modal" role="dialog" aria-modal="true" aria-labelledby="templateAssignmentsTitle">
      <div class="modal-header">
        <div><h3 id="templateAssignmentsTitle">${t('content.template_assignments_title')}</h3><p class="content-modal-subtitle">${esc(contentItem.filename)}</p></div>
        <button class="btn-icon" data-close-modal aria-label="${t('common.close')}">&times;</button>
      </div>
      <div class="modal-body" data-template-body><div class="empty-state"><h3>${t('common.loading')}</h3></div></div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-close-modal>${t('common.cancel')}</button>
        <button class="btn btn-primary" data-template-save disabled>${t('content.template_assignments_save')}</button>
      </div>
    </div>`;
  overlay.querySelectorAll('[data-close-modal]').forEach(button => { button.onclick = () => overlay.remove(); });
  overlay.onclick = event => { if (event.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);

  const body = overlay.querySelector('[data-template-body]');
  const save = overlay.querySelector('[data-template-save]');
  try {
    const [me, assignments] = await Promise.all([
      api.getMe(),
      api.getTemplateAssignments(contentItem.id),
    ]);
    const selected = new Set(assignments.workspace_ids || []);
    const workspaces = me.accessible_workspaces || [];
    body.innerHTML = workspaces.length
      ? `<p class="content-field-hint">${t('content.template_assignments_desc')}</p>
         <div class="content-template-workspaces">${workspaces.map(workspace => `
           <label class="content-template-workspace">
             <input type="checkbox" value="${esc(workspace.id)}" ${selected.has(workspace.id) ? 'checked' : ''}>
             <span><strong>${esc(workspace.name)}</strong><small>${esc(workspace.organization_name || '')}</small></span>
           </label>`).join('')}</div>`
      : `<div class="empty-state"><h3>${t('content.template_assignments_empty')}</h3></div>`;
    save.disabled = !workspaces.length;
    save.onclick = async () => {
      save.disabled = true;
      const workspaceIds = [...body.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
      try {
        await api.updateTemplateAssignments(contentItem.id, workspaceIds);
        overlay.remove();
        showToast(t('content.toast.template_assignments_saved'), 'success');
        if (onSave) onSave();
      } catch (err) {
        if (err.code === 'CONTENT_IN_USE') showUsageConflict(err.details);
        else showToast(err.message, 'error');
        save.disabled = false;
      }
    };
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><h3>${t('content.template_assignments_failed')}</h3><p>${esc(err.message)}</p></div>`;
  }
}

async function showPublicationReviewModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal content-governance-modal" role="dialog" aria-modal="true" aria-labelledby="publicationReviewTitle">
      <div class="modal-header">
        <div><h3 id="publicationReviewTitle">${t('content.review_title')}</h3><p class="content-modal-subtitle">${t('content.review_desc')}</p></div>
        <button class="btn-icon" data-close-modal aria-label="${t('common.close')}">&times;</button>
      </div>
      <div class="modal-body" data-review-list><div class="empty-state"><h3>${t('common.loading')}</h3></div></div>
    </div>`;
  overlay.querySelector('[data-close-modal]').onclick = () => overlay.remove();
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);

  const list = overlay.querySelector('[data-review-list]');
  try {
    const requests = await api.getPublicationRequests();
    if (!requests.length) {
      list.innerHTML = `<div class="empty-state"><h3>${t('content.review_empty')}</h3><p>${t('content.review_empty_desc')}</p></div>`;
      return;
    }
    list.innerHTML = requests.map(request => `
      <article class="content-review-row" data-request-id="${esc(request.id)}">
        <div>
          <strong>${esc(request.filename)}</strong>
          <div class="content-governance-meta">${t('content.owner')}: ${esc(request.owner_name || request.owner_user_id || t('content.owner_unknown'))}</div>
        </div>
        <div class="content-review-actions">
          <button class="btn btn-danger btn-sm" data-review-decision="rejected">${t('content.reject')}</button>
          <button class="btn btn-primary btn-sm" data-review-decision="approved">${t('content.approve')}</button>
        </div>
      </article>`).join('');
    list.onclick = async (event) => {
      const button = event.target.closest('[data-review-decision]');
      if (!button) return;
      const row = button.closest('[data-request-id]');
      const decision = button.dataset.reviewDecision;
      const reason = prompt(t('content.review_reason_prompt'));
      if (reason === null) return;
      row.querySelectorAll('button').forEach(item => { item.disabled = true; });
      try {
        await api.reviewPublicationRequest(row.dataset.requestId, decision, reason.trim());
        row.remove();
        showToast(decision === 'approved' ? t('content.toast.approved') : t('content.toast.rejected'), 'success');
        if (!list.querySelector('[data-request-id]')) list.innerHTML = `<div class="empty-state"><h3>${t('content.review_empty')}</h3></div>`;
        loadContent();
      } catch (err) {
        showToast(err.message, 'error');
        row.querySelectorAll('button').forEach(item => { item.disabled = false; });
      }
    };
  } catch (err) {
    list.innerHTML = `<div class="empty-state"><h3>${t('content.review_failed')}</h3><p>${esc(err.message)}</p></div>`;
  }
}

// Build a "Parent / Child / Leaf" path for a folder so the move-to dropdown is unambiguous
// when two folders share a name in different branches.
function folderPath(folder, all) {
  const byId = new Map(all.map(f => [f.id, f]));
  const parts = [folder.name];
  let cursor = folder;
  while (cursor.parent_id && byId.has(cursor.parent_id)) {
    cursor = byId.get(cursor.parent_id);
    parts.unshift(cursor.name);
  }
  return parts.join(' / ');
}

export function cleanup() {}
