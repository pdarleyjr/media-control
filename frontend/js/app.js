import { connectSocket, disconnectSocket } from './socket.js';
import * as dashboard from './views/dashboard.js';
import * as deviceDetail from './views/device-detail.js';
import * as contentLibrary from './views/content-library.js';
import * as settings from './views/settings.js';
import * as login from './views/login.js';
import * as layoutEditor from './views/layout-editor.js';
import * as videoWall from './views/video-wall.js';
import * as activity from './views/activity.js';
import * as onboarding from './views/onboarding.js';
import * as help from './views/help.js';
import * as admin from './views/admin.js';
import * as adminPlayerDebug from './views/admin-player-debug.js';
import * as playlists from './views/playlists.js';
import * as scenes from './views/scenes.js';
import * as screenShare from './views/screen-share.js';
import * as smartboard from './views/smartboard.js';
import * as home from './views/home.js';
import * as comingSoon from './views/coming-soon.js';
import * as presentations from './views/presentations.js';
import * as aiDeck from './views/ai-deck-builder.js';
import * as auditLog from './views/audit-log.js';
import * as slideEditor from './views/slide-editor.js';
import * as filesView from './views/files.js';
import * as downloadsView from './views/downloads.js';
import * as broadcastCenter from './views/broadcast-center.js';
import * as schedules from './views/schedules.js';
import * as workspaceMembers from './views/workspace-members.js';
import * as mediaControl from './views/media-control.js';
import { applyBranding } from './branding.js';
import { t } from './i18n.js';
import { esc, isPlatformAdmin } from './utils.js';
import { renderWorkspaceSwitcher } from './components/workspace-switcher.js';
import { showToast } from './components/toast.js';
import { api } from './api.js';

const app = document.getElementById('app');
const sidebar = document.querySelector('.sidebar');
let currentView = null;
const SIDEBAR_COLLAPSED_KEY = 'mc_sidebar_collapsed';
const CONSOLE_MODE = window.location.pathname.startsWith('/console/');
const CONSOLE_ROOM_ID = CONSOLE_MODE
  ? (window.location.pathname.split('/console/')[1] || 'classroom-1').split('/')[0] || 'classroom-1'
  : null;
const CONSOLE_DEVICE_ID = new URLSearchParams(window.location.search).get('device_id') || 'classroom-1-podium-console';
let consoleSessionReady = false;
let consoleProfiles = [];
let consoleClockTimer = null;

// ==================== Slice 2C: accept-invite plumbing ====================
//
// Flow shape (covers all six auth entry points - login, register, support,
// Google, Microsoft, first-user-setup - because they all funnel through
// onAuthSuccess() in login.js which calls window.location.reload()):
//
//   1. Hash route #/accept-invite/{id}:
//      - unauthed: stash inviteId in localStorage, redirect to login
//      - authed:   call consumeAcceptInvite() directly (no stash)
//   2. App boot (every route() call once auth checks pass): if a valid
//      non-stale stash is present, fire consumeAcceptInvite. After login
//      reload lands here and picks it up automatically.
//   3. consumeAcceptInvite on success: stash toast text, switch workspace,
//      reload. Reload re-fires route() which picks up the toast stash and
//      shows it on dashboard. Reload is needed for the new JWT/socket/
//      sidebar /me to pick up the new workspace context.
//   4. consumeAcceptInvite on error: showToast directly + clear stash.
//      No reload (no state change to propagate).

const PENDING_INVITE_KEY = 'pending_invite';
const PENDING_INVITE_TOAST_KEY = 'pending_invite_toast';
// Mirrors the backend INVITE_EXPIRY_DAYS default (7). If an operator changes
// the backend default, this should be updated to match - tracked in handoff.
const INVITE_EXPIRY_DAYS_FRONTEND = 7;

// Non-reentrant guard: route() can fire multiple times (hashchange events).
// Once consume is in flight, additional calls no-op until reload completes.
let _acceptInFlight = false;

function stashPendingInvite(inviteId) {
  localStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({
    inviteId,
    stashedAt: Math.floor(Date.now() / 1000),
  }));
}

