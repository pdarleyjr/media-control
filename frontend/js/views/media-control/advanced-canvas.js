import { api } from '../../api.js';
import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { showToast } from '../../components/toast.js';
import { confirmDialog } from '../../components/confirm.js';
import { getSocket } from '../../socket.js';

let instance = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function dragSource(event) {
  const raw = event.dataTransfer?.getData('application/x-mc-source') ||
    event.dataTransfer?.getData('text/plain');
  if (!raw) return null;
  try {
    return {
      source: JSON.parse(raw),
      label: event.dataTransfer?.getData('application/x-mc-label') || t('mc.canvas.layer'),
    };
  } catch {
    return null;
  }
}

function outputRect(output, topology) {
  return {
    x: Number(output.x || 0),
    y: Number(output.y || 0),
    width: Number(output.width || 1),
    height: Number(output.height || 1),
  };
}

function unionRects(rects) {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

function wallOutputs(topology, wall) {
  const outputs = topology.outputs || [];
  const matched = outputs.filter((output) => {
    const haystack = `${output.slug || ''} ${output.group || ''}`.toLowerCase();
    return wall === 'primary'
      ? haystack.includes('front') || haystack.includes('primary')
      : haystack.includes('side') || haystack.includes('secondary');
  });
  if (matched.length) return matched;
  return wall === 'primary' ? outputs.slice(0, 3) : outputs.slice(3, 5);
}

function placementForDrop(state, x, y) {
  const topology = state.endpoint.topology;
  const outputRects = (topology.outputs || []).map((output) => ({
    output,
    rect: outputRect(output, topology),
  }));
  if (state.snapMode === 'primary') {
    return unionRects(wallOutputs(topology, 'primary').map((output) => outputRect(output, topology)));
  }
  if (state.snapMode === 'secondary') {
    return unionRects(wallOutputs(topology, 'secondary').map((output) => outputRect(output, topology)));
  }
  const containing = outputRects.find(({ rect }) => (
    x >= rect.x && x < rect.x + rect.width &&
    y >= rect.y && y < rect.y + rect.height
  ));
  if (state.snapMode === 'display' && containing) return containing.rect;
  const width = Math.min(containing?.rect.width || 1280, topology.width);
  const height = Math.min(containing?.rect.height || 720, topology.height);
  return {
    x: clamp(x - width / 2, 0, topology.width - width),
    y: clamp(y - height / 2, 0, topology.height - height),
    width,
    height,
  };
}

function statusLabel(endpoint) {
  return endpoint.status === 'online' ? t('mc.canvas.online') : t('mc.canvas.offline');
}

function modeMeta(mode) {
  return {
    display: { icon: '1', title: 'Single TV', detail: 'Drop on the exact screen' },
    primary: { icon: '3', title: 'Span Wall 1', detail: 'One image across 3 TVs' },
    secondary: { icon: '2', title: 'Span Wall 2', detail: 'One image across 2 TVs' },
    free: { icon: '+', title: 'Freeform', detail: 'Place and resize anywhere' },
  }[mode];
}

function chooseCanvasTarget(state, label) {
  const topology = state.endpoint.topology;
  const outputs = topology.outputs || [];
  const dialog = document.createElement('dialog');
  dialog.className = 'mc-dialog mc-route-dialog';
  const outputButtons = outputs.map((output, index) => `
    <button type="button" class="mc-route-row" data-canvas-target="display:${index}">
      <span class="mc-route-row-main">
        <strong class="mc-route-name">${esc(output.name || `${t('mc.canvas.output')} ${index + 1}`)}</strong>
        <span class="mc-route-meta">${esc(t('mc.canvas.route_single'))}</span>
      </span>
    </button>`).join('');
  dialog.innerHTML = `
    <div class="mc-dialog-card mc-route-card">
      <h3 class="mc-dialog-title">${esc(t('mc.canvas.route_title'))}</h3>
      <p class="mc-dialog-msg">${esc(t('mc.canvas.route_message', { label }))}</p>
      <div class="mc-route-list">
        <button type="button" class="mc-route-row" data-canvas-target="primary"><span class="mc-route-row-main"><strong class="mc-route-name">${esc(t('mc.canvas.mode_primary'))}</strong><span class="mc-route-meta">${esc(t('mc.canvas.route_span_three'))}</span></span></button>
        <button type="button" class="mc-route-row" data-canvas-target="secondary"><span class="mc-route-row-main"><strong class="mc-route-name">${esc(t('mc.canvas.mode_secondary'))}</strong><span class="mc-route-meta">${esc(t('mc.canvas.route_span_two'))}</span></span></button>
        <button type="button" class="mc-route-row" data-canvas-target="all"><span class="mc-route-row-main"><strong class="mc-route-name">${esc(t('mc.canvas.route_all'))}</strong><span class="mc-route-meta">${esc(t('mc.canvas.route_span_all'))}</span></span></button>
        ${outputButtons}
      </div>
      <div class="mc-dialog-actions"><button type="button" class="mc-btn mc-btn-ghost" data-canvas-target-cancel>${esc(t('common.cancel'))}</button></div>
    </div>`;
  document.body.appendChild(dialog);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (target) => {
      if (settled) return;
      settled = true;
      try { if (dialog.open) dialog.close(); } catch {}
      dialog.remove();
      resolve(target);
    };
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
    dialog.querySelector('[data-canvas-target-cancel]')?.addEventListener('click', () => finish(null));
    dialog.querySelectorAll('[data-canvas-target]').forEach((button) => {
      button.addEventListener('click', () => finish(button.dataset.canvasTarget));
    });
    dialog.showModal();
  });
}

