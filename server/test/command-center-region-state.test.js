const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Command Center projects exact region playback state for transport and presentation controls', async () => {
  const { regionPlaybackState, transportContextForTarget } = await import(
    '../../frontend/js/services/region-playback-state.js'
  );
  const display = {
    id: 'mosaic-player',
    now_playing: { content_id: 'global-content', paused: false },
    region_states: [
      {
        region_id: 'front-left',
        zone_id: 'zone-left',
        current_content_id: 'left-video',
        content_instance_id: 'assignment-left',
        content_type: 'video',
        paused: true,
        current_time: 12,
        duration: 90,
      },
      {
        region_id: 'front-right',
        zone_id: 'zone-right',
        current_content_id: 'right-deck',
        content_instance_id: 'assignment-right',
        content_type: 'document',
        paused: false,
        slide_index: 4,
        slide_total: 12,
      },
    ],
  };
  const target = {
    type: 'region',
    id: 'front-right',
    wall_id: 'mosaic',
    device_id: 'mosaic-player',
    zone_id: 'zone-right',
    layout_revision: 20,
  };

  assert.deepEqual(regionPlaybackState(display, target), {
    contentId: 'right-deck',
    content_id: 'right-deck',
    content_instance_id: 'assignment-right',
    kind: 'document',
    paused: false,
    currentTime: null,
    duration: null,
    slideIndex: 4,
    slideCount: 12,
    region_id: 'front-right',
    zone_id: 'zone-right',
    render_state: null,
  });
  assert.deepEqual(transportContextForTarget(target, display), {
    deviceId: 'mosaic-player',
    regionId: 'front-right',
    zoneId: 'zone-right',
    wallId: 'mosaic',
    expectedRevision: 20,
    contentInstanceId: 'assignment-right',
    playback: regionPlaybackState(display, target),
  });
});

test('Command Center preserves the composite catalog identity while sending the authoritative region id', async () => {
  const { buildBroadcastSelection } = await import(
    '../../frontend/js/services/command-center-state.js'
  );
  const region = {
    type: 'wall-region',
    id: 'mosaic:front-right',
    wallId: 'mosaic',
    regionId: 'front-right',
    playerDeviceId: 'mosaic-player',
    layoutRevision: 20,
    memberIds: ['mosaic-player'],
  };
  const selection = buildBroadcastSelection({
    walls: [],
    wallGroups: [],
    wallMembers: [],
    wallRegions: [region],
    groups: [],
    displays: [],
  }, [region]);
  assert.deepEqual(selection.broadcastTargets, [{
    type: 'wall-region',
    id: 'mosaic:front-right',
    wall_id: 'mosaic',
    region_id: 'front-right',
    layout_revision: 20,
  }]);
  assert.deepEqual(selection.physicalResolvedTargets, ['mosaic-player']);
});