function readPendingInvite() {
  const raw = localStorage.getItem(PENDING_INVITE_KEY);
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { localStorage.removeItem(PENDING_INVITE_KEY); return null; }
  if (!parsed?.inviteId || !parsed?.stashedAt) {
    localStorage.removeItem(PENDING_INVITE_KEY);
    return null;
  }
  const ageSecs = Math.floor(Date.now() / 1000) - parsed.stashedAt;
  if (ageSecs > INVITE_EXPIRY_DAYS_FRONTEND * 86400) {
    localStorage.removeItem(PENDING_INVITE_KEY);
    return null;
  }
  return parsed.inviteId;
}

function clearPendingInvite() {
  localStorage.removeItem(PENDING_INVITE_KEY);
}

// Map backend error message text to a translated toast string. We match
// English text because api.js doesn't surface HTTP status codes today;
// refactor to err.status when that lands - tracked in handoff doc.
function mapAcceptError(err) {
  const msg = err?.message || '';
  if (/Invite not found/i.test(msg)) return t('accept.error.not_found');
  if (/Invite has expired|Workspace no longer exists/i.test(msg)) return t('accept.error.expired');
  if (/different email address/i.test(msg)) return t('accept.error.wrong_account');
  return t('accept.error.generic');
}

async function consumeAcceptInvite(inviteId) {
  if (_acceptInFlight) return;
  _acceptInFlight = true;
  try {
    const result = await api.acceptInvite(inviteId);

    // Switch to the joined workspace. New JWT carries the workspace context;
    // reload picks it up for sidebar /me + socket rooms + data fetches. If
    // the switch fails, log and reload anyway - the membership was created
    // so the user can switch manually via the dropdown.
    try {
      const sw = await api.switchWorkspace(result.workspace_id);
      if (sw?.token) localStorage.setItem('token', sw.token);
    } catch (e) {
      console.warn('switchWorkspace after accept failed (non-fatal):', e.message);
    }

    // Stash the toast text in a scoped key (not a generic pending-toast
    // channel) so app boot below fires it after reload.
    const toastKey = result.already_member ? 'accept.already_member' : 'accept.success';
    localStorage.setItem(PENDING_INVITE_TOAST_KEY, JSON.stringify({
      message: t(toastKey, { name: result.workspace_name }),
      kind: 'success',
    }));

    clearPendingInvite();
    // history.replaceState mutates the hash WITHOUT firing hashchange.
    // Important: a plain `location.hash = '#/'` would fire hashchange
    // synchronously, causing route() to fire a second time before the
    // reload runs - that second route() call would consume the toast key
    // and attach the toast to a DOM that's about to be destroyed by the
    // reload. Using replaceState bypasses that race so the post-reload
    // route() is the only one that picks up the toast.
    history.replaceState(null, '', window.location.pathname + '#/');
    window.location.reload();
  } catch (err) {
    showToast(mapAcceptError(err), 'error');
    clearPendingInvite();
    _acceptInFlight = false;
  }
}

// Fires once per page load (single-shot key in localStorage). If the
// previous routeApp cycle stashed a toast across reload, show it now.
function consumePendingInviteToast() {
  const raw = localStorage.getItem(PENDING_INVITE_TOAST_KEY);
  if (!raw) return;
  localStorage.removeItem(PENDING_INVITE_TOAST_KEY);
  try {
    const { message, kind } = JSON.parse(raw);
    if (message) showToast(message, kind || 'info');
  } catch {}
}

// Map nav-link data-view to its translation key.
const NAV_LABEL_KEYS = {
  control: 'nav.control',
  dashboard: 'nav.displays',
  home: 'nav.home',
  presentations: 'nav.presentations',
  'ai-deck': 'nav.ai_deck',
  'slide-editor': 'nav.slide_editor',
  content: 'nav.media_library',
  downloads: 'nav.downloads',
  playlists: 'nav.playlists',
  layouts: 'nav.layouts',
  schedule: 'nav.schedule',
  broadcast: 'nav.broadcast',
  files: 'nav.files',
  walls: 'nav.walls',
  activity: 'nav.activity',
  help: 'nav.help',
  settings: 'nav.settings',
  admin: 'nav.admin',
  audit: 'nav.audit',
};

function renderNavLabels() {
  document.querySelectorAll('.nav-link').forEach((link) => {
    const key = NAV_LABEL_KEYS[link.dataset.view];
    if (!key) return;
    const label = t(key);
    const span = link.querySelector('span');
    if (span) span.textContent = label;
    link.setAttribute('title', label);
  });
  updateSidebarCollapseButton();
}

function sidebarCollapsed() {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
}

function setSidebarCollapsed(collapsed) {
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  sidebar?.classList.toggle('collapsed', collapsed);
  updateSidebarCollapseButton();
}

function updateSidebarCollapseButton() {
  const btn = document.getElementById('sidebarCollapseBtn');
  if (!btn) return;
  const collapsed = document.body.classList.contains('sidebar-collapsed');
  const label = collapsed ? t('nav.expand') : t('nav.collapse');
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
  btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}



// Translate any element marked with data-i18n / data-i18n-placeholder /
// data-i18n-html. Runs on init and on every language change. Used for static
// HTML in index.html (e.g. the Add-Display modal) where t() can't be inlined
// at template time.
function translateStaticDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
}

function isAuthenticated() {
  return !!localStorage.getItem('token');
}

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem('user'));
  } catch { return null; }
}

async function requestConsoleSession(profileId, previousProfileId = null) {
  const res = await fetch('/api/console/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room_id: CONSOLE_ROOM_ID || 'classroom-1',
      device_id: CONSOLE_DEVICE_ID,
      profile_id: profileId || 'guest',
      previous_profile_id: previousProfileId,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Console session failed');
  return body;
}

function storeConsoleSession(session) {
  localStorage.setItem('token', session.token);
  localStorage.setItem('user', JSON.stringify(session.user));
  localStorage.setItem('rd_onboarded', '1');
  localStorage.setItem('mc_console_profile_id', session.user.id);
  localStorage.setItem('mc_console_room_id', session.room_id || CONSOLE_ROOM_ID || 'classroom-1');
  localStorage.setItem('mc_console_device_id', session.device_id || CONSOLE_DEVICE_ID);
  sessionStorage.setItem('mc_console_active_profile', session.user.id);
  consoleProfiles = Array.isArray(session.profiles) ? session.profiles : [];
}

function renderConsoleBoot(message) {
  document.body.classList.add('console-mode');
  sidebar.style.display = 'none';
  app.style.marginLeft = '0';
  app.innerHTML = `
    <section class="console-boot" aria-live="polite">
      <div class="console-boot-card">
        <div class="console-logo" data-console-logo>MBFD</div>
        <p class="console-kicker">Media Control Console</p>
        <h1>${esc(message || 'Loading Guest Profile')}</h1>
        <p>Preparing the trusted classroom control surface.</p>
      </div>
    </section>
  `;
}

async function ensureConsoleSession() {
  if (!CONSOLE_MODE || consoleSessionReady) return true;
  renderConsoleBoot('Loading Guest Profile');
  try {
    const initialProfile = sessionStorage.getItem('mc_console_active_profile') || 'guest';
    const session = await requestConsoleSession(initialProfile);
    storeConsoleSession(session);
    consoleSessionReady = true;
    if (!window.location.hash || window.location.hash === '#/login') window.location.hash = '#/control';
    connectSocket();
    applyBranding();
    await refreshCurrentUser();
    return true;
  } catch (err) {
    renderConsoleBoot(err?.message || 'Console Session Unavailable');
    return false;
  }
}

function updateConsoleClock() {
  const el = document.getElementById('consoleClock');
  if (!el) return;
  el.textContent = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(new Date());
}

function renderConsoleHeader() {
  if (!CONSOLE_MODE) return;
  let header = document.getElementById('consoleHeader');
  if (!header) {
    header = document.createElement('header');
    header.id = 'consoleHeader';
    header.className = 'console-header';
    document.body.insertBefore(header, document.body.firstChild);
  }
  const current = getCurrentUser();
  const options = consoleProfiles.map((profile) => `
    <option value="${esc(profile.id)}" ${profile.id === current?.id ? 'selected' : ''}>${esc(profile.name || profile.email || profile.id)}</option>
  `).join('');
  header.innerHTML = `
    <div class="console-brand" data-console-logo title="Long press for service access">
      <span class="console-logo-mini">MBFD</span>
      <div>
        <strong>MBFD Media Control</strong>
        <span>Classroom 1</span>
      </div>
    </div>
    <div class="console-status-strip" aria-label="System status">
      <span class="console-status-dot"></span><span>System Ready</span>
      <span class="console-status-network">Network Online</span>
    </div>
    <label class="console-profile-picker">
      <span>Profile</span>
      <select id="consoleProfileSelect" aria-label="Current profile">${options}</select>
    </label>
    <time id="consoleClock" class="console-clock"></time>
  `;
  const select = document.getElementById('consoleProfileSelect');
  select?.addEventListener('change', async (event) => {
    const selected = event.target.value;
    const previous = localStorage.getItem('mc_console_profile_id');
    select.disabled = true;
    try {
      const session = await requestConsoleSession(selected, previous);
      storeConsoleSession(session);
      disconnectSocket();
      connectSocket();
      await refreshCurrentUser();
      showToast(`Loaded ${session.user.name || session.user.email}`, 'success');
      window.location.hash = '#/control';
      renderConsoleHeader();
      await route();
    } catch (err) {
      showToast(err?.message || 'Profile switch failed', 'error');
      renderConsoleHeader();
    }
  });
  updateConsoleClock();
  if (!consoleClockTimer) consoleClockTimer = setInterval(updateConsoleClock, 15000);
}

// Refresh the cached user from the server. The server reads plan_id fresh
// from the DB on every request, but the frontend only wrote `user` into
// localStorage at login — so plan/role changes made by an admin weren't
// visible until the user logged out and back in.
async function refreshCurrentUser() {
  const token = localStorage.getItem('token');
  if (!token) return;
  try {
    const res = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const fresh = await res.json();
    localStorage.setItem('user', JSON.stringify(fresh));
    // Re-render the workspace switcher on every /me refresh - cheap, and keeps
    // the dropdown in sync if a workspace was added/removed in another tab.
    renderWorkspaceSwitcher(fresh);
    window.dispatchEvent(new CustomEvent('user-refreshed', { detail: fresh }));
  } catch {}
}

async function route() {
  // Cleanup previous view. Call BOTH cleanup() and unmount() because
  // older views use cleanup() while screen-share (and any view that holds
  // background resources like a WebRTC peer connection) uses unmount().
  if (currentView) {
    if (currentView.cleanup) { try { currentView.cleanup(); } catch (_) { /* */ } }
    if (currentView.unmount) { try { currentView.unmount(); } catch (_) { /* */ } }
  }

  const hash = window.location.hash || '#/';

  if (CONSOLE_MODE) {
    const ready = await ensureConsoleSession();
    if (!ready) return;
    if (hash === '#/login' || hash === '#/' || hash === '#') {
      window.location.hash = '#/control';
      return;
    }
  }

  // Slice 2C - direct hits on #/accept-invite/{id}. Handle BEFORE the
  // auth-redirect-to-login because an unauthed visit needs to stash the
  // inviteId so it survives the redirect.
  if (hash.startsWith('#/accept-invite/')) {
    const inviteId = hash.split('#/accept-invite/')[1].split('/')[0];
    if (inviteId) {
      if (!isAuthenticated()) {
        stashPendingInvite(inviteId);
        window.location.hash = '#/login';
        return;
      }
      consumeAcceptInvite(inviteId); // helper handles routing (reload to '#/')
      return;
    }
  }

  // Auth check - redirect to login if not authenticated
  if (!isAuthenticated() && hash !== '#/login') {
    window.location.hash = '#/login';
    return;
  }

  // If authenticated and on login page, land on the unified Media Control
  // dashboard (the home for everyone) or onboarding. The old per-role split
  // (instructors -> #/present, others -> #/home) is collapsed; role PERMISSIONS
  // are unchanged (Setup-nav gating in updateSidebarUser, what is editable,
  // workspace_viewer can't broadcast). #/home and #/present stay reachable by hash.
  if (isAuthenticated() && hash === '#/login') {
    if (!localStorage.getItem('rd_onboarded')) { window.location.hash = '#/onboarding'; return; }
    window.location.hash = '#/control';
    return;
  }

  // Authenticated and opening the BARE domain (no route yet) -> land on the
  // unified Media Control dashboard (the documented home for everyone). An
  // explicit '#/' or '#/displays' still opens the Displays grid, so the
  // sidebar's Displays link (href="#/") is unaffected.
  if (isAuthenticated() && (hash === '' || hash === '#')) {
    window.location.hash = '#/control';
    return;
  }

  // #/present is retired — its target picker, content tiles and Start/Blank
  // command bar are folded into the unified Command Center (#/control). Redirect
  // so old bookmarks/links land on the consolidated surface.
  if (isAuthenticated() && hash === '#/present') {
    window.location.hash = '#/control';
    return;
  }

  // #/home is retired — the Studio landing dashboard's recent panels live in the
  // Command Center rail and its quick-launches duplicate the Studio nav links, so
  // it is folded into #/control. Redirect old bookmarks to the consolidated surface.
  if (isAuthenticated() && hash === '#/home') {
    window.location.hash = '#/control';
    return;
  }

  // Slice 2C - past the auth gates. (a) Show any toast stashed across the
  // accept-invite reload boundary. (b) If a stash exists (from an unauthed
  // accept-invite visit + subsequent login/register), consume it now. The
  // helper's in-flight guard prevents double-fire on subsequent hashchanges.
  if (isAuthenticated()) {
    consumePendingInviteToast();
    const stashedInviteId = readPendingInvite();
    if (stashedInviteId) {
      consumeAcceptInvite(stashedInviteId);
      return;
    }
  }

  // Onboarding for new users
  if (hash === '#/onboarding' && isAuthenticated()) {
    sidebar.style.display = 'none';
    app.style.marginLeft = '0';
    currentView = onboarding;
    onboarding.render(app);
    return;
  }

  // Login page - hide sidebar
  if (hash === '#/login') {
    sidebar.style.display = 'none';
    app.style.marginLeft = '0';
    const mb = document.getElementById('mobileMenuBtn');
    if (mb) mb.style.display = 'none';
    currentView = login;
    login.render(app);
    return;
  }

  // Show sidebar for authenticated views unless the dedicated physical console
  // route is active. Console mode has its own touchscreen header/profile picker.
  if (CONSOLE_MODE) {
    document.body.classList.add('console-mode');
    sidebar.style.display = 'none';
    app.style.marginLeft = '0';
    renderConsoleHeader();
  } else {
    document.body.classList.remove('console-mode');
    sidebar.style.display = '';
    app.style.marginLeft = '';
  }
  const mb = document.getElementById('mobileMenuBtn');
  if (mb) mb.style.display = CONSOLE_MODE ? 'none' : '';

  // Update user info in sidebar
  updateSidebarUser();

  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    link.classList.remove('active');
    if (hash === '#/control' && link.dataset.view === 'control') link.classList.add('active');
    else if (hash === '#/present' && link.dataset.view === 'present') link.classList.add('active');
    else if (hash === '#/home' && link.dataset.view === 'home') link.classList.add('active');
    else if ((hash === '#/' || hash === '#/displays') && link.dataset.view === 'dashboard') link.classList.add('active');
    else if (hash === '#/presentations' && link.dataset.view === 'presentations') link.classList.add('active');
    else if (hash === '#/ai-deck' && link.dataset.view === 'ai-deck') link.classList.add('active');
    else if (hash.startsWith('#/slide-editor') && link.dataset.view === 'slide-editor') link.classList.add('active');
    else if (hash === '#/downloads' && link.dataset.view === 'downloads') link.classList.add('active');
    else if (hash === '#/broadcast' && link.dataset.view === 'broadcast') link.classList.add('active');
    else if (hash === '#/files' && link.dataset.view === 'files') link.classList.add('active');
    else if (hash === '#/audit' && link.dataset.view === 'audit') link.classList.add('active');
    else if (hash.startsWith('#/content') && link.dataset.view === 'content') link.classList.add('active');
    else if (hash.startsWith('#/settings') && link.dataset.view === 'settings') link.classList.add('active');
    else if ((hash.startsWith('#/layout') || hash === '#/layouts') && link.dataset.view === 'layouts') link.classList.add('active');
    else if ((hash === '#/playlists' || hash.startsWith('#/playlists/')) && link.dataset.view === 'playlists') link.classList.add('active');
    else if (hash === '#/scenes' && link.dataset.view === 'scenes') link.classList.add('active');
    else if (hash === '#/schedule' && link.dataset.view === 'schedule') link.classList.add('active');
    else if (hash === '#/widgets' && link.dataset.view === 'widgets') link.classList.add('active');
    else if ((hash.startsWith('#/wall') || hash === '#/walls') && link.dataset.view === 'walls') link.classList.add('active');
    else if (hash === '#/screen-share' && link.dataset.view === 'screen-share') link.classList.add('active');
    else if (hash.startsWith('#/smartboard') && link.dataset.view === 'smartboard') link.classList.add('active');
    else if (hash === '#/reports' && link.dataset.view === 'reports') link.classList.add('active');
    else if (hash === '#/activity' && link.dataset.view === 'activity') link.classList.add('active');
    else if (hash === '#/designer' && link.dataset.view === 'designer') link.classList.add('active');
    else if ((hash === '#/kiosk' || hash.startsWith('#/kiosk/')) && link.dataset.view === 'kiosk') link.classList.add('active');
    else if (hash === '#/help' && link.dataset.view === 'help') link.classList.add('active');
    else if (hash.startsWith('#/device/') && link.dataset.view === 'dashboard') link.classList.add('active');
  });

  // Route to view
  if (hash === '#/control') {
    currentView = mediaControl;
    await mediaControl.render();
  } else if (hash === '#/home') {
    currentView = home;
    home.render(app);
  } else if (hash === '#/' || hash === '#' || hash === '' || hash === '#/displays') {
    currentView = dashboard;
    dashboard.render(app);
  } else if (hash === '#/screen-share') {
    currentView = screenShare;
    screenShare.render(app);
  } else if (hash.startsWith('#/smartboard')) {
    currentView = smartboard;
    smartboard.render(app);
  } else if (hash.startsWith('#/device/')) {
    const deviceId = hash.split('#/device/')[1].split('/')[0];
    currentView = deviceDetail;
    deviceDetail.render(app, deviceId);
  } else if (hash === '#/content') {
    currentView = contentLibrary;
    contentLibrary.render(app);
  } else if (hash === '#/playlists' || hash.startsWith('#/playlists/')) {
    currentView = playlists;
    playlists.render(app);
  } else if (hash === '#/scenes') {
    currentView = scenes;
    scenes.render(app);
  } else if (hash === '#/layouts' || hash.startsWith('#/layout/')) {
    currentView = layoutEditor;
    layoutEditor.render(app);
  } else if (hash === '#/walls' || hash.startsWith('#/wall/')) {
    currentView = videoWall;
    videoWall.render(app);
  } else if (hash === '#/activity') {
    currentView = activity;
    activity.render(app);
  } else if (hash.startsWith('#/workspace/') && hash.includes('/members')) {
    const wsId = hash.split('#/workspace/')[1].split('/')[0];
    currentView = workspaceMembers;
    workspaceMembers.render(app, wsId);
  } else if (hash === '#/help' || hash.startsWith('#/help')) {
    currentView = help;
    help.render(app);
  } else if (hash.startsWith('#/admin/player-debug')) {
    // Match prefix so query params (?page=2&ua=Tizen) route correctly.
    currentView = adminPlayerDebug;
    adminPlayerDebug.render(app);
  } else if (hash === '#/admin') {
    currentView = admin;
    admin.render(app);
  } else if (hash === '#/settings') {
    currentView = settings;
    settings.render(app);
  } else if (hash === '#/presentations') {
    currentView = presentations;
    presentations.render(app);
  } else if (hash === '#/ai-deck') {
    currentView = aiDeck;
    aiDeck.render(app);
  } else if (hash.startsWith('#/slide-editor')) {
    currentView = slideEditor;
    slideEditor.render(app);
  } else if (hash === '#/downloads') {
    currentView = downloadsView;
    downloadsView.render(app);
  } else if (hash === '#/broadcast') {
    currentView = broadcastCenter;
    broadcastCenter.render(app);
  } else if (hash === '#/files') {
    currentView = filesView;
    filesView.render(app);
  } else if (hash === '#/audit') {
    currentView = auditLog;
    auditLog.render(app);
  } else if (hash === '#/schedule') {
    currentView = schedules;
    schedules.render(app);
  } else {
    currentView = dashboard;
    dashboard.render(app);
  }
}

