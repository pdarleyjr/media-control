// Shared wallpaper option/state contract for both the canvas-level selector and
// legacy per-card selectors. Keeping this in one module prevents the two menus
// from drifting and lets each menu reflect authoritative display state.

const BUILTIN_SCREENSAVER_OPTIONS = [
  { value: 'url:https://wall.mbfdhub.com', labelKey: 'mc.saver.dashboard' },
  { value: 'content:4798f022-e9d9-4cba-a0b0-56aeb75a6bff', labelKey: 'mc.saver.bw' },
  { value: 'content:1d01b7a0-1a0c-4d3d-b0fd-6d854ce09ae3', labelKey: 'mc.saver.l1' },
  { value: 'content:7c596f36-27f6-4d7b-9bb0-2c682791d25a', labelKey: 'mc.saver.mbfd_map' },
  { value: 'folder:Screensavers', labelKey: 'mc.saver.choose_from_folder' },
  { value: 'blank:black', labelKey: 'mc.saver.blank_black' },
];

// This array intentionally retains its identity. Stage and canvas selectors
// import the same object, so replacing its contents before those controls mount
// gives both selectors one authoritative set of options without a second state
// store or a per-broadcast content request.
export const SCREENSAVER_OPTIONS = [...BUILTIN_SCREENSAVER_OPTIONS];

export function wallpaperOptionsFromContent(items) {
  const options = [];
  const seen = new Set(BUILTIN_SCREENSAVER_OPTIONS.map(option => option.value));
  for (const item of Array.isArray(items) ? items : []) {
    const id = String(item?.id || '').trim();
    const mime = String(item?.mime_type || '').toLowerCase();
    const value = id ? `content:${id}` : '';
    if (!id || !mime.startsWith('image/') || item.is_wallpaper_menu !== true || seen.has(value)) continue;
    seen.add(value);
    const filename = String(item.filename || item.name || 'Wallpaper').trim();
    const label = filename.replace(/\.[^.]+$/, '') || filename;
    options.push({ value, label, workspaceWallpaper: true });
  }
  return options.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

export function setWorkspaceWallpaperOptions(items) {
  const dynamic = wallpaperOptionsFromContent(items);
  const folderIndex = BUILTIN_SCREENSAVER_OPTIONS.findIndex(option => option.value.startsWith('folder:'));
  const insertionPoint = folderIndex < 0 ? BUILTIN_SCREENSAVER_OPTIONS.length : folderIndex;
  SCREENSAVER_OPTIONS.splice(
    0,
    SCREENSAVER_OPTIONS.length,
    ...BUILTIN_SCREENSAVER_OPTIONS.slice(0, insertionPoint),
    ...dynamic,
    ...BUILTIN_SCREENSAVER_OPTIONS.slice(insertionPoint),
  );
  return SCREENSAVER_OPTIONS;
}

export const MIXED_SCREENSAVER_VALUE = '__mixed_or_custom__';

// A tiny black still keeps blank-black independent of an external asset.
export const BLACK_SCREENSAVER_URL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16' fill='%23000'/%3E%3C/svg%3E";

function normalizedWebUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}`;
  } catch {
    return String(value || '');
  }
}

export function screensaverValueForNowPlaying(nowPlaying) {
  const np = nowPlaying || {};
  const contentId = String(np.contentId || np.content_id || '');
  if (contentId) {
    const contentValue = `content:${contentId}`;
    if (SCREENSAVER_OPTIONS.some((option) => option.value === contentValue)) return contentValue;
  }

  const remoteUrl = String(np.remoteUrl || np.remote_url || '');
  if (remoteUrl === BLACK_SCREENSAVER_URL) return 'blank:black';
  if (remoteUrl) {
    const normalized = normalizedWebUrl(remoteUrl);
    const urlOption = SCREENSAVER_OPTIONS.find((option) => (
      option.value.startsWith('url:')
      && normalizedWebUrl(option.value.slice(4)) === normalized
    ));
    if (urlOption) return urlOption.value;
  }

  const kind = String(np.kind || '').toLowerCase();
  return kind && kind !== 'idle' ? MIXED_SCREENSAVER_VALUE : '';
}

export function screensaverValueForDisplays(displays) {
  const list = Array.isArray(displays) ? displays : [];
  if (!list.length) return '';
  const values = list.map((display) => screensaverValueForNowPlaying(display?.now_playing));
  const unique = new Set(values);
  return unique.size === 1 ? values[0] : MIXED_SCREENSAVER_VALUE;
}