function placementForTarget(state, target) {
  const topology = state.endpoint.topology;
  if (target === 'primary' || target === 'secondary') {
    return unionRects(wallOutputs(topology, target).map((output) => outputRect(output, topology)));
  }
  if (target === 'all') return { x: 0, y: 0, width: topology.width, height: topology.height };
  if (target && target.startsWith('display:')) {
    const index = Number(target.split(':')[1]);
    const output = topology.outputs?.[index];
    return output ? outputRect(output, topology) : null;
  }
  return null;
}

function layerMarkup(layer, topology, selected) {
  const left = (layer.x / topology.width) * 100;
  const top = (layer.y / topology.height) * 100;
  const width = (layer.width / topology.width) * 100;
  const height = (layer.height / topology.height) * 100;
  const sourceType = Object.keys(layer.source || {})[0] || t('mc.canvas.source');
  return `
    <div class="mc-canvas-layer${selected ? ' is-selected' : ''}"
         data-canvas-layer="${esc(layer.id)}"
         style="left:${left}%;top:${top}%;width:${width}%;height:${height}%;z-index:${layer.z_index || 0}">
      <div class="mc-canvas-layer-head" data-canvas-move="${esc(layer.id)}">
        <span class="mc-canvas-layer-tally">LIVE</span>
        <span class="mc-canvas-layer-name">${esc(layer.label || t('mc.canvas.layer'))}</span>
        <button type="button" data-canvas-remove="${esc(layer.id)}"
                aria-label="${esc(t('mc.canvas.remove_layer'))}">&times;</button>
      </div>
      <div class="mc-canvas-layer-source">
        <span>${esc(sourceType.replaceAll('_', ' '))}</span>
        <span>${Math.round(layer.width)} &times; ${Math.round(layer.height)}</span>
      </div>
      <span class="mc-canvas-resize" data-canvas-resize="${esc(layer.id)}"
            aria-label="${esc(t('mc.canvas.resize_layer'))}"></span>
    </div>`;
}

function outputMarkup(output, topology, index) {
  const rect = outputRect(output, topology);
  const wall = index < 3 ? 'WALL 1' : 'WALL 2';
  return `
    <div class="mc-canvas-output${index === 3 ? ' is-wall-break' : ''}" data-output-id="${esc(output.id)}"
         style="left:${(rect.x / topology.width) * 100}%;top:${(rect.y / topology.height) * 100}%;
                width:${(rect.width / topology.width) * 100}%;height:${(rect.height / topology.height) * 100}%">
      <span class="mc-canvas-output-number">TV ${index + 1}</span>
      <span class="mc-canvas-output-wall">${wall}</span>
      <span class="mc-canvas-output-name">${esc((output.name || output.slug || `${t('mc.canvas.output')} ${index + 1}`).replace('Classroom 1 - ', ''))}</span>
      <span class="mc-canvas-output-size">${Math.round(rect.width)} &times; ${Math.round(rect.height)}</span>
      <span class="mc-canvas-output-drop">DROP HERE</span>
    </div>`;
}