function updateSidebarUser() {
  const user = getCurrentUser();
  if (!user) return;

  // Classroom-UX (2026-05-29): the "Setup" nav group (Content, Layouts, Video
  // Walls, Settings, Admin) is for admins who configure the room; plain
  // instructors see only the "Present" group. Inclusive by design — hide Setup
  // ONLY for known non-admin roles so we never lock a configurator out. The
  // Admin item gets its own platform-admin gate immediately below (it carries
  // the nav-setup-only class too, but the explicit line wins).
  const role = String(user.role || '').toLowerCase();
  const instructorOnly = !isPlatformAdmin(user) &&
    ['workspace_viewer', 'workspace_editor', 'viewer', 'editor', 'member', 'instructor'].includes(role);
  document.querySelectorAll('.nav-setup-only').forEach((el) => {
    el.style.display = instructorOnly ? 'none' : '';
  });

  // Show admin nav only for platform admins (legacy 'superadmin' or Phase 1 renamed 'platform_admin')
  const adminNav = document.getElementById('adminNavItem');
  if (adminNav) adminNav.style.display = isPlatformAdmin(user) ? '' : 'none';

  let userEl = document.getElementById('sidebarUser');
  if (!userEl) {
    const footer = document.querySelector('.sidebar-footer');
    userEl = document.createElement('div');
    userEl.id = 'sidebarUser';
    userEl.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border)';
    footer.insertBefore(userEl, footer.firstChild);
  }

  userEl.innerHTML = `
    ${user.avatar_url ? `<img src="${user.avatar_url}" style="width:28px;height:28px;border-radius:50%">` :
      `<div style="width:28px;height:28px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:white">${(user.name || user.email)[0].toUpperCase()}</div>`}
    <div style="flex:1;min-width:0">
      <div style="font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${user.name || user.email}</div>
      <div style="font-size:10px;color:var(--text-muted)">${user.role}</div>
    </div>
    <button id="logoutBtn" class="btn-icon" title="${t('auth.sign_out')}" style="flex-shrink:0">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
        <polyline points="16 17 21 12 16 7"/>
        <line x1="21" y1="12" x2="9" y2="12"/>
      </svg>
    </button>
  `;

  document.getElementById('logoutBtn')?.addEventListener('click', () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.hash = '#/login';
    window.location.reload();
  });
}

