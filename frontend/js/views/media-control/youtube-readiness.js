// youtube-readiness.js — pure, browser-free predicate for the YouTube
// fail-closed broadcast gate used by send.js. Kept dependency-free so it can be
// unit-tested without the browser runtime.
//
// A YouTube source must be materialized into a content row with a usable local
// asset before it is safe to broadcast. A row without a ready local path/asset
// (still pending, failed, or a bare remote URL) must never be treated as
// broadcast-ready — shipping it would leave a black wall.

export function isYouTubeContentBroadcastReady(content) {
  if (!content || !content.id) return false;
  return Boolean(
    content.local_path
      || content.localPath
      || content.asset_id
      || content.assetId
      || content.status === 'ready'
      || content.materialized === true,
  );
}
