'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  VISIBILITY,
  canAddReplay,
  canDiscardReplay,
  canRequestVisibility,
  canApproveOrganizationPublication,
} = require('../lib/peertube-replay-permissions');

const viewer = { workspaceRole: 'workspace_viewer' };
const instructor = { workspaceRole: 'workspace_editor', isRecordingInstructor: true };
const unrelatedEditor = { workspaceRole: 'workspace_editor', isRecordingInstructor: false };
const workspaceAdmin = { workspaceRole: 'workspace_admin' };
const orgPublisher = { orgRole: 'org_admin', actingAs: true };
const platformAdmin = { isPlatformAdmin: true };

test('viewers cannot mutate replays; instructors can add only private/workspace content', () => {
  assert.equal(canAddReplay(viewer, VISIBILITY.PRIVATE), false);
  assert.equal(canAddReplay(unrelatedEditor, VISIBILITY.PRIVATE), false);
  assert.equal(canAddReplay(instructor, VISIBILITY.PRIVATE), true);
  assert.equal(canAddReplay(instructor, VISIBILITY.WORKSPACE_SHARED), true);
  assert.equal(canAddReplay(instructor, VISIBILITY.ORGANIZATION_SHARED), false);
  assert.equal(canAddReplay(instructor, VISIBILITY.PLATFORM_TEMPLATE), false);
});

test('discard/archive requires workspace administration or a higher role', () => {
  assert.equal(canDiscardReplay(instructor), false);
  assert.equal(canDiscardReplay(workspaceAdmin), true);
  assert.equal(canDiscardReplay(orgPublisher), true);
  assert.equal(canDiscardReplay(platformAdmin), true);
});

test('organization sharing is a request plus approval workflow', () => {
  assert.equal(canRequestVisibility(instructor, VISIBILITY.ORGANIZATION_SHARED), true);
  assert.equal(canApproveOrganizationPublication(instructor), false);
  assert.equal(canApproveOrganizationPublication(workspaceAdmin), false);
  assert.equal(canApproveOrganizationPublication(orgPublisher), true);
  assert.equal(canApproveOrganizationPublication(platformAdmin), true);
});

test('only platform administrators can create platform templates', () => {
  assert.equal(canAddReplay(workspaceAdmin, VISIBILITY.PLATFORM_TEMPLATE), false);
  assert.equal(canAddReplay(orgPublisher, VISIBILITY.PLATFORM_TEMPLATE), false);
  assert.equal(canAddReplay(platformAdmin, VISIBILITY.PLATFORM_TEMPLATE), true);
});