// Initialize. (Scenes + Smartboard nav links are static markup in index.html.)
renderNavLabels();
translateStaticDom();
setSidebarCollapsed(sidebarCollapsed());
window.addEventListener('language-changed', () => {
  renderNavLabels();
  translateStaticDom();
});

if (isAuthenticated() && !CONSOLE_MODE) {
  connectSocket();
  applyBranding();
  refreshCurrentUser().then(() => updateSidebarUser());
}

// Refresh the cached user on every route transition so plan/role changes
// made by an admin propagate without requiring a re-login.
window.addEventListener('hashchange', () => { if (isAuthenticated()) refreshCurrentUser(); });

// Register PWA service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw-admin.js').catch(() => {});
}

// Mobile sidebar: open/close via hamburger, backdrop, nav tap, Escape
const sidebarEl = document.querySelector('.sidebar');
const backdropEl = document.getElementById('sidebarBackdrop');
const menuBtn = document.getElementById('mobileMenuBtn');
const sidebarCollapseBtn = document.getElementById('sidebarCollapseBtn');

function setMobileNav(open) {
  if (!sidebarEl || !backdropEl) return;
  sidebarEl.classList.toggle('open', open);
  backdropEl.classList.toggle('open', open);
  menuBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
}

menuBtn?.addEventListener('click', () => {
  setMobileNav(!sidebarEl.classList.contains('open'));
});
sidebarCollapseBtn?.addEventListener('click', () => {
  setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
});
backdropEl?.addEventListener('click', () => setMobileNav(false));
window.addEventListener('hashchange', () => setMobileNav(false));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sidebarEl?.classList.contains('open')) setMobileNav(false);
});

