// Enterprise i18n overlay (NEW, non-conflicting path — does not touch
// frontend/js/i18n/* which is reserved by the active agent).
//
// The existing i18n.js `t()` returns the key itself when a key is missing, so
// enterprise components can call the global `t()` safely. This module adds the
// canonical English strings for all mc.e.* keys so the operator console is
// fully translated without editing reserved files. At integration time these
// keys can be merged into frontend/js/i18n/en.js; until then the console uses
// this overlay via createEnterpriseI18n().

const STRINGS = {
  // Operator state vocabulary
  'mc.e.op_state.standby': 'Standby',
  'mc.e.op_state.requested': 'Requested',
  'mc.e.op_state.pending': 'Pending',
  'mc.e.op_state.confirmed': 'Confirmed',
  'mc.e.op_state.failed': 'Failed',
  'mc.e.op_state.offline': 'Offline',
  'mc.e.op_state.stale': 'Stale',

  // Surfaces
  'mc.e.surface.preview': 'Preview',
  'mc.e.surface.classroom': 'Classroom program',
  'mc.e.surface.livestream': 'Livestream program',
  'mc.e.surface.aria': 'Target surface',

  // Workflow steps
  'mc.e.step.room': 'Choose room',
  'mc.e.step.room_none': 'Not selected',
  'mc.e.step.layout': 'Choose layout',
  'mc.e.step.content': 'Choose content',
  'mc.e.workflow.aria': 'Operator workflow',

  // Send
  'mc.e.send.preview': 'Preview',
  'mc.e.send.classroom': 'Send to classroom',
  'mc.e.send.livestream': 'Take to livestream',
  'mc.e.send.confirm': 'Confirm: apply this change to the active surface?',

  // Room overview
  'mc.e.overview.title': 'Room overview',
  'mc.e.overview.region_label': 'Room overview',
  'mc.e.overview.loading': 'Loading room state…',
  'mc.e.overview.online': 'online',
  'mc.e.overview.offline': 'offline',
  'mc.e.overview.failed': 'failed',
  'mc.e.overview.pending': 'pending',
  'mc.e.overview.idle': 'Idle',
  'mc.e.overview.wall': 'Wall',
  'mc.e.overview.map_label': 'Display map',
  'mc.e.overview.no_displays': 'No displays',
  'mc.e.overview.classroom_program': 'Classroom program',
  'mc.e.overview.livestream': 'Livestream',
  'mc.e.overview.recording': 'Recording',
  'mc.e.overview.stream': 'Stream',

  // Layout selector
  'mc.e.layout.aria': 'Layout selector',
  'mc.e.layout.grid_aria': 'Layout options',
  'mc.e.layout.unavailable_needs_displays': 'Not enough displays connected',
  'mc.e.layout.single': 'Single display',
  'mc.e.layout.mirror': 'Mirror',
  'mc.e.layout.span-two': 'Two-display span',
  'mc.e.layout.span-three': 'Three-display span',
  'mc.e.layout.span-five': 'Five-display span',
  'mc.e.layout.two-plus-one': 'Two plus one',
  'mc.e.layout.independent': 'Independent outputs',
  'mc.e.layout.content-fullscreen': 'Content fullscreen',
  'mc.e.layout.content-with-camera-pip': 'Content with camera PiP',
  'mc.e.layout.camera-fullscreen': 'Camera fullscreen',
  'mc.e.layout.camera-with-content-pip': 'Camera with content PiP',
  'mc.e.layout.side-by-side': 'Side-by-side',
  'mc.e.layout.custom-saved': 'Saved custom layout',
  'mc.e.layout.clear': 'Clear',
  'mc.e.layout.restore-previous': 'Restore previous',
  'mc.e.layout.audio.display': 'Audio: display',
  'mc.e.layout.audio.primary': 'Audio: primary',
  'mc.e.layout.audio.each': 'Audio: each',
  'mc.e.layout.audio.camera': 'Audio: camera',
  'mc.e.layout.audio.none': 'Audio: none',
  'mc.e.layout.audio.inherit': 'Audio: inherits',

  // Content selector
  'mc.e.content.facet.recent': 'Recent',
  'mc.e.content.facet.favorites': 'Favorites',
  'mc.e.content.facet.mine': 'My private',
  'mc.e.content.facet.workspace': 'Workspace shared',
  'mc.e.content.facet.org': 'Organization shared',
  'mc.e.content.facet.templates': 'Platform templates',
  'mc.e.content.facet.type': 'Type',
  'mc.e.content.facet.archived': 'Archived',
  'mc.e.content.facets_aria': 'Content filters',
  'mc.e.content.list_aria': 'Content library',
  'mc.e.content.slides': 'slides',
  'mc.e.content.in_use': 'In use',
  'mc.e.content.processing': 'Processing',
  'mc.e.content.incompatible': 'Incompatible',
  'mc.e.content.empty': 'No content',
  'mc.e.content.vis.private': 'Private',
  'mc.e.content.vis.workspace': 'Workspace',
  'mc.e.content.vis.org': 'Organization',
  'mc.e.content.vis.template': 'Template',

  // Playback
  'mc.e.playback.aria': 'Playback controls',
  'mc.e.playback.loading': 'Loading…',
  'mc.e.playback.no_target': 'No target display',
  'mc.e.playback.slides': 'PowerPoint',
  'mc.e.playback.video': 'Video',
  'mc.e.playback.screen': 'Screen share',
  'mc.e.playback.screen_hint': 'See screen-share panel for transport and fallback details.',
  'mc.e.playback.camera': 'Camera',
  'mc.e.playback.idle': 'Select content to control playback',
  'mc.e.pb.prev': 'Previous',
  'mc.e.pb.next': 'Next',
  'mc.e.pb.restart': 'Restart',
  'mc.e.pb.restore': 'Restore presentation',
  'mc.e.pb.go_slide': 'Go to slide',
  'mc.e.pb.play': 'Play',
  'mc.e.pb.pause': 'Pause',
  'mc.e.pb.stop': 'Stop',
  'mc.e.pb.stop_restore': 'Stop and restore',
  'mc.e.pb.seek': 'Seek',
  'mc.e.pb.volume': 'Volume',
  'mc.e.pb.mute': 'Mute',
  'mc.e.pb.retry': 'Retry',
  'mc.e.pb.cam_full': 'Fullscreen',
  'mc.e.pb.cam_pip': 'Picture-in-picture',
  'mc.e.pb.swap_pip': 'Swap PiP',
  'mc.e.pb.hold': 'Manual hold',

  // Screen share
  'mc.e.ss.aria': 'Screen share',
  'mc.e.ss.title': 'Screen share',
  'mc.e.ss.degraded': 'DEGRADED FALLBACK',
  'mc.e.ss.direct': 'Direct WebRTC',
  'mc.e.ss.video_only': 'Video only',
  'mc.e.ss.source': 'Source connected',
  'mc.e.ss.video_track': 'Video track',
  'mc.e.ss.audio_track': 'Audio track',
  'mc.e.ss.resolution': 'Resolution',
  'mc.e.ss.fps': 'Frame rate',
  'mc.e.ss.transport': 'Transport',
  'mc.e.ss.fit': 'Fit mode',
  'mc.e.ss.pip': 'Camera PiP',
  'mc.e.ss.latency': 'Latency/health',
  'mc.e.ss.stop': 'Stop',
  'mc.e.ss.restore': 'Restore prior content',

  // Privacy
  'mc.e.privacy.aria': 'Privacy and publishing',
  'mc.e.privacy.levels_aria': 'Visibility',
  'mc.e.privacy.level.private': 'Private',
  'mc.e.privacy.level.workspace': 'Workspace shared',
  'mc.e.privacy.level.org': 'Organization shared',
  'mc.e.privacy.level.template': 'Platform template',
  'mc.e.privacy.confirm_broaden': 'Share more broadly? This will expose content to more users.',
  'mc.e.privacy.in_use': 'Currently in use — destructive deletion prevented.',
  'mc.e.privacy.request_sent': 'Organization publication requested.',
  'mc.e.privacy.share_ws': 'Share to workspace',
  'mc.e.privacy.request_org': 'Request org publication',
  'mc.e.privacy.approve': 'Approve publication',
  'mc.e.privacy.duplicate': 'Duplicate privately',
  'mc.e.privacy.archive': 'Archive',
  'mc.e.privacy.transfer': 'Transfer ownership',
  'mc.e.privacy.delete': 'Delete',
  'mc.e.privacy.delete_blocked': 'Cannot delete while in use',

  // Error recovery
  'mc.e.err.retry_safe': 'Retry safe',
  'mc.e.err.display_offline.title': 'Display offline',
  'mc.e.err.display_offline.what': 'A display is not reachable by the server.',
  'mc.e.err.display_offline.active': 'Other displays remain active.',
  'mc.e.err.display_offline.action': 'Check the device power and network, then retry.',
  'mc.e.err.stale_room_state.title': 'Stale room state',
  'mc.e.err.stale_room_state.what': 'The room state has not refreshed within tolerance.',
  'mc.e.err.stale_room_state.active': 'Last known state is still shown.',
  'mc.e.err.stale_room_state.action': 'Wait for reconnection or request a fresh snapshot.',
  'mc.e.err.conflicting_command.title': 'Conflicting command',
  'mc.e.err.conflicting_command.what': 'Another command is in flight for this target.',
  'mc.e.err.conflicting_command.active': 'The previous command may still take effect.',
  'mc.e.err.conflicting_command.action': 'Wait for the current command to resolve before retrying.',
  'mc.e.err.unauthorized.title': 'Unauthorized action',
  'mc.e.err.unauthorized.what': 'Your role does not permit this action.',
  'mc.e.err.unauthorized.active': 'Nothing changed.',
  'mc.e.err.unauthorized.action': 'Ask a workspace editor or admin to perform this action.',
  'mc.e.err.content_processing.title': 'Content still processing',
  'mc.e.err.content_processing.what': 'This content has not finished processing.',
  'mc.e.err.content_processing.active': 'No change was sent.',
  'mc.e.err.content_processing.action': 'Wait for processing to complete and retry.',
  'mc.e.err.incompatible_media.title': 'Incompatible media',
  'mc.e.err.incompatible_media.what': 'This media cannot be played on the target display.',
  'mc.e.err.incompatible_media.active': 'No change was sent.',
  'mc.e.err.incompatible_media.action': 'Choose a compatible format or display.',
  'mc.e.err.ss_no_audio.title': 'Missing screen-share audio',
  'mc.e.err.ss_no_audio.what': 'The screen share has video but no audio track.',
  'mc.e.err.ss_no_audio.active': 'Video continues on the degraded fallback.',
  'mc.e.err.ss_no_audio.action': 'Re-share with system audio enabled, or accept video-only.',
  'mc.e.err.camera_disconnected.title': 'Disconnected camera',
  'mc.e.err.camera_disconnected.what': 'The selected camera feed dropped.',
  'mc.e.err.camera_disconnected.active': 'Prior content remains.',
  'mc.e.err.camera_disconnected.action': 'Re-select the camera or restore prior content.',
  'mc.e.err.failed_layout.title': 'Failed layout',
  'mc.e.err.failed_layout.what': 'The layout change could not be applied.',
  'mc.e.err.failed_layout.active': 'The previous layout remains active.',
  'mc.e.err.failed_layout.action': 'Retry the layout change or restore the previous layout.',
  'mc.e.err.peertube_unavailable.title': 'PeerTube unavailable',
  'mc.e.err.peertube_unavailable.what': 'The PeerTube recording service is not reachable.',
  'mc.e.err.peertube_unavailable.active': 'The classroom program continues.',
  'mc.e.err.peertube_unavailable.action': 'Retry recording later or check PeerTube status.',
  'mc.e.err.obs_unavailable.title': 'OBS unavailable',
  'mc.e.err.obs_unavailable.what': 'OBS / AI Director is not reachable.',
  'mc.e.err.obs_unavailable.active': 'Displays continue independently of the livestream.',
  'mc.e.err.obs_unavailable.action': 'Check OBS and the AI Director, then retry the livestream action.',
  'mc.e.err.recording_failure.title': 'Recording failure',
  'mc.e.err.recording_failure.what': 'The recording did not start or has stopped unexpectedly.',
  'mc.e.err.recording_failure.active': 'The live program may continue without a recording.',
  'mc.e.err.recording_failure.action': 'Retry the recording or check the recording service.',
  'mc.e.err.revision_mismatch.title': 'Revision mismatch',
  'mc.e.err.revision_mismatch.what': 'The room state changed since you loaded this layout.',
  'mc.e.err.revision_mismatch.active': 'Your change was rejected to avoid overwriting another operator.',
  'mc.e.err.revision_mismatch.action': 'Refresh the room and reapply your change.',
  'mc.e.err.unknown.title': 'Unexpected error',
  'mc.e.err.unknown.what': 'An unexpected operational error occurred.',
  'mc.e.err.unknown.active': 'The room state is preserved.',
  'mc.e.err.unknown.action': 'Retry the action, or refresh if the problem persists.',
};

// Create an i18n resolver that checks the enterprise overlay first, then falls
// back to the existing global `t` (passed in) so non-enterprise keys still work.
export function createEnterpriseI18n(baseT) {
  return function t(key, vars) {
    if (Object.prototype.hasOwnProperty.call(STRINGS, key)) {
      let s = STRINGS[key];
      if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
      return s;
    }
    return typeof baseT === 'function' ? baseT(key, vars) : key;
  };
}

export const enterpriseStrings = STRINGS;
