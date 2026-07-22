import { roomState, requestRoomSnapshot } from '../socket.js';
import { buildTargetCatalog } from './target-catalog.js';

const DEFAULT_WAIT_MS = 5000;

/**
 * Runtime bridge between the revision-aware room store and target-picking UI.
 * Consumers never combine /devices and /walls themselves: they either receive
 * the latest authoritative snapshot immediately or wait for the socket resume
 * path to deliver one. A timeout fails closed instead of presenting stale or
 * incomplete routing choices.
 */
export function createTargetCatalogRuntime(options = {}) {
  const store = options.roomStore;
  const requestSnapshot = typeof options.requestSnapshot === 'function'
    ? options.requestSnapshot
    : () => {};
  const project = typeof options.buildCatalog === 'function'
    ? options.buildCatalog
    : buildTargetCatalog;

  if (!store || typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') {
    throw new TypeError('A room state store is required');
  }

  function current(projectOptions = {}) {
    const snapshot = store.getSnapshot();
    return snapshot ? project(snapshot, projectOptions) : null;
  }

  function wait(projectOptions = {}, waitOptions = {}) {
    const available = current(projectOptions);
    const requireFresh = waitOptions.requireFresh === true;
    if (available && !requireFresh) {
      requestSnapshot();
      return Promise.resolve(available);
    }

    const baseline = store.getSnapshot();
    const isAcceptable = (snapshot) => {
      if (!snapshot) return false;
      if (!requireFresh || !baseline) return true;
      return Number(snapshot.revision) > Number(baseline.revision)
        || Number(snapshot.serverTimestamp) > Number(baseline.serverTimestamp);
    };

    const timeoutMs = Number.isFinite(Number(waitOptions.timeoutMs))
      ? Math.max(0, Number(waitOptions.timeoutMs))
      : DEFAULT_WAIT_MS;

    requestSnapshot(requireFresh ? { force: true } : undefined);
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => {};
      let timer = null;

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        callback(value);
      };

      unsubscribe = store.subscribe((snapshot) => {
        if (isAcceptable(snapshot)) finish(resolve, project(snapshot, projectOptions));
      });

      // Close the subscribe/check race if a snapshot landed synchronously.
      const raced = current(projectOptions);
      if (raced && isAcceptable(store.getSnapshot())) {
        finish(resolve, raced);
        return;
      }

      timer = setTimeout(() => {
        finish(reject, new Error('Live room topology is unavailable. Check the server connection and try again.'));
      }, timeoutMs);
    });
  }

  return { current, wait };
}

const runtime = createTargetCatalogRuntime({
  roomStore: roomState,
  requestSnapshot: requestRoomSnapshot,
});

export function getCurrentTargetCatalog(options = {}) {
  return runtime.current(options);
}

export function waitForTargetCatalog(options = {}, waitOptions = {}) {
  return runtime.wait(options, waitOptions);
}
