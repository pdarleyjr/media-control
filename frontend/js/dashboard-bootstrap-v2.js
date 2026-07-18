(function bootstrapDashboard() {
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

  import('/js/app.js?v=dashboard-bootstrap-v2').catch(showFailure);
}());
