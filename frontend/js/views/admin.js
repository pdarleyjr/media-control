import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc, isPlatformAdmin } from '../utils.js';
import { t } from '../i18n.js';

const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' });
const API = (url, opts = {}) => fetch('/api' + url, { headers: headers(), ...opts }).then(r => r.json());

export async function render(container) {
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  if (!isPlatformAdmin(user)) {
    container.innerHTML = `<div class="empty-state"><h3>${t('admin.access_denied')}</h3><p>${t('admin.access_denied_desc')}</p></div>`;
    return;
  }

  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('admin.title')}</h1><div class="subtitle">${t('admin.subtitle')}</div></div>
    </div>

    <div class="settings-section">
      <h3>${t('admin.all_users')}</h3>
      <div id="allUsersTable"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <div class="settings-section">
      <h3>${t('admin.system')}</h3>
      <div id="systemInfo"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <div class="settings-section">
      <h3>Classroom Network Diagnostics</h3>
      <div id="networkDiagnostics"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>
  `;

  loadUsers();
  loadSystem();

}

async function loadUsers() {
  const el = document.getElementById('allUsersTable');
  try {
    const users = await API('/auth/users');
    const currentUser = JSON.parse(localStorage.getItem('user') || '{}');

    el.innerHTML = `
      <div class="table-wrap">
      <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:720px">
        <thead><tr style="border-bottom:1px solid var(--border)">
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.user')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.auth')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.last_login')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.role')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.actions')}</th>
        </tr></thead>
        <tbody>
          ${users.map(u => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:8px"><div style="font-weight:500">${u.name || u.email}</div><div style="font-size:11px;color:var(--text-muted)">${u.email}</div></td>
              <td style="padding:8px"><span style="background:var(--bg-primary);padding:2px 8px;border-radius:10px;font-size:11px">${u.auth_provider}</span></td>
              <td style="padding:8px;font-size:11px;color:var(--text-muted)">${u.last_login ? new Date(u.last_login * 1000).toLocaleString() : t('common.never')}</td>
              <td style="padding:8px">
                <select class="input" style="max-width:120px;width:100%;background:var(--bg-input);font-size:12px;padding:4px" data-role-user="${u.id}">
                  <option value="user" ${u.role === 'user' ? 'selected' : ''}>${t('admin.role.user')}</option>
                  <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>${t('admin.role.admin')}</option>
                  <option value="superadmin" ${u.role === 'superadmin' ? 'selected' : ''}>${t('admin.role.superadmin')}</option>
                </select>
              </td>
              <td style="padding:8px;white-space:nowrap">
                ${u.auth_provider === 'local' && u.id !== currentUser.id ? `<button class="btn btn-secondary btn-sm" data-reset-pw-user="${u.id}" data-user-email="${u.email}" style="margin-right:4px">${t('admin.reset_password')}</button>` : ''}
                ${u.role !== 'superadmin' ? `<button class="btn btn-danger btn-sm" data-delete-user="${u.id}">${t('admin.remove')}</button>` : `<span style="color:var(--text-muted);font-size:11px">${t('admin.owner')}</span>`}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
      <p style="color:var(--text-muted);font-size:11px;margin-top:8px">${t('admin.total_users', { n: users.length })}</p>
    `;

    el.querySelectorAll('[data-role-user]').forEach(select => {
      select.onchange = async () => {
        try {
          await API(`/auth/users/${select.dataset.roleUser}/role`, { method: 'PUT', body: JSON.stringify({ role: select.value }) });
          showToast(t('admin.toast.role_updated'), 'success');
        } catch (err) { showToast(err.message, 'error'); loadUsers(); }
      };
    });

    // Reset password handlers
    el.querySelectorAll('[data-reset-pw-user]').forEach(btn => {
      btn.onclick = async () => {
        const email = btn.dataset.userEmail;
        const pw = prompt(t('admin.prompt_reset_password', { email }));
        if (pw === null) return;
        if (pw.length < 8) { showToast(t('admin.toast.password_min_8'), 'error'); return; }
        try {
          await api.resetUserPassword(btn.dataset.resetPwUser, pw);
          showToast(t('admin.toast.password_reset'), 'success');
        } catch (err) { showToast(err.message, 'error'); }
      };
    });

    el.querySelectorAll('[data-delete-user]').forEach(btn => {
      let confirming = false;
      btn.onclick = async () => {
        if (confirming) {
          try { await api.deleteUser(btn.dataset.deleteUser); showToast(t('admin.toast.user_removed'), 'success'); loadUsers(); }
          catch (err) { showToast(err.message, 'error'); }
          return;
        }
        confirming = true; btn.textContent = t('admin.confirm'); btn.style.background = 'var(--danger)'; btn.style.color = 'white';
        setTimeout(() => { confirming = false; btn.textContent = t('admin.remove'); btn.style.background = ''; btn.style.color = ''; }, 3000);
      };
    });
  } catch (err) { el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`; }
}