function wallZoneMarkup(topology, wall, label) {
  const rect = unionRects(wallOutputs(topology, wall).map((output) => outputRect(output, topology)));
  if (!rect) return '';
  return `<div class="mc-canvas-wall-zone mc-canvas-wall-zone-${wall}"
    style="left:${(rect.x / topology.width) * 100}%;top:${(rect.y / topology.height) * 100}%;
           width:${(rect.width / topology.width) * 100}%;height:${(rect.height / topology.height) * 100}%">
    <span>${esc(label)}</span>
  </div>`;
}

function render(state) {
  const { host, endpoint } = state;
  const topology = endpoint.topology || {
    origin_x: 0,
    origin_y: 0,
    width: endpoint.canvas_width || 6400,
    height: endpoint.canvas_height || 720,
    outputs: [],
  };
  const statusClass = endpoint.status === 'online' ? 'is-online' : 'is-offline';
  const revision = endpoint.scene_revision || 0;
  const selectedLayer = (endpoint.layers || []).find((layer) => layer.id === state.selectedLayerId);
  const activeMode = modeMeta(state.snapMode);
  host.innerHTML = `
    <section class="mc-canvas-console" aria-labelledby="mc-canvas-title">
      <header class="mc-canvas-console-head">
        <div class="mc-canvas-console-id">
          <span class="mc-canvas-brandmark" aria-hidden="true"><i></i><i></i><i></i></span>
          <div>
            <p class="mc-canvas-kicker">MBFD ROOM ROUTER</p>
            <h3 id="mc-canvas-title">${esc(endpoint.name)}</h3>
          </div>
        </div>
        <div class="mc-canvas-state ${statusClass}">
          <span class="mc-canvas-state-dot" aria-hidden="true"></span>
          <strong>${esc(statusLabel(endpoint))}</strong>
          <span>${(endpoint.layers || []).length} active source${(endpoint.layers || []).length === 1 ? '' : 's'}</span>
          <span class="mc-canvas-revision">r${revision}</span>
        </div>
      </header>

      <div class="mc-canvas-toolbar" role="toolbar" aria-label="Drop routing">
        <div class="mc-canvas-route-label">
          <span>DROP ROUTING</span>
          <strong>Where should content go?</strong>
        </div>
        <div class="mc-canvas-modes">
        ${['display', 'primary', 'secondary', 'free'].map((mode) => {
          const meta = modeMeta(mode);
          return `
          <button type="button" class="mc-canvas-mode${state.snapMode === mode ? ' is-active' : ''}"
                  data-canvas-mode="${mode}" aria-pressed="${state.snapMode === mode ? 'true' : 'false'}">
            <span class="mc-canvas-mode-icon">${meta.icon}</span>
            <span><strong>${meta.title}</strong><small>${meta.detail}</small></span>
          </button>`;
        }).join('')}
        </div>
        <span class="mc-canvas-toolbar-spacer"></span>
        <div class="mc-canvas-actions">
          <button type="button" class="mc-canvas-action" data-canvas-camera="1">Camera 1</button>
          <button type="button" class="mc-canvas-action" data-canvas-camera="2">Camera 2</button>
          <button type="button" class="mc-canvas-action mc-canvas-action-danger" data-canvas-clear>Clear canvas</button>
          <button type="button" class="mc-canvas-action mc-canvas-action-apply" data-canvas-apply><span class="mc-canvas-action-dot"></span>Take live</button>
        </div>
      </div>

      <div class="mc-canvas-workspace">
        <div class="mc-canvas-shell">
          <div class="mc-canvas-programbar">
            <span class="mc-canvas-program-tally">PROGRAM</span>
            <strong>${esc(activeMode.title)}</strong>
            <span>${esc(activeMode.detail)}</span>
            <span class="mc-canvas-programbar-spacer"></span>
            <span>Drag any source from the library onto the room</span>
          </div>
          <div class="mc-canvas-board" data-canvas-board tabindex="0"
               data-canvas-mode="${esc(state.snapMode)}" style="aspect-ratio:${topology.width}/${topology.height}">
            <video class="mc-canvas-live-video" data-canvas-video autoplay playsinline muted tabindex="0"
                   aria-label="${esc(t('mc.canvas.live_preview'))}"></video>
            <div class="mc-canvas-live-state" data-canvas-video-state>${esc(t('mc.canvas.preview_connecting'))}</div>
            ${wallZoneMarkup(topology, 'primary', 'VIDEO WALL 1 / 3 DISPLAYS')}
            ${wallZoneMarkup(topology, 'secondary', 'VIDEO WALL 2 / 2 DISPLAYS')}
            ${(topology.outputs || []).map((output, index) => outputMarkup(output, topology, index)).join('')}
            ${(endpoint.layers || []).map((layer) => layerMarkup(layer, topology, state.selectedLayerId === layer.id)).join('')}
            <div class="mc-canvas-drop-preview" data-canvas-drop-preview hidden><span></span></div>
            ${!(endpoint.layers || []).length ? `
              <div class="mc-canvas-empty">
                <strong>Drag content onto a TV or span an entire wall</strong>
                <span>Choose a routing mode above, then drop a source from the library.</span>
              </div>` : ''}
          </div>
          <div class="mc-canvas-axis">
            <span>CANVAS 0,0</span>
            <span>${Math.round(topology.width)} &times; ${Math.round(topology.height)} px</span>
          </div>
          <div class="mc-canvas-layerbar">
            <div>
              <span class="mc-canvas-layerbar-label">SCENE</span>
              <strong>${(endpoint.layers || []).length} layer${(endpoint.layers || []).length === 1 ? '' : 's'}</strong>
            </div>
            ${selectedLayer ? `
              <div class="mc-canvas-selected-layer">
                <span>Selected: <strong>${esc(selectedLayer.label || t('mc.canvas.layer'))}</strong></span>
                <div class="mc-canvas-fit" role="group" aria-label="Content fit">
                  ${['contain', 'cover', 'fill'].map((fit) => `<button type="button"
                    class="${selectedLayer.fit_mode === fit ? 'is-active' : ''}" data-canvas-fit="${fit}">${fit}</button>`).join('')}
                </div>
              </div>` : '<span class="mc-canvas-layerbar-hint">Select a layer to move, resize, or change its fit.</span>'}
          </div>
        </div>
        <aside class="mc-canvas-monitor" data-canvas-monitor hidden>
          <div class="mc-canvas-monitor-head">
            <span class="mc-canvas-monitor-tally">LIVE</span>
            <strong data-canvas-monitor-title>Interactive room preview</strong>
            <button type="button" data-canvas-monitor-close aria-label="${esc(t('common.close'))}">&times;</button>
          </div>
          <div class="mc-canvas-video-wrap">
            <img data-canvas-camera-image alt="${esc(t('mc.canvas.room_camera'))}" hidden>
            <iframe data-canvas-camera-frame title="${esc(t('mc.canvas.room_camera'))}" allow="autoplay" hidden></iframe>
            <div class="mc-canvas-video-state" data-canvas-camera-state hidden></div>
          </div>
          <p>Click, drag, scroll, or type directly on this feed to control the P3.</p>
        </aside>
      </div>
    </section>`;
  wire(state);
  bindPreviewSurface(state);
}

