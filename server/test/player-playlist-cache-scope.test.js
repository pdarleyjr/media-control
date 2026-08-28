'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function loadPlaylistCache({ config, storage }) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  const start = source.indexOf("const LEGACY_PLAYLIST_CACHE_KEY = 'rd_playlist_cache';");
  const end = source.indexOf('\n\n    // These constants must be initialized', start);
  assert.ok(start >= 0 && end > start, 'versioned playlist-cache helpers must remain available before player bootstrap');

  const context = vm.createContext({
    URL,
    location: { origin: 'https://media.mbfdhub.com' },
    localStorage: storage,
    initialConfig: { ...config },
  });
  vm.runInContext(`
    let config = initialConfig;
    ${source.slice(start, end)}
    this.__playlistCache = {
      clearPlaylistCache,
      loadPlaylistCache,
      savePlaylistCache,
      setConfig(next) { config = { ...next }; },
    };
  `, context);
  return context.__playlistCache;
}

test('P3 player retires the unscoped legacy playlist cache before offline bootstrap can replay a legacy Guest/Zowie item', () => {
  const storage = createStorage({
    rd_playlist_cache: JSON.stringify([
      { remote_url: '/player/live-source.html?source=guest-computer', label: 'Legacy Zowie' },
    ]),
  });
  const cache = loadPlaylistCache({
    storage,
    config: { deviceId: 'classroom-1-p3', serverUrl: 'http://127.0.0.1:8096' },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(cache.loadPlaylistCache())), []);
  assert.equal(storage.getItem('rd_playlist_cache'), null, 'legacy unscoped data is actively retired rather than replayed');
});

test('P3 playlist cache restores only a current release envelope for the same device and server, then rejects a mismatched reconnect scope', () => {
  const storage = createStorage();
  const cache = loadPlaylistCache({
    storage,
    config: { deviceId: 'classroom-1-p3', serverUrl: 'http://127.0.0.1:8096' },
  });
  const currentPlaylist = [
    { remote_url: '/player/live-source.html?source=podium-computer', label: 'Podium Computer' },
  ];

  cache.savePlaylistCache(currentPlaylist);
  assert.deepEqual(
    JSON.parse(JSON.stringify(cache.loadPlaylistCache())),
    currentPlaylist,
    'a current P3 reconnect keeps its own authoritative cache',
  );

  cache.setConfig({ deviceId: 'classroom-1-p3-other', serverUrl: 'http://127.0.0.1:8096' });
  assert.deepEqual(
    JSON.parse(JSON.stringify(cache.loadPlaylistCache())),
    [],
    'another receiver cannot replay the first P3 receiver cache',
  );
  assert.equal(storage.getItem('rd_playlist_cache_v2'), null, 'a mismatched cache scope is discarded, not retained for a later replay');
});
