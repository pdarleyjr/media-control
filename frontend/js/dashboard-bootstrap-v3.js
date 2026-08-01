(function bootstrapDashboard() {
  var script = document.currentScript;
  var version = '';
  try {
    version = new URL(script && script.src ? script.src : '', window.location.href).searchParams.get('v') || '';
  } catch { /* resolved below */ }

  function showFailure(error) {
    console.error('[dashboard-bootstrap] startup failed', error);
    var main = document.getElementById('mainContent');
    if (!main) return;
    var message = error && error.message ? error.message : 'The application could not load its current assets.';
    main.innerHTML = '<section class="error-state" style="margin:32px;max-width:720px">'
      + '<h2>Media Control could not start</h2>'
      + '<p>' + String(message).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }) + '</p>'
      + '<button type="button" class="btn btn-primary" id="dashboardRetry">Retry</button>'
      + '</section>';
    var retry = document.getElementById('dashboardRetry');
    if (retry) retry.addEventListener('click', function () { window.location.reload(); });
  }

  async function resolveVersion() {
    if (version && version !== '__MC_FRONTEND_HASH__') return version;
    var response = await fetch('/api/version', { cache: 'no-store' });
    if (!response.ok) throw new Error('The current Media Control version is unavailable.');
    var body = await response.json();
    return String(body.frontend_bundle_hash || body.hash || '').trim();
  }

  async function recoverStaleRelease(nextVersion) {
    window.__MC_FRONTEND_HASH__ = nextVersion;
    var epochKey = 'mc_admin_asset_epoch_v1';
    var previous = null;
    try { previous = localStorage.getItem(epochKey); } catch { /* storage unavailable */ }
    if (previous === nextVersion) return;

    // Delete only Media Control's dashboard caches. Login, preferences, media,
    // classroom players, and unrelated origin storage remain untouched.
    if ('caches' in window) {
      try {
        var keys = await caches.keys();
        await Promise.all(keys.filter(function (key) {
          return /^rd-admin-/.test(key);
        }).map(function (key) {
          return caches.delete(key);
        }));
      } catch { /* network import below remains authoritative */ }
    }

    // Ask an existing admin worker to revalidate immediately. app.js registers
    // the release-hashed worker URL after startup, which completes the update.
    if ('serviceWorker' in navigator) {
      try {
        var registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.allSettled(registrations
          .filter(function (registration) {
            var url = registration.active?.scriptURL
              || registration.waiting?.scriptURL
              || registration.installing?.scriptURL
              || '';
            return url.includes('/sw-admin.js');
          })
          .map(function (registration) { return registration.update(); }));
      } catch { /* service worker recovery is best-effort */ }
    }

    try { localStorage.setItem(epochKey, nextVersion); } catch { /* storage unavailable */ }
  }

  resolveVersion()
    .then(async function (nextVersion) {
      if (!nextVersion) throw new Error('The current Media Control version is empty.');
      version = nextVersion;
      await recoverStaleRelease(nextVersion);
      return import('/js/app.js?v=' + encodeURIComponent(version));
    })
    .catch(showFailure);
}());
