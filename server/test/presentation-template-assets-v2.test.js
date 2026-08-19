'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROFILE_IDS } = require('../lib/presentation-template-registry');
const { getTemplateAssets, getTemplateAsset } = require('../lib/presentation-template-assets');

test('exact MBFD logo and watermark bytes are sourced from both approved donor templates', async () => {
  for (const profile of Object.values(PROFILE_IDS)) {
    const assets = await getTemplateAssets(profile);
    for (const name of ['GLOBAL_MBFD_LOGO', 'GLOBAL_MBFD_WATERMARK']) {
      const asset = assets.get(name);
      assert.equal(asset.mime, 'image/png');
      assert.ok(asset.buffer.length > 100);
      assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    }
  }
  assert.equal(await getTemplateAsset(PROFILE_IDS.THREE_DISPLAY, '../escape'), null);
});