async function loadSystem() {
  const el = document.getElementById('systemInfo');
  const diagnostics = document.getElementById('networkDiagnostics');
  try {
    const token = localStorage.getItem('token');
    const [version, nodeStatus] = await Promise.all([
      fetch('/api/system/version').then(r => r.json()),
      fetch(`/api/status/nodes?token=${encodeURIComponent(token || '')}`).then(r => r.json()),
    ]);
    el.innerHTML = `
      <div class="info-grid">
        <div class="info-card"><div class="info-card-label">Server commit</div><div class="info-card-value small">${esc(version.git_commit || 'Unknown')}</div></div>
        <div class="info-card"><div class="info-card-label">Frontend bundle</div><div class="info-card-value small">${esc(version.frontend_bundle_hash || 'Unknown')}</div></div>
        <div class="info-card"><div class="info-card-label">Player bundle</div><div class="info-card-value small">${esc(version.player_bundle_hash || 'Unknown')}</div></div>
        <div class="info-card"><div class="info-card-label">Build timestamp</div><div class="info-card-value small">${esc(version.build_timestamp || 'Unknown')}</div></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <a href="/api/status/backup?token=${token}" class="btn btn-secondary btn-sm" style="text-decoration:none">${t('admin.download_db_backup')}</a>
        <a href="/api/status" target="_blank" class="btn btn-secondary btn-sm" style="text-decoration:none">${t('admin.server_status')}</a>
        <a href="/api/status/nodes?token=${token}" target="_blank" class="btn btn-secondary btn-sm" style="text-decoration:none">Node status</a>
      </div>
    `;

    const node = (nodeStatus.nodes || []).find(item => item.node_id === 'classroom-1-p3') || (nodeStatus.nodes || [])[0];
    if (!node) {
      diagnostics.innerHTML = '<p style="color:var(--danger)">No classroom node heartbeat is available.</p>';
      return;
    }
    const network = node.network_state || {};
    const telemetry = node.telemetry || {};
    const cache = telemetry.cache || {};
    const lanTest = telemetry.lan_health_test || null;
    const heartbeatAge = Math.max(0, Math.floor(Date.now() / 1000 - Number(node.last_heartbeat || 0)));
    const linkColor = network.link_status === 'healthy' ? 'var(--success)'
      : network.link_status === 'warning' ? 'var(--warning)' : 'var(--danger)';
    const buildMismatch = telemetry.player_version
      && telemetry.player_version !== version.player_bundle_hash;
    diagnostics.innerHTML = `
      <div class="info-grid">
        <div class="info-card"><div class="info-card-label">P3 adapter</div><div class="info-card-value small">${esc(network.adapter_name || 'Unknown')}</div><div style="font-size:11px;color:var(--text-muted)">${esc(network.adapter_description || '')}</div></div>
        <div class="info-card"><div class="info-card-label">Negotiated link</div><div class="info-card-value small" style="color:${linkColor}">${esc(network.link_speed_display || 'Unknown')} ${esc(network.duplex || '')}</div><div style="font-size:11px;color:var(--text-muted)">${esc(network.link_status || 'unknown')}</div></div>
        <div class="info-card"><div class="info-card-label">Server origin</div><div class="info-card-value small">${esc(network.server_url_category || network.selected_server_url_category || 'Unknown')}</div><div style="font-size:11px;color:var(--text-muted)">${esc(network.reachability || 'unknown')}</div></div>
        <div class="info-card"><div class="info-card-label">Interface health</div><div class="info-card-value small">${Number(network.interface_errors || 0)} errors</div><div style="font-size:11px;color:var(--text-muted)">${Number(network.interface_discards || 0)} discards</div></div>
        <div class="info-card"><div class="info-card-label">Agent heartbeat</div><div class="info-card-value small">${heartbeatAge}s ago</div><div style="font-size:11px;color:var(--text-muted)">Agent ${esc(node.software_version || 'Unknown')}</div></div>
        <div class="info-card"><div class="info-card-label">Runtime uptime</div><div class="info-card-value small">Agent ${Math.floor(Number(telemetry.agent_uptime_sec || 0) / 60)}m</div><div style="font-size:11px;color:var(--text-muted)">Kiosk ${telemetry.kiosk_uptime_sec == null ? 'Unknown' : `${Math.floor(Number(telemetry.kiosk_uptime_sec) / 60)}m`}</div></div>
        <div class="info-card"><div class="info-card-label">Local cache</div><div class="info-card-value small">${esc(cache.sync_status || node.sync_status || 'Unknown')}</div><div style="font-size:11px;color:var(--text-muted)">${Number(cache.cache_hits || 0)} hits / ${Number(cache.cache_misses || 0)} misses</div></div>
        <div class="info-card"><div class="info-card-label">Cache transfer</div><div class="info-card-value small">${cache.current_transfer ? `${Number(cache.current_transfer.rolling_average_mbps || 0).toFixed(1)} Mbps` : 'Idle'}</div><div style="font-size:11px;color:var(--text-muted)">${Number(cache.fill_failures || 0)} failures / ${Number(cache.timeout_count || 0)} timeouts</div></div>
        <div class="info-card"><div class="info-card-label">Last LAN test</div><div class="info-card-value small">${lanTest?.ok ? `${Number(lanTest.mbps || 0).toFixed(1)} Mbps` : 'Not run'}</div><div style="font-size:11px;color:var(--text-muted)">${lanTest?.ok ? `${Number(lanTest.ttfb_ms || 0)} ms TTFB / ${esc(lanTest.status || 'unknown')}` : esc(lanTest?.error || 'Admin-triggered only')}</div></div>
        <div class="info-card"><div class="info-card-label">Runtime builds</div><div class="info-card-value small">Kiosk ${esc(telemetry.kiosk_version || 'Unknown')}</div><div style="font-size:11px;color:var(--text-muted)">Player ${esc(telemetry.player_version || version.player_bundle_hash || 'Unknown')}</div></div>
        <div class="info-card"><div class="info-card-label">Compatibility</div><div class="info-card-value small">Config schema ${esc(telemetry.configuration_schema_version ?? 'Unknown')}</div><div style="font-size:11px;color:var(--text-muted)">DB ${esc(version.database_schema?.latest || 'Unknown')} (${Number(version.database_schema?.count || 0)})</div></div>
      </div>
      ${network.degraded ? `<p style="color:var(--danger);margin-top:12px">Degraded: ${esc(network.degraded_reason || 'network issue')}</p>` : ''}
      ${buildMismatch ? '<p style="color:var(--danger);margin-top:12px">Build mismatch: the P3 player identity does not match the server player bundle.</p>' : ''}
      <div style="display:flex;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap">
        <button id="runLanHealthTest" class="btn btn-secondary btn-sm">Run LAN test when idle</button>
        <span id="lanHealthTestStatus" style="font-size:12px;color:var(--text-muted)">Runs one secured 64 MB transfer; five-minute cooldown.</span>
      </div>
    `;
    document.getElementById('runLanHealthTest')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const status = document.getElementById('lanHealthTestStatus');
      button.disabled = true;
      status.textContent = 'Testing the direct LAN path...';
      try {
        const response = await fetch(`/api/status/nodes/${encodeURIComponent(node.node_id)}/lan-health-test`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'LAN test failed');
        status.textContent = `${Number(body.result.mbps || 0).toFixed(1)} Mbps, ${body.result.status || 'unknown'}, ${Number(body.result.ttfb_ms || 0)} ms TTFB`;
      } catch (error) {
        status.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  } catch (err) {
    el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`;
    if (diagnostics) diagnostics.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`;
  }
}

export function cleanup() {}