function canvasPoint(board, event, topology) {
  const rect = board.getBoundingClientRect();
  return {
    x: clamp(((event.clientX - rect.left) / rect.width) * topology.width, 0, topology.width),
    y: clamp(((event.clientY - rect.top) / rect.height) * topology.height, 0, topology.height),
  };
}

function beginLayerGesture(state, event, layerId, mode) {
  event.preventDefault();
  event.stopPropagation();
  const layer = state.endpoint.layers.find((item) => item.id === layerId);
  const board = state.host.querySelector('[data-canvas-board]');
  if (!layer || !board) return;
  state.selectedLayerId = layerId;
  const topology = state.endpoint.topology;
  const start = canvasPoint(board, event, topology);
  const original = { x: layer.x, y: layer.y, width: layer.width, height: layer.height };

  const move = (moveEvent) => {
    const point = canvasPoint(board, moveEvent, topology);
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    if (mode === 'move') {
      layer.x = clamp(original.x + dx, 0, topology.width - layer.width);
      layer.y = clamp(original.y + dy, 0, topology.height - layer.height);
    } else {
      layer.width = clamp(original.width + dx, 80, topology.width - layer.x);
      layer.height = clamp(original.height + dy, 45, topology.height - layer.y);
    }
    render(state);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
}

function sendInput(state, input) {
  if (state.controlChannel && state.controlChannel.readyState === 'open') {
    state.controlChannel.send(JSON.stringify(input));
    return;
  }
  getSocket()?.emit('dashboard:canvas-input', {
    endpoint_id: state.endpoint.id,
    input,
  });
}

function wirePreviewInput(state, video) {
  const pointer = (event, action) => {
    if (!video.videoWidth || !video.videoHeight) return;
    const rect = video.getBoundingClientRect();
    const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
    const shownWidth = video.videoWidth * scale;
    const shownHeight = video.videoHeight * scale;
    const offsetX = (rect.width - shownWidth) / 2;
    const offsetY = (rect.height - shownHeight) / 2;
    const x = clamp((event.clientX - rect.left - offsetX) / shownWidth, 0, 1);
    const y = clamp((event.clientY - rect.top - offsetY) / shownHeight, 0, 1);
    sendInput(state, { type: 'pointer', action, x, y, button: event.button || 0 });
  };
  video.addEventListener('pointerdown', (event) => {
    video.setPointerCapture(event.pointerId);
    pointer(event, 'down');
  });
  video.addEventListener('pointermove', (event) => {
    if (event.buttons) pointer(event, 'move');
  });
  video.addEventListener('pointerup', (event) => pointer(event, 'up'));
  video.addEventListener('wheel', (event) => {
    event.preventDefault();
    sendInput(state, { type: 'wheel', delta_x: event.deltaX, delta_y: event.deltaY });
  }, { passive: false });
  video.addEventListener('keydown', (event) => {
    event.preventDefault();
    sendInput(state, {
      type: 'key',
      action: 'down',
      key: event.key,
      code: event.code,
      alt: event.altKey,
      control: event.ctrlKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    });
  });
  video.addEventListener('keyup', (event) => {
    event.preventDefault();
    sendInput(state, { type: 'key', action: 'up', key: event.key, code: event.code });
  });
}

function bindPreviewSurface(state) {
  const video = state.host.querySelector('[data-canvas-video]');
  const status = state.host.querySelector('[data-canvas-video-state]');
  if (!video) return;
  if (state.previewStream) {
    video.srcObject = state.previewStream;
    if (status) status.hidden = true;
  } else if (status) {
    status.hidden = false;
    status.textContent = state.previewError || t('mc.canvas.preview_connecting');
  }
  wirePreviewInput(state, video);
}

function schedulePreviewRestart(state) {
  if (state.previewRestartTimer || instance !== state) return;
  state.previewRestartTimer = setTimeout(() => {
    state.previewRestartTimer = null;
    startPreview(state);
  }, 2000);
}

async function startPreview(state) {
  if (state.previewStarting || state.peer || instance !== state) return;
  const socket = getSocket();
  if (!socket || !socket.connected) {
    state.previewError = t('mc.canvas.socket_offline');
    bindPreviewSurface(state);
    schedulePreviewRestart(state);
    return;
  }
  state.previewStarting = true;
  state.previewError = null;
  bindPreviewSurface(state);

  const ice = await api.canvas.ice().catch(() => ({ iceServers: [] }));
  state.peer = new RTCPeerConnection({
    iceServers: ice.iceServers || [],
    iceTransportPolicy: ice.iceTransportPolicy || 'all',
  });
  state.peer.ontrack = (event) => {
    if (state.previewOfferTimer) clearTimeout(state.previewOfferTimer);
    state.previewOfferTimer = null;
    state.previewStream = event.streams[0];
    state.previewStarting = false;
    bindPreviewSurface(state);
  };
  state.peer.ondatachannel = (event) => {
    if (event.channel.label === 'control') state.controlChannel = event.channel;
  };
  state.peer.onconnectionstatechange = () => {
    if (!['failed', 'disconnected', 'closed'].includes(state.peer?.connectionState)) return;
    stopPreview(state, { notify: false });
    state.previewError = t('mc.canvas.preview_failed');
    bindPreviewSurface(state);
    schedulePreviewRestart(state);
  };
  state.peer.onicecandidate = (event) => {
    if (!event.candidate) return;
    socket.emit('dashboard:canvas-preview-ice', {
      endpoint_id: state.endpoint.id,
      candidate: event.candidate,
    });
  };
  state.previewOfferHandler = async (payload) => {
    if (!payload || payload.endpoint_id !== state.endpoint.id || !state.peer) return;
    await state.peer.setRemoteDescription(payload.sdp);
    const answer = await state.peer.createAnswer();
    await state.peer.setLocalDescription(answer);
    socket.emit('dashboard:canvas-preview-answer', {
      endpoint_id: state.endpoint.id,
      sdp: answer,
    });
  };
  state.previewIceHandler = async (payload) => {
    if (!payload || payload.endpoint_id !== state.endpoint.id || !state.peer) return;
    try { await state.peer.addIceCandidate(payload.candidate); } catch {}
  };
  state.previewEndedHandler = (payload) => {
    if (!payload || payload.endpoint_id !== state.endpoint.id) return;
    stopPreview(state, { notify: false });
    state.previewError = t('mc.canvas.preview_failed');
    bindPreviewSurface(state);
    schedulePreviewRestart(state);
  };
  socket.on('canvas:preview-offer', state.previewOfferHandler);
  socket.on('canvas:preview-ice', state.previewIceHandler);
  socket.on('canvas:preview-ended', state.previewEndedHandler);
  socket.timeout(5000).emit('dashboard:canvas-preview-start', {
    endpoint_id: state.endpoint.id,
    ice_servers: ice.iceServers || [],
  }, (error, ack) => {
    if (error || !ack?.ok) {
      stopPreview(state, { notify: false });
      state.previewError = t('mc.canvas.preview_failed');
      bindPreviewSurface(state);
      schedulePreviewRestart(state);
    }
  });
  state.previewOfferTimer = setTimeout(() => {
    if (state.previewStream || instance !== state) return;
    stopPreview(state, { notify: false });
    state.previewError = t('mc.canvas.preview_failed');
    bindPreviewSurface(state);
    schedulePreviewRestart(state);
  }, 12000);
}

function stopPreview(state, { notify = true } = {}) {
  const socket = getSocket();
  if (state.previewOfferHandler) socket?.off('canvas:preview-offer', state.previewOfferHandler);
  if (state.previewIceHandler) socket?.off('canvas:preview-ice', state.previewIceHandler);
  if (state.previewEndedHandler) socket?.off('canvas:preview-ended', state.previewEndedHandler);
  if (state.peer) {
    try { state.peer.close(); } catch {}
  }
  if (notify && state.endpoint) {
    socket?.emit('dashboard:canvas-preview-stop', { endpoint_id: state.endpoint.id });
  }
  if (state.previewRestartTimer) clearTimeout(state.previewRestartTimer);
  if (state.previewOfferTimer) clearTimeout(state.previewOfferTimer);
  state.previewRestartTimer = null;
  state.previewOfferTimer = null;
  state.peer = null;
  state.previewStream = null;
  state.previewStarting = false;
  state.controlChannel = null;
  state.previewOfferHandler = null;
  state.previewIceHandler = null;
  state.previewEndedHandler = null;
}

function requestCamera(state, camera) {
  const monitor = state.host.querySelector('[data-canvas-monitor]');
  const image = state.host.querySelector('[data-canvas-camera-image]');
  const frame = state.host.querySelector('[data-canvas-camera-frame]');
  const status = state.host.querySelector('[data-canvas-camera-state]');
  const title = state.host.querySelector('[data-canvas-monitor-title]');
  monitor.hidden = false;
  title.textContent = `Classroom camera ${camera}`;
  image.hidden = true;
  status.hidden = true;
  frame.src = `/player/classroom-camera.html?camera=${camera}&fit=contain`;
  frame.hidden = false;
}

async function publishScene(state, { quiet = false } = {}) {
  if (state.publishing) return;
  state.publishing = true;
  const button = state.host.querySelector('[data-canvas-apply]');
  if (button) button.disabled = true;
  try {
    const result = await api.canvas.publish(state.endpoint.id, state.endpoint.layers);
    state.endpoint = result.endpoint;
    if (!quiet) showToast(t('mc.canvas.applied'), 'success');
    render(state);
  } catch (error) {
    showToast(error.message || t('mc.canvas.apply_failed'), 'error');
  } finally {
    state.publishing = false;
    if (button?.isConnected) button.disabled = false;
  }
}

function showDropPreview(state, board, event) {
  const preview = board.querySelector('[data-canvas-drop-preview]');
  if (!preview) return;
  const topology = state.endpoint.topology;
  const point = canvasPoint(board, event, topology);
  const rect = placementForDrop(state, point.x, point.y);
  const meta = modeMeta(state.snapMode);
  preview.style.left = `${(rect.x / topology.width) * 100}%`;
  preview.style.top = `${(rect.y / topology.height) * 100}%`;
  preview.style.width = `${(rect.width / topology.width) * 100}%`;
  preview.style.height = `${(rect.height / topology.height) * 100}%`;
  preview.querySelector('span').textContent = meta.title;
  preview.hidden = false;
}

function wire(state) {
  const board = state.host.querySelector('[data-canvas-board]');
  const topology = state.endpoint.topology;
  state.host.querySelectorAll('[data-canvas-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      state.snapMode = button.dataset.canvasMode;
      state.host.querySelectorAll('[data-canvas-mode]').forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle('is-active', active);
        candidate.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      board.dataset.canvasMode = state.snapMode;
      const meta = modeMeta(state.snapMode);
      const program = state.host.querySelector('.mc-canvas-programbar');
      if (program) {
        const strong = program.querySelector('strong');
        const detail = strong?.nextElementSibling;
        if (strong) strong.textContent = meta.title;
        if (detail) detail.textContent = meta.detail;
      }
    });
  });
  board.addEventListener('dragover', (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    board.classList.add('is-dragover');
    showDropPreview(state, board, event);
  });
  board.addEventListener('dragleave', (event) => {
    if (board.contains(event.relatedTarget)) return;
    board.classList.remove('is-dragover');
    const preview = board.querySelector('[data-canvas-drop-preview]');
    if (preview) preview.hidden = true;
  });
  board.addEventListener('drop', async (event) => {
    event.preventDefault();
    board.classList.remove('is-dragover');
    const preview = board.querySelector('[data-canvas-drop-preview]');
    if (preview) preview.hidden = true;
    const parsed = dragSource(event);
    if (!parsed) return;
    const point = canvasPoint(board, event, topology);
    const rect = placementForDrop(state, point.x, point.y);
    const id = crypto.randomUUID();
    state.endpoint.layers.push({
      id,
      ...rect,
      z_index: state.endpoint.layers.length,
      label: parsed.label,
      source: parsed.source,
      fit_mode: 'contain',
      muted: true,
    });
    state.selectedLayerId = id;
    render(state);
    await publishScene(state, { quiet: true });
  });
  state.host.querySelectorAll('[data-canvas-layer]').forEach((layerEl) => {
    layerEl.addEventListener('click', () => {
      state.selectedLayerId = layerEl.dataset.canvasLayer;
      render(state);
    });
  });
  state.host.querySelectorAll('[data-canvas-move]').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      beginLayerGesture(state, event, handle.dataset.canvasMove, 'move');
    });
  });
  state.host.querySelectorAll('[data-canvas-resize]').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      beginLayerGesture(state, event, handle.dataset.canvasResize, 'resize');
    });
  });
  state.host.querySelectorAll('[data-canvas-remove]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      state.endpoint.layers = state.endpoint.layers.filter((layer) => layer.id !== button.dataset.canvasRemove);
      render(state);
    });
  });
  state.host.querySelectorAll('[data-canvas-fit]').forEach((button) => {
    button.addEventListener('click', () => {
      const layer = state.endpoint.layers.find((item) => item.id === state.selectedLayerId);
      if (!layer) return;
      layer.fit_mode = button.dataset.canvasFit;
      render(state);
    });
  });
  state.host.querySelector('[data-canvas-apply]')?.addEventListener('click', () => publishScene(state));
  state.host.querySelector('[data-canvas-clear]')?.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: t('mc.canvas.clear_confirm_title'),
      message: t('mc.canvas.clear_confirm_message'),
      confirmLabel: t('mc.canvas.clear_confirm_action'),
      cancelLabel: t('common.cancel'),
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      const result = await api.canvas.clear(state.endpoint.id);
      state.endpoint = result.endpoint;
      showToast(t('mc.canvas.cleared'), 'success');
      render(state);
    } catch (error) {
      showToast(error.message || t('mc.canvas.clear_failed'), 'error');
    }
  });
  state.host.querySelectorAll('[data-canvas-camera]').forEach((button) => {
    button.addEventListener('click', () => requestCamera(state, button.dataset.canvasCamera));
  });
  state.host.querySelector('[data-canvas-monitor-close]')?.addEventListener('click', () => {
    const monitor = state.host.querySelector('[data-canvas-monitor]');
    if (monitor) monitor.hidden = true;
  });
}

