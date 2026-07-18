(function bootstrapDashboard() {
  const appRoot = document.getElementById('app');
  const showFailure = (error) => {
    const message = error && error.message ? error.message : String(error || 'Unknown startup error');
    console.error('[dashboard-bootstrap] startup failed', error);
    if (!appRoot || appRoot.childElementCount > 0) return;
    appRoot.innerHTML = `
      <main style="max-width:760px;margin:12vh auto;padding:32px;font:16px/1.5 sans-serif">
        <h1 style="margin:0 0 12px">Media Control could not start</h1>
        <p style="margin:0 0 16px">The server is reachable, but a dashboard module failed to load.</p>
        <pre style="white-space:pre-wrap;background:#f2f2ef;padding:12px;border-radius:8px">${message.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]))}</pre>
        <button type="button" onclick="location.reload()" style="margin-top:16px;padding:10px 18px">Retry</button>
      </main>`;
  };

  window.addEventListener('error', (event) => showFailure(event.error || event.message), { once: true });
  window.addEventListener('unhandledrejection', (event) => showFailure(event.reason), { once: true });

  import('/js/app.js?v=dashboard-bootstrap-v1').catch(showFailure);
  setTimeout(() => {
    if (appRoot && appRoot.childElementCount === 0) {
      showFailure(new Error('Dashboard startup timed out. Check that JavaScript modules are allowed for this site.'));
    }
  }, 12000);
})();
