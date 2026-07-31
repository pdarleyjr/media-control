import { api as defaultApi } from '../../api.js';
import { showToast } from '../toast.js';
import { esc } from '../../utils.js';

function isRetired(device) {
  return device?.retired === true || Number(device?.retired) === 1 || device?.status === 'retired';
}

export function mountTopologyManager(host, { api = defaultApi } = {}) {
  if (!host) return () => {};
  let devices = [];
  let walls = [];
  let destroyed = false;
  let showPair = false;
  let showWallBuilder = false;

  const protectedMemberIds = () => new Set(
    walls.filter((wall) => wall.is_locked).flatMap((wall) => (wall.devices || []).map((member) => String(member.device_id))),
  );

  function availableDevices() {
    const protectedIds = protectedMemberIds();
    return devices.filter((device) => (
      !isRetired(device)
      && !device.wall_id
      && !protectedIds.has(String(device.id))
    ));
  }

  function wallForDevice(device) {
    return walls.find((wall) => String(wall.id) === String(device.wall_id)) || null;
  }

  function deviceRow(device) {
    const wall = wallForDevice(device);
    const protectedDevice = Boolean(wall?.is_locked) || protectedMemberIds().has(String(device.id));
    const retired = isRetired(device);
    const status = retired ? 'Retired' : (device.status || 'offline');
    return `<article class="mc-e-topology-row" data-device-id="${esc(device.id)}">
      <div class="mc-e-topology-identity">
        <strong>${esc(device.name || 'Unnamed display')}</strong>
        <span>${esc(status)}${wall ? ` · ${esc(wall.name)}` : ' · Available'}</span>
      </div>
      <div class="mc-e-topology-actions">
        ${protectedDevice
          ? '<span class="mc-e-protected-chip">Protected wall member</span>'
          : retired
            ? `<button type="button" data-tm-restore="${esc(device.id)}">Restore</button>
               <button type="button" class="mc-e-danger" data-tm-remove="${esc(device.id)}">Permanently remove</button>`
            : `<button type="button" data-tm-retire="${esc(device.id)}">Retire</button>`}
      </div>
    </article>`;
  }

  function wallRow(wall) {
    const members = wall.devices || [];
    if (wall.is_locked) {
      return `<article class="mc-e-wall-row is-protected" data-protected-wall="${esc(wall.id)}">
        <div>
          <strong>${esc(wall.name)}</strong>
          <span>${members.length} display${members.length === 1 ? '' : 's'} · Protected Classroom Video Wall</span>
        </div>
        <span class="mc-e-protected-chip">Protected</span>
      </article>`;
    }
    return `<article class="mc-e-wall-row">
      <div>
        <strong>${esc(wall.name)}</strong>
        <span>${members.length} display${members.length === 1 ? '' : 's'} · Custom wall</span>
      </div>
      <div class="mc-e-topology-actions">
        <button type="button" data-tm-edit-wall="${esc(wall.id)}">Edit</button>
        <button type="button" class="mc-e-danger" data-tm-delete-wall="${esc(wall.id)}">Delete</button>
      </div>
    </article>`;
  }

  function render() {
    if (destroyed) return;
    const available = availableDevices();
    const activeCount = devices.filter((device) => !isRetired(device)).length;
    host.innerHTML = `<section class="mc-e-topology" data-topology-manager>
      <div class="mc-e-topology-head">
        <div>
          <h2>Displays &amp; video walls</h2>
          <p>${activeCount} active display${activeCount === 1 ? '' : 's'} · ${walls.length} wall${walls.length === 1 ? '' : 's'}</p>
        </div>
        <div class="mc-e-topology-actions">
          <button type="button" class="mc-e-primary" data-tm-toggle-pair>Pair display</button>
          <button type="button" data-tm-toggle-wall>Create custom wall</button>
        </div>
      </div>

      ${showPair ? `<form class="mc-e-topology-form" data-tm-pair-form>
        <div><label for="tmPairCode">Six-digit pairing code</label><input id="tmPairCode" name="pairing_code" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" required></div>
        <div><label for="tmPairName">Display name</label><input id="tmPairName" name="name" maxlength="80" placeholder="Classroom display"></div>
        <button type="submit" class="mc-e-primary">Add display</button>
        <button type="button" data-tm-toggle-pair>Cancel</button>
      </form>` : ''}

      ${showWallBuilder ? `<form class="mc-e-topology-form mc-e-wall-builder" data-tm-wall-form>
        <div class="mc-e-wall-name"><label for="tmWallName">Custom wall name</label><input id="tmWallName" name="name" maxlength="80" required placeholder="Training room wall"></div>
        <fieldset>
          <legend>Combine available displays</legend>
          ${available.length
            ? available.map((device) => `<label class="mc-e-device-choice"><input type="checkbox" name="device_id" value="${esc(device.id)}"><span>${esc(device.name)}</span></label>`).join('')
            : '<p>No unassigned active displays are available. Pair or ungroup a display first.</p>'}
        </fieldset>
        <button type="submit" class="mc-e-primary" ${available.length < 2 ? 'disabled' : ''}>Create wall</button>
        <button type="button" data-tm-toggle-wall>Cancel</button>
      </form>` : ''}

      <div class="mc-e-topology-columns">
        <section aria-labelledby="tmDisplaysTitle">
          <h3 id="tmDisplaysTitle">Display inventory</h3>
          <div class="mc-e-topology-list">${devices.length ? devices.map(deviceRow).join('') : '<p class="mc-e-topology-empty">No displays are enrolled.</p>'}</div>
        </section>
        <section aria-labelledby="tmWallsTitle">
          <h3 id="tmWallsTitle">Video walls</h3>
          <div class="mc-e-topology-list">${walls.length ? walls.map(wallRow).join('') : '<p class="mc-e-topology-empty">No video walls are configured.</p>'}</div>
        </section>
      </div>
    </section>`;
  }

  async function refresh() {
    try {
      [devices, walls] = await Promise.all([api.getDevices(), api.getWalls()]);
      devices = Array.isArray(devices) ? devices : [];
      walls = Array.isArray(walls) ? walls : [];
      render();
    } catch (error) {
      if (!destroyed) {
        host.innerHTML = '<div class="mc-e-error" role="alert">Display and wall inventory could not be loaded.</div>';
        showToast(error.message || 'Could not load Operator Control.', 'error');
      }
    }
  }

  async function pairDisplay(form) {
    const data = new FormData(form);
    const pairingCode = String(data.get('pairing_code') || '').trim();
    const name = String(data.get('name') || '').trim();
    if (!/^\d{6}$/.test(pairingCode)) {
      showToast('Enter the six-digit pairing code shown on the display.', 'error');
      return;
    }
    await api.pairDevice(pairingCode, name || undefined);
    showPair = false;
    showToast('Display added.', 'success');
    await refresh();
  }

  async function createWall(form) {
    const data = new FormData(form);
    const name = String(data.get('name') || '').trim();
    const selectedIds = data.getAll('device_id').map(String);
    const allowed = new Set(availableDevices().map((device) => String(device.id)));
    if (!name || selectedIds.length < 2 || selectedIds.some((id) => !allowed.has(id))) {
      showToast('Name the wall and choose at least two available displays.', 'error');
      return;
    }
    let created = null;
    try {
      created = await api.createWall({ name, grid_cols: selectedIds.length, grid_rows: 1 });
      const positions = selectedIds.map((deviceId, index) => ({
        device_id: deviceId,
        grid_col: index,
        grid_row: 0,
        rotation: 0,
        canvas_x: index * 1920,
        canvas_y: 0,
        canvas_width: 1920,
        canvas_height: 1080,
      }));
      await api.setWallDevices(created.id, positions, Number(created.layout_revision) || 0);
      showWallBuilder = false;
      showToast(`Custom wall "${name}" created.`, 'success');
      await refresh();
    } catch (error) {
      if (created?.id) {
        try { await api.deleteWall(created.id); } catch { /* leave recoverable empty wall visible for manual cleanup */ }
      }
      throw error;
    }
  }

  async function onClick(event) {
    const togglePair = event.target.closest('[data-tm-toggle-pair]');
    if (togglePair) { showPair = !showPair; render(); return; }
    const toggleWall = event.target.closest('[data-tm-toggle-wall]');
    if (toggleWall) { showWallBuilder = !showWallBuilder; render(); return; }

    const editWall = event.target.closest('[data-tm-edit-wall]');
    if (editWall) { window.location.hash = `#/wall/${encodeURIComponent(editWall.dataset.tmEditWall)}`; return; }

    const retire = event.target.closest('[data-tm-retire]');
    const restore = event.target.closest('[data-tm-restore]');
    const remove = event.target.closest('[data-tm-remove]');
    const deleteWall = event.target.closest('[data-tm-delete-wall]');
    try {
      if (retire) {
        await api.retireDevice(retire.dataset.tmRetire);
        showToast('Display retired.', 'success');
        await refresh();
      } else if (restore) {
        await api.restoreDevice(restore.dataset.tmRestore);
        showToast('Display restored.', 'success');
        await refresh();
      } else if (remove) {
        const impact = await api.getDeviceDeletionImpact(remove.dataset.tmRemove);
        const typed = globalThis.prompt?.(`Type REMOVE to permanently delete ${impact.device_name || 'this display'}. This cannot be undone.`);
        if (typed !== 'REMOVE') return;
        await api.deleteDevice(remove.dataset.tmRemove, impact.etag);
        showToast('Display permanently removed.', 'success');
        await refresh();
      } else if (deleteWall) {
        const wall = walls.find((candidate) => String(candidate.id) === String(deleteWall.dataset.tmDeleteWall));
        if (!wall || wall.is_locked) throw Object.assign(new Error('Protected Classroom Video Walls cannot be deleted.'), { code: 'PROTECTED_WALL' });
        const typed = globalThis.prompt?.(`Type DELETE to remove custom wall "${wall.name}". Displays will return to the available pool.`);
        if (typed !== 'DELETE') return;
        await api.deleteWall(wall.id);
        showToast('Custom wall deleted.', 'success');
        await refresh();
      }
    } catch (error) {
      if (error?.code === 'PROTECTED_WALL_DEVICE' || error?.code === 'PROTECTED_WALL') {
        showToast(error.message || 'This protected classroom asset cannot be changed.', 'error');
      } else {
        showToast(error.message || 'Operator Control action failed.', 'error');
      }
    }
  }

  async function onSubmit(event) {
    const pairForm = event.target.closest('[data-tm-pair-form]');
    const wallForm = event.target.closest('[data-tm-wall-form]');
    if (!pairForm && !wallForm) return;
    event.preventDefault();
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    try {
      if (pairForm) await pairDisplay(pairForm);
      else await createWall(wallForm);
    } catch (error) {
      showToast(error.message || 'Operator Control action failed.', 'error');
    } finally {
      if (submit?.isConnected) submit.disabled = false;
    }
  }

  host.addEventListener('click', onClick);
  host.addEventListener('submit', onSubmit);
  void refresh();

  return () => {
    destroyed = true;
    host.removeEventListener('click', onClick);
    host.removeEventListener('submit', onSubmit);
    host.innerHTML = '';
  };
}

export default mountTopologyManager;
