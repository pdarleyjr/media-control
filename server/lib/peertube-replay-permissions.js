'use strict';

const VISIBILITY = Object.freeze({
  PRIVATE: 'PRIVATE',
  WORKSPACE_SHARED: 'WORKSPACE_SHARED',
  ORGANIZATION_SHARED: 'ORGANIZATION_SHARED',
  PLATFORM_TEMPLATE: 'PLATFORM_TEMPLATE',
});

function isPlatformAdmin(ctx = {}) {
  return ctx.isPlatformAdmin === true || ctx.userRole === 'platform_admin' || ctx.userRole === 'superadmin';
}

function isOrganizationPublisher(ctx = {}) {
  return isPlatformAdmin(ctx) || ctx.orgRole === 'org_owner' || ctx.orgRole === 'org_admin';
}

function isWorkspaceAdmin(ctx = {}) {
  return isOrganizationPublisher(ctx) || ctx.workspaceRole === 'workspace_admin';
}

function isInstructor(ctx = {}) {
  return isWorkspaceAdmin(ctx)
    || (ctx.workspaceRole === 'workspace_editor' && ctx.isRecordingInstructor === true);
}

function canAddReplay(ctx, visibility) {
  if (visibility === VISIBILITY.PLATFORM_TEMPLATE) return isPlatformAdmin(ctx);
  if (visibility === VISIBILITY.ORGANIZATION_SHARED) return isOrganizationPublisher(ctx);
  if (visibility === VISIBILITY.PRIVATE || visibility === VISIBILITY.WORKSPACE_SHARED) return isInstructor(ctx);
  return false;
}

function canDiscardReplay(ctx) {
  return isWorkspaceAdmin(ctx);
}

function canReadReplayMedia(ctx, replay = {}) {
  if (replay.library_visibility === VISIBILITY.PRIVATE) return isInstructor(ctx);
  return Boolean(ctx.workspaceRole || ctx.orgRole || isPlatformAdmin(ctx));
}

function canRequestVisibility(ctx, visibility) {
  if (visibility === VISIBILITY.PLATFORM_TEMPLATE) return isPlatformAdmin(ctx);
  if (visibility === VISIBILITY.ORGANIZATION_SHARED) return isInstructor(ctx);
  return canAddReplay(ctx, visibility);
}

function canApproveOrganizationPublication(ctx) {
  return isOrganizationPublisher(ctx);
}

module.exports = {
  VISIBILITY,
  isPlatformAdmin,
  isOrganizationPublisher,
  isWorkspaceAdmin,
  isInstructor,
  canAddReplay,
  canDiscardReplay,
  canReadReplayMedia,
  canRequestVisibility,
  canApproveOrganizationPublication,
};
