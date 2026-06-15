import { contextBridge, ipcRenderer } from 'electron';

type AdminAction = 'refresh-console' | 'restart-app' | 'reconnect' | 'exit-kiosk' | 'device-info' | 'reboot-device' | 'disable-kiosk';

function injectAdminStyles() {
  if (document.getElementById('mbfd-admin-style')) return;
  const style = document.createElement('style');
  style.id = 'mbfd-admin-style';
  style.textContent = `
    .mbfd-admin-overlay{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(2,6,23,.72);backdrop-filter:blur(10px);font-family:Segoe UI,system-ui,sans-serif;color:#f8fafc}
    .mbfd-admin-panel{width:min(640px,92vw);border-radius:28px;background:#07111f;border:1px solid rgba(148,163,184,.28);box-shadow:0 28px 90px rgba(0,0,0,.48);padding:28px}
    .mbfd-admin-panel h2{margin:0 0 8px;font-size:28px;letter-spacing:-.03em}.mbfd-admin-panel p{margin:0 0 18px;color:#cbd5e1;line-height:1.45}
    .mbfd-admin-panel input{width:100%;min-height:58px;border-radius:16px;border:1px solid #334155;background:#0f172a;color:#f8fafc;font-size:24px;padding:0 16px;margin:8px 0 16px}
    .mbfd-admin-actions{display:grid;grid-template-columns:1fr 1fr;gap:12px}.mbfd-admin-panel button{min-height:54px;border:0;border-radius:16px;background:#1d4ed8;color:white;font-size:16px;font-weight:800;cursor:pointer}.mbfd-admin-panel button.secondary{background:#334155}.mbfd-admin-panel button.danger{background:#b91c1c}.mbfd-admin-output{white-space:pre-wrap;background:#020617;border-radius:16px;padding:14px;margin-top:16px;max-height:220px;overflow:auto;color:#bfdbfe}
  `;
  document.head.appendChild(style);
}

function showAdminOverlay() {
  injectAdminStyles();
  document.getElementById('mbfd-admin-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'mbfd-admin-overlay';
  overlay.className = 'mbfd-admin-overlay';
  overlay.innerHTML = `
    <form class="mbfd-admin-panel" id="mbfd-admin-form">
      <h2>Service Access</h2>
      <p>Enter the admin PIN for kiosk maintenance actions.</p>
      <input id="mbfd-admin-pin" type="password" inputmode="numeric" autocomplete="off" placeholder="Admin PIN" />
      <div class="mbfd-admin-actions">
        <button type="submit">Unlock</button>
        <button class="secondary" type="button" data-close>Cancel</button>
      </div>
      <div class="mbfd-admin-output" id="mbfd-admin-output" hidden></div>
    </form>
  `;
  document.body.appendChild(overlay);
  const form = overlay.querySelector<HTMLFormElement>('#mbfd-admin-form');
  const output = overlay.querySelector<HTMLDivElement>('#mbfd-admin-output');
  overlay.querySelector('[data-close]')?.addEventListener('click', () => overlay.remove());
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const pin = (overlay.querySelector<HTMLInputElement>('#mbfd-admin-pin')?.value || '').trim();
    const result = await ipcRenderer.invoke('admin:unlock', pin);
    if (!result?.ok) {
      if (output) { output.hidden = false; output.textContent = 'Invalid PIN'; }
      return;
    }
    renderAdminActions(overlay, output);
  });
  setTimeout(() => overlay.querySelector<HTMLInputElement>('#mbfd-admin-pin')?.focus(), 50);
}

function renderAdminActions(overlay: HTMLElement, output: HTMLDivElement | null) {
  const panel = overlay.querySelector('.mbfd-admin-panel');
  if (!panel) return;
  panel.innerHTML = `
    <h2>Console Maintenance</h2>
    <p>Use these actions only for troubleshooting or recovery.</p>
    <div class="mbfd-admin-actions">
      <button type="button" data-action="refresh-console">Refresh Console</button>
      <button type="button" data-action="reconnect">Reconnect</button>
      <button type="button" data-action="restart-app">Restart App</button>
      <button type="button" data-action="device-info">Device Info</button>
      <button type="button" data-action="exit-kiosk">Exit Kiosk</button>
      <button class="danger" type="button" data-action="reboot-device">Reboot Device</button>
      <button class="danger" type="button" data-action="disable-kiosk">Disable Kiosk</button>
      <button class="secondary" type="button" data-close>Close</button>
    </div>
    <div class="mbfd-admin-output" id="mbfd-admin-output" hidden></div>
  `;
  const nextOutput = panel.querySelector<HTMLDivElement>('#mbfd-admin-output') || output;
  panel.querySelector('[data-close]')?.addEventListener('click', () => overlay.remove());
  panel.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.action as AdminAction;
      const result = await ipcRenderer.invoke('admin:action', action);
      if (nextOutput) {
        nextOutput.hidden = false;
        nextOutput.textContent = JSON.stringify(result, null, 2);
      }
    });
  });
}

function attachLogoLongPress() {
  let timer: number | null = null;
  const start = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest('[data-console-logo]')) return;
    timer = window.setTimeout(showAdminOverlay, 5000);
  };
  const cancel = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  document.addEventListener('pointerdown', start, true);
  document.addEventListener('pointerup', cancel, true);
  document.addEventListener('pointercancel', cancel, true);
  document.addEventListener('pointerleave', cancel, true);
}

contextBridge.exposeInMainWorld('mbfdConsoleShell', {
  onStatus(callback: (status: string) => void) {
    const listener = (_event: unknown, status: string) => callback(status);
    ipcRenderer.on('console:status', listener);
    return () => ipcRenderer.removeListener('console:status', listener);
  },
  refreshContent() {
    return ipcRenderer.invoke('console:refresh-content');
  },
});

window.addEventListener('DOMContentLoaded', attachLogoLongPress);
