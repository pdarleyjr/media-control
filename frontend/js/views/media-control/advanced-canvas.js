import { api } from '../../api.js';
import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { showToast } from '../../components/toast.js';
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
    x: Number(output.x || 0) - Number(topology.origin_x || 0),
    y: Number(output.y || 0) - Number(topology.origin_y || 0),
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

function layerMarkup(layer, topology, selected) {
  const left = (layer.x / topology.width) * 100;
  const top = (layer.y / topology.height) * 100;
  const width = (layer.width / topology.width) * 100;
  const height = (layer.height / topology.height) * 100;
  return `
    <div class="mc-canvas-layer${selected ? ' is-selected' : ''}"
         data-canvas-layer="${esc(layer.id)}"
         style="left:${left}%;top:${top}%;width:${width}%;height:${height}%;z-index:${layer.z_index || 0}">
      <div class="mc-canvas-layer-head" data-canvas-move="${esc(layer.id)}">
        <span>${esc(layer.label || t('mc.canvas.layer'))}</span>
        <button type="button" data-canvas-remove="${esc(layer.id)}"
                aria-label="${esc(t('mc.canvas.remove_layer'))}">&times;</button>
      </div>
      <div class="mc-canvas-layer-source">${esc(Object.keys(layer.source || {})[0] || t('mc.canvas.source'))}</div>
      <span class="mc-canvas-resize" data-canvas-resize="${esc(layer.id)}"
            aria-label="${esc(t('mc.canvas.resize_layer'))}"></span>
    </div>`;
}