// Auto-reload on frontend update (no more hard refresh needed)
let knownHash = null;
setInterval(async () => {
  try {
    const res = await fetch('/api/version');
    const { hash } = await res.json();
    if (knownHash === null) { knownHash = hash; return; }
    if (hash !== knownHash) {
      knownHash = hash;
      const toast = document.getElementById('toastContainer');
      if (toast) {
        const notice = document.createElement('div');
        notice.className = 'toast info';
        notice.setAttribute('role', 'status');
        notice.setAttribute('aria-live', 'polite');
        const message = document.createElement('span');
        message.textContent = t('app.update_available') + ' ';
        const reload = document.createElement('button');
        reload.type = 'button';
        reload.textContent = t('app.reload_now');
        reload.style.cssText = 'color:var(--accent);text-decoration:underline;font-weight:600;background:none;border:0;padding:0;cursor:pointer;font:inherit';
        reload.addEventListener('click', () => window.location.reload());
        message.appendChild(reload);
        notice.appendChild(message);
        toast.appendChild(notice);
      }
    }
  } catch {}
}, 15000);

// Session timeout warning - check JWT expiry every minute
if (isAuthenticated() && !CONSOLE_MODE) {
  setInterval(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      const expiresIn = (payload.exp * 1000) - Date.now();
      const minutesLeft = Math.floor(expiresIn / 60000);
      if (minutesLeft <= 0) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.hash = '#/login';
        window.location.reload();
      } else if (minutesLeft <= 30 && minutesLeft % 10 === 0) {
        // Warn at 30, 20, 10 minutes
        const toast = document.getElementById('toastContainer');
        if (toast && !toast.querySelector('.session-warn')) {
          const warn = document.createElement('div');
          warn.className = 'toast info session-warn';
          warn.setAttribute('role', 'status');
          warn.setAttribute('aria-live', 'polite');
          const message = document.createElement('span');
          message.textContent = t('app.session_expires', { minutes: minutesLeft }) + ' ';
          const relogin = document.createElement('button');
          relogin.type = 'button';
          relogin.textContent = t('app.relogin');
          relogin.style.cssText = 'color:var(--accent);text-decoration:underline;background:none;border:0;padding:0;cursor:pointer;font:inherit';
          relogin.addEventListener('click', () => {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            window.location.hash = '#/login';
          });
          message.appendChild(relogin);
          warn.appendChild(message);
          toast.appendChild(warn);
          setTimeout(() => warn.remove(), 10000);
        }
      }
    } catch {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.hash = '#/login';
      window.location.reload();
    }
  }, 60000);
}
window.addEventListener('hashchange', route);
route();

// Close-modal buttons (replaces inline onclick handlers — required for CSP).
document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close-modal]');
  if (!closer) return;
  const id = closer.dataset.closeModal;
  const modal = document.getElementById(id);
  if (modal) modal.style.display = 'none';
});
