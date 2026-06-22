// preload.js — contextBridge surface for the Kamrui kiosk renderer.
// Exposes ONLY a tiny `window.mcBridge` with safe, wrapped helpers. No Node,
// no require, no fs, no process surface leaks to the page. contextIsolation
// true keeps the renderer sandboxed; this file is the single approved bridge.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mcBridge', {
  // Returns { online: boolean, target: string } — used by the offline-fallback
  // screen's retry indicator + the reconnecting layer.
  getReconnectState: () => ipcRenderer.invoke('mc:reconnect-state'),
  // Returns { present: boolean } — used by the player to decide mcmedia:// vs
  // the signed canonical URL fallback for a content-addressed asset.
  localAssetAvailable: (sha256) => ipcRenderer.invoke('mc:asset-available', String(sha256 || '')),
  // Routes the kiosk to the integrated whiteboard view (a CC route).
  launchWhiteboard: () => ipcRenderer.invoke('mc:launch-whiteboard'),
});