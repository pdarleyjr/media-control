// prepare-live-production.js — operator production setup modal

import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { api } from '../../api.js';
import { showToast } from '../../components/toast.js';

/**
 * Open Prepare Live Production and return confirmed plan or null.
 * @returns {Promise<object|null>}
 */
export async function openPrepareLiveProductionModal() {
  let status = null;
  try {
    status = await api.liveStream.status();
  } catch {
    showToast('Could not load director status', 'error');
    return null;
  }
  const data = status?.ai_director?.data || status?.ai_director || {};
  const cams = [
    { id: 1, name: 'Camera 1 — Focus 210/PTZ', online: !!data.kamrui_camera_1_stream },
    { id: 2, name: 'Camera 2', online: !!data.kamrui_camera_2_stream },
    { id: 3, name: 'Camera 3 — ANNKE', online: !!data.annke_camera_3_stream },
  ];
  const healthyCount = cams.filter((c) => c.online).length;
  const aiOk = healthyCount >= 2;

  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'mc-prepare-prod-dialog';
    dlg.innerHTML = `
      <form method="dialog" class="mc-prepare-prod">
        <header><h2>Prepare Live Production</h2>
          <p class="mc-prepare-sub">Choose production mode, audio, and recording before going on air.</p>
        </header>
        <fieldset>
          <legend>Production mode</legend>
          <label class="mc-prep-opt"><input type="radio" name="pmode" value="fixed_camera" checked /> Fixed Camera</label>
          <label class="mc-prep-opt${aiOk ? '' : ' is-disabled'}"><input type="radio" name="pmode" value="ai_director" ${aiOk ? '' : 'disabled'} /> AI Camera Director ${aiOk ? '' : '(needs 2+ healthy cameras)'}</label>
          <label class="mc-prep-opt"><input type="radio" name="pmode" value="manual_multicamera" /> Manual Multi-Camera</label>
        </fieldset>
        <fieldset data-fixed-cams>
          <legend>Camera (Fixed mode)</legend>
          ${cams.map((c) => `
            <label class="mc-prep-opt${c.online ? '' : ' is-disabled'}">
              <input type="radio" name="camera" value="${c.id}" ${c.id === 1 && c.online ? 'checked' : ''} ${c.online ? '' : 'disabled'} />
              ${esc(c.name)} — ${c.online ? 'healthy' : 'offline'}
            </label>`).join('')}
        </fieldset>
        <fieldset>
          <legend>Audio</legend>
          <label class="mc-prep-opt"><input type="radio" name="audio" value="speech" checked /> SPEECH (room mic)</label>
          <label class="mc-prep-opt"><input type="radio" name="audio" value="content_audio" /> CONTENT_AUDIO</label>
          <label class="mc-prep-opt"><input type="radio" name="audio" value="screen_share_audio" /> SCREEN_SHARE_AUDIO</label>
        </fieldset>
        <fieldset>
          <legend>Recording</legend>
          <label class="mc-prep-opt"><input type="checkbox" name="record" /> Record this production locally</label>
        </fieldset>
        <div class="mc-prep-summary" data-summary role="status"></div>
        <footer class="mc-prep-actions">
          <button type="button" data-cancel class="mc-btn-ghost">Cancel</button>
          <button type="submit" data-confirm class="mc-btn-primary">Confirm plan</button>
        </footer>
      </form>`;
    document.body.appendChild(dlg);

    const summary = dlg.querySelector('[data-summary]');
    const form = dlg.querySelector('form');

    function paintSummary() {
      const fd = new FormData(form);
      const mode = fd.get('pmode');
      const cam = fd.get('camera');
      const audio = fd.get('audio');
      const rec = form.querySelector('[name="record"]').checked;
      summary.innerHTML = `
        <strong>Summary</strong>
        <div>Mode: ${esc(String(mode))}</div>
        <div>Director: ${mode === 'ai_director' ? 'auto (AI Camera Director)' : 'manual'}</div>
        <div>Camera: ${mode === 'fixed_camera' ? esc(String(cam || '—')) : (mode === 'ai_director' ? 'AI-selected' : 'operator cuts')}</div>
        <div>Audio: ${esc(String(audio))}</div>
        <div>Recording: ${rec ? 'yes' : 'no'}</div>
        <div>PeerTube: unlisted/private</div>
        <div>OBS scene: ${mode === 'fixed_camera' && cam ? `KAMRUI_CAMERA_${esc(String(cam))}_FULL` : 'per mode'}</div>`;
    }
    form.addEventListener('change', paintSummary);
    paintSummary();

    dlg.querySelector('[data-cancel]').addEventListener('click', () => {
      dlg.close();
      dlg.remove();
      resolve(null);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const body = {
        production_mode: String(fd.get('pmode')),
        camera_id: Number(fd.get('camera')) || null,
        audio_mode: String(fd.get('audio') || 'speech'),
        recording_requested: !!form.querySelector('[name="record"]').checked,
        confirm_auto_canary: String(fd.get('pmode')) === 'ai_director',
        initiator: 'operator',
      };
      const btn = form.querySelector('[data-confirm]');
      btn.disabled = true;
      try {
        const res = await api.liveStream.productionPlan(body);
        showToast(t('mc.cc.live.prepared') || 'Production plan confirmed', 'success');
        dlg.close();
        dlg.remove();
        resolve(res.production_plan || res);
      } catch (err) {
        showToast(err?.message || 'Could not save production plan', 'error');
        btn.disabled = false;
      }
    });

    dlg.addEventListener('cancel', () => {
      dlg.remove();
      resolve(null);
    });
    dlg.showModal();
  });
}
