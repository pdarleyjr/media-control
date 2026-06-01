import { api } from '../api.js';
import * as displayState from '../services/display-state.js';

let unsub = null;

export async function render() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="mc-control">
      <div class="mc-topbar">
        <h1>Media Control</h1>
        <div class="mc-view-toggle"><button data-mode="grid" class="active">Grid</button><button data-mode="wall">Wall</button></div>
        <div id="mc-broadcast-chip" class="mc-chip" hidden></div>
      </div>
      <section id="mc-stage" class="mc-stage" aria-label="Displays you are controlling"></section>
      <section id="mc-toolbox" class="mc-toolbox" aria-label="Sources and actions"></section>
      <aside id="mc-inspector" class="mc-inspector" hidden></aside>
    </div>`;
  await displayState.refresh().catch(() => {});
  unsub = displayState.subscribe(() => { /* stage repaint wired in 4.2 */ });
}

export function unmount() {
  // The view owns NO live broadcast resource (that's the engine singleton),
  // so unmount only detaches this view's subscriptions. Broadcasts persist.
  if (unsub) { unsub(); unsub = null; }
}
