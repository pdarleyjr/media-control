'use strict';

// One bounded rolling-compatibility period for clients older than the
// one-click deterministic livestream UI. These endpoints cannot select the
// active publisher: publisher mode is process-start configuration and the
// authoritative /start route always begins in Camera Only.
const REMOVAL_VERSION = '2.0.0';
const SUNSET_HTTP_DATE = 'Wed, 30 Sep 2026 23:59:59 GMT';
const DEPRECATION_LINK = 'https://github.com/pdarleyjr/media-control/blob/main/docs/live-stream-compatibility.md';

function markLegacyLiveCompatibility(res) {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', SUNSET_HTTP_DATE);
  res.setHeader('Link', `<${DEPRECATION_LINK}>; rel="deprecation"`);
  res.setHeader('Warning', `299 MBFD-Media-Control "Legacy livestream compatibility API; remove before ${REMOVAL_VERSION}"`);
  res.setHeader('X-MBFD-Removal-Version', REMOVAL_VERSION);
}

module.exports = {
  REMOVAL_VERSION,
  SUNSET_HTTP_DATE,
  DEPRECATION_LINK,
  markLegacyLiveCompatibility,
};