export async function mountAdvancedCanvas(host) {
  if (!host) return null;
  unmountAdvancedCanvas();
  let result;
  try {
    result = await api.canvas.list();
  } catch {
    host.hidden = true;
    return null;
  }
  const endpoint = result?.endpoints?.[0];
  if (!endpoint) {
    host.hidden = true;
    return null;
  }
  host.hidden = false;
  instance = {
    host,
    endpoint,
    snapMode: 'display',
    selectedLayerId: null,
    peer: null,
    previewStream: null,
    previewStarting: false,
    previewError: null,
    previewRestartTimer: null,
    previewOfferTimer: null,
    controlChannel: null,
  };
  const socket = getSocket();
  instance.statusHandler = (payload) => {
    if (!payload || payload.endpoint_id !== instance?.endpoint.id) return;
    instance.endpoint.status = payload.status || instance.endpoint.status;
    if (payload.topology) {
      instance.endpoint.topology = payload.topology;
      instance.endpoint.canvas_width = payload.topology.width;
      instance.endpoint.canvas_height = payload.topology.height;
    }
    render(instance);
  };
  instance.cameraHandler = (payload) => {
    if (!payload || payload.endpoint_id !== instance?.endpoint.id) return;
    const image = instance.host.querySelector('[data-canvas-camera-image]');
    const frame = instance.host.querySelector('[data-canvas-camera-frame]');
    const status = instance.host.querySelector('[data-canvas-camera-state]');
    if (!image) return;
    image.src = payload.image;
    image.hidden = false;
    if (frame) frame.hidden = true;
    if (status) status.hidden = true;
  };
  instance.cameraErrorHandler = (payload) => {
    if (!payload || payload.endpoint_id !== instance?.endpoint.id) return;
    const status = instance.host.querySelector('[data-canvas-camera-state]');
    if (!status) return;
    status.hidden = false;
    status.textContent = t('mc.canvas.camera_failed');
  };
  socket?.on('dashboard:canvas-status', instance.statusHandler);
  socket?.on('canvas:camera-frame', instance.cameraHandler);
  socket?.on('canvas:camera-error', instance.cameraErrorHandler);
  render(instance);
  startPreview(instance);
  return endpoint;
}