function outputMarkup(output, topology, index) {
  const rect = outputRect(output, topology);
  return `
    <div class="mc-canvas-output" data-output-id="${esc(output.id)}"
         style="left:${(rect.x / topology.width) * 100}%;top:${(rect.y / topology.height) * 100}%;
                width:${(rect.width / topology.width) * 100}%;height:${(rect.height / topology.height) * 100}%">
      <span class="mc-canvas-output-number">${index + 1}</span>
      <span class="mc-canvas-output-name">${esc(output.name || output.slug || `${t('mc.canvas.output')} ${index + 1}`)}</span>
      <span class="mc-canvas-output-size">${Math.round(rect.width)} &times; ${Math.round(rect.height)}</span>
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
  host.innerHTML = `
    <section class="mc-canvas-console" aria-labelledby="mc-canvas-title">
      <header class="mc-canvas-console-head">
        <div>
          <p class="mc-canvas-kicker">${esc(t('mc.canvas.kicker'))}</p>
          <h3 id="mc-canvas-title">${esc(endpoint.name)}</h3>
          <p>${esc(t('mc.canvas.hint'))}</p>
        </div>
        <div class="mc-canvas-state ${statusClass}">
          <span class="mc-canvas-state-dot" aria-hidden="true"></span>
          <span>${esc(statusLabel(endpoint))}</span>
          <span>${esc(t('mc.canvas.revision', { n: revision }))}</span>
        </div>
      </header>

      <div class="mc-canvas-toolbar" role="toolbar" aria-label="${esc(t('mc.canvas.snap_mode'))}">
        <span class="mc-canvas-toolbar-label">${esc(t('mc.canvas.snap_mode'))}</span>
        ${[
          ['display', 'mc.canvas.mode_display'],
          ['primary', 'mc.canvas.mode_primary'],
          ['secondary', 'mc.canvas.mode_secondary'],
          ['free', 'mc.canvas.mode_free'],
        ].map(([mode, key]) => `
          <button type="button" class="mc-canvas-mode${state.snapMode === mode ? ' is-active' : ''}"
                  data-canvas-mode="${mode}" aria-pressed="${state.snapMode === mode ? 'true' : 'false'}">
            ${esc(t(key))}
          </button>`).join('')}
        <span class="mc-canvas-toolbar-spacer"></span>
        <button type="button" class="mc-canvas-action" data-canvas-preview>${esc(t('mc.canvas.live_preview'))}</button>
        <button type="button" class="mc-canvas-action" data-canvas-camera>${esc(t('mc.canvas.room_camera'))}</button>
        <button type="button" class="mc-canvas-action mc-canvas-action-danger" data-canvas-clear>${esc(t('mc.canvas.clear'))}</button>
        <button type="button" class="mc-canvas-action mc-canvas-action-apply" data-canvas-apply>${esc(t('mc.canvas.apply'))}</button>
      </div>

      <div class="mc-canvas-workspace">
        <div class="mc-canvas-shell">
          <div class="mc-canvas-board" data-canvas-board tabindex="0"
               style="aspect-ratio:${topology.width}/${topology.height}">
            ${(topology.outputs || []).map((output, index) => outputMarkup(output, topology, index)).join('')}
            ${(endpoint.layers || []).map((layer) => layerMarkup(layer, topology, state.selectedLayerId === layer.id)).join('')}
            ${!(endpoint.layers || []).length ? `
              <div class="mc-canvas-empty">
                <strong>${esc(t('mc.canvas.empty_title'))}</strong>
                <span>${esc(t('mc.canvas.empty_hint'))}</span>
              </div>` : ''}
          </div>
          <div class="mc-canvas-axis">
            <span>0,0</span>
            <span>${Math.round(topology.width)} &times; ${Math.round(topology.height)} px</span>
          </div>
        </div>
        <aside class="mc-canvas-monitor" data-canvas-monitor hidden>
          <div class="mc-canvas-monitor-head">
            <strong data-canvas-monitor-title>${esc(t('mc.canvas.live_preview'))}</strong>
            <button type="button" data-canvas-monitor-close aria-label="${esc(t('common.close'))}">&times;</button>
          </div>
          <div class="mc-canvas-video-wrap">
            <video data-canvas-video autoplay playsinline muted tabindex="0"></video>
            <img data-canvas-camera-image alt="${esc(t('mc.canvas.room_camera'))}" hidden>
            <div class="mc-canvas-video-state" data-canvas-video-state>${esc(t('mc.canvas.preview_waiting'))}</div>
          </div>
          <p>${esc(t('mc.canvas.kvm_hint'))}</p>
        </aside>
      </div>
    </section>`;
  wire(state);
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

async function startPreview(state) {
  const socket = getSocket();
  if (!socket || !socket.connected) {
    showToast(t('mc.canvas.socket_offline'), 'error');
    return;
  }
  stopPreview(state);
  const monitor = state.host.querySelector('[data-canvas-monitor]');
  const video = state.host.querySelector('[data-canvas-video]');
  const image = state.host.querySelector('[data-canvas-camera-image]');
  const status = state.host.querySelector('[data-canvas-video-state]');
  monitor.hidden = false;
  image.hidden = true;
  video.hidden = false;
  status.hidden = false;
  status.textContent = t('mc.canvas.preview_connecting');

  const ice = await api.canvas.ice().catch(() => ({ iceServers: [] }));
  state.peer = new RTCPeerConnection({
    iceServers: ice.iceServers || [],
    iceTransportPolicy: ice.iceTransportPolicy || 'all',
  });
  state.peer.ontrack = (event) => {
    video.srcObject = event.streams[0];
    status.hidden = true;
    video.focus();
  };
  state.peer.ondatachannel = (event) => {
    if (event.channel.label === 'control') state.controlChannel = event.channel;
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
    status.hidden = false;
    status.textContent = t('mc.canvas.preview_failed');
  };
  socket.on('canvas:preview-offer', state.previewOfferHandler);
  socket.on('canvas:preview-ice', state.previewIceHandler);
  socket.on('canvas:preview-ended', state.previewEndedHandler);
  wirePreviewInput(state, video);
  socket.timeout(5000).emit('dashboard:canvas-preview-start', {
    endpoint_id: state.endpoint.id,
    ice_servers: ice.iceServers || [],
  }, (error, ack) => {
    if (error || !ack?.ok) {
      status.textContent = t('mc.canvas.preview_failed');
    }
  });
}

function stopPreview(state) {
  const socket = getSocket();
  if (state.previewOfferHandler) socket?.off('canvas:preview-offer', state.previewOfferHandler);
  if (state.previewIceHandler) socket?.off('canvas:preview-ice', state.previewIceHandler);
  if (state.previewEndedHandler) socket?.off('canvas:preview-ended', state.previewEndedHandler);
  if (state.peer) {
    try { state.peer.close(); } catch {}
  }
  if (state.endpoint) {
    socket?.emit('dashboard:canvas-preview-stop', { endpoint_id: state.endpoint.id });
  }
  state.peer = null;
  state.controlChannel = null;
  state.previewOfferHandler = null;
  state.previewIceHandler = null;
  state.previewEndedHandler = null;
}

function requestCamera(state) {
  const socket = getSocket();
  const monitor = state.host.querySelector('[data-canvas-monitor]');
  const video = state.host.querySelector('[data-canvas-video]');
  const image = state.host.querySelector('[data-canvas-camera-image]');
  const status = state.host.querySelector('[data-canvas-video-state]');
  const title = state.host.querySelector('[data-canvas-monitor-title]');
  monitor.hidden = false;
  title.textContent = t('mc.canvas.room_camera');
  video.hidden = true;
  image.hidden = true;
  status.hidden = false;
  status.textContent = t('mc.canvas.camera_waiting');
  socket?.timeout(5000).emit('dashboard:canvas-camera-request', {
    endpoint_id: state.endpoint.id,
  }, (error, ack) => {
    if (error || !ack?.ok) status.textContent = t('mc.canvas.camera_failed');
  });
}

function wire(state) {
  const board = state.host.querySelector('[data-canvas-board]');
  const topology = state.endpoint.topology;
  state.host.querySelectorAll('[data-canvas-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      state.snapMode = button.dataset.canvasMode;
      render(state);
    });
  });
  board.addEventListener('dragover', (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    board.classList.add('is-dragover');
  });
  board.addEventListener('dragleave', () => board.classList.remove('is-dragover'));
  board.addEventListener('drop', (event) => {
    event.preventDefault();
    board.classList.remove('is-dragover');
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
  state.host.querySelector('[data-canvas-apply]')?.addEventListener('click', async () => {
    try {
      const result = await api.canvas.publish(state.endpoint.id, state.endpoint.layers);
      state.endpoint = result.endpoint;
      showToast(t('mc.canvas.applied'), 'success');
      render(state);
    } catch (error) {
      showToast(error.message || t('mc.canvas.apply_failed'), 'error');
    }
  });
  state.host.querySelector('[data-canvas-clear]')?.addEventListener('click', async () => {
    try {
      const result = await api.canvas.clear(state.endpoint.id);
      state.endpoint = result.endpoint;
      showToast(t('mc.canvas.cleared'), 'success');
      render(state);
    } catch (error) {
      showToast(error.message || t('mc.canvas.clear_failed'), 'error');
    }
  });
  state.host.querySelector('[data-canvas-preview]')?.addEventListener('click', () => startPreview(state));
  state.host.querySelector('[data-canvas-camera]')?.addEventListener('click', () => requestCamera(state));
  state.host.querySelector('[data-canvas-monitor-close]')?.addEventListener('click', () => {
    stopPreview(state);
    const monitor = state.host.querySelector('[data-canvas-monitor]');
    if (monitor) monitor.hidden = true;
  });
}

export async function mountAdvancedCanvas(host) {
  if (!host) return;
  unmountAdvancedCanvas();
  let result;
  try {
    result = await api.canvas.list();
  } catch {
    host.hidden = true;
    return;
  }
  const endpoint = result?.endpoints?.[0];
  if (!endpoint) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  instance = {
    host,
    endpoint,
    snapMode: 'display',
    selectedLayerId: null,
    peer: null,
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
    const video = instance.host.querySelector('[data-canvas-video]');
    const status = instance.host.querySelector('[data-canvas-video-state]');
    if (!image) return;
    image.src = payload.image;
    image.hidden = false;
    if (video) video.hidden = true;
    if (status) status.hidden = true;
  };
  instance.cameraErrorHandler = (payload) => {
    if (!payload || payload.endpoint_id !== instance?.endpoint.id) return;
    const status = instance.host.querySelector('[data-canvas-video-state]');
    if (!status) return;
    status.hidden = false;
    status.textContent = t('mc.canvas.camera_failed');
  };
  socket?.on('dashboard:canvas-status', instance.statusHandler);
  socket?.on('canvas:camera-frame', instance.cameraHandler);
  socket?.on('canvas:camera-error', instance.cameraErrorHandler);
  render(instance);
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
