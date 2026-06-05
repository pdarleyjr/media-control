'use strict';

const CLASSROOM_1_SMARTBOARD_PROFILE = Object.freeze({
  id: 'classroom_1_smartboard_jaszdot_86',
  roomLabel: 'Classroom 1 Smartboard',
  deviceFamily: 'JASZDOT interactive flat panel',
  displayClass: '86-class-4k-16x9-touch',
  nativeResolution: { width: 3840, height: 2160 },
  targetRefreshHz: 60,
  inputMode: 'multi-touch-ir',
  maxTouchPoints: 20,
  minTouchTargetPx: 64,
  preferredRuntime: ['android_browser_kiosk', 'external_pc_hdmi_usb_touch'],
  layoutPolicy: 'fullscreen-no-scroll-touch-first',
  safeAreaPx: { top: 32, right: 48, bottom: 48, left: 48 },
  performanceTier: '4k60-moderate-android-8gb',
  featureFlags: {
    touchFirstDashboard: true,
    kioskFullscreen: true,
    noScrollMode: true,
    largeHitTargets: true,
    multiTouchGestures: true,
    whiteboardOverlayButton: true,
    reducedEffectsDefault: true,
    instructorQuickControlsVisible: true,
  },
});

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isClassroom1Smartboard(device) {
  if (!device) return false;
  const id = String(device.id || '').trim().toLowerCase();
  const profileId = String(device.display_profile_id || '').trim().toLowerCase();
  const name = normalizeName(device.name);
  return id === 'classroom_1_smartboard' ||
    profileId === CLASSROOM_1_SMARTBOARD_PROFILE.id ||
    name === 'classroom 1 smartboard';
}

function profileForDevice(device) {
  return isClassroom1Smartboard(device) ? CLASSROOM_1_SMARTBOARD_PROFILE : null;
}

module.exports = {
  CLASSROOM_1_SMARTBOARD_PROFILE,
  isClassroom1Smartboard,
  profileForDevice,
};