export function hasAdvancedCanvasEndpoint() {
  return !!instance?.endpoint;
}

export async function routeSourceToAdvancedCanvas(source, label = t('mc.canvas.source')) {
  if (!instance?.endpoint) return false;
  const target = await chooseCanvasTarget(instance, label);
  if (!target) return false;
  const rect = placementForTarget(instance, target);
  if (!rect) return false;
  const layers = Array.isArray(instance.endpoint.layers) ? instance.endpoint.layers : [];
  const id = crypto.randomUUID();
  layers.push({
    id,
    ...rect,
    z_index: layers.length,
    label,
    source,
    fit_mode: 'contain',
    muted: true,
  });
  instance.endpoint.layers = layers;
  instance.selectedLayerId = id;
  await publishScene(instance);
  return true;
}

export async function setAdvancedCanvasBlanked(blanked) {
  if (!instance?.endpoint) return false;
  const result = await api.canvas.setActive(instance.endpoint.id, !blanked);
  instance.endpoint = result.endpoint;
  render(instance);
  return true;
}

export function unmountAdvancedCanvas() {
  if (!instance) return;
  const socket = getSocket();
  socket?.off('dashboard:canvas-status', instance.statusHandler);
  socket?.off('canvas:camera-frame', instance.cameraHandler);
  socket?.off('canvas:camera-error', instance.cameraErrorHandler);
  stopPreview(instance);
  instance = null;
}
