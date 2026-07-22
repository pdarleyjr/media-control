const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('content library exposes governed filters and capability-driven actions', () => {
  const source = read('frontend/js/views/content-library.js');
  for (const marker of [
    'contentVisibilityFilter',
    'contentTypeFilter',
    'contentMineFilter',
    'contentArchivedFilter',
    'permissions?.can_edit',
    'permissions?.can_duplicate',
    'permissions?.can_archive',
    'permissions?.can_transfer',
    'permissions?.can_request_organization',
    'allowed_visibilities',
    'publication_request_status',
    'data-review-publications',
  ]) assert.match(source, new RegExp(marker.replace(/[?.]/g, '\\$&')));
});

test('content API exposes visibility lifecycle operations and retains conflict details', () => {
  const source = read('frontend/js/api.js');
  for (const marker of [
    'getGovernedContent',
    'requestContentPublication',
    'duplicateContent',
    'archiveContent',
    'getContentUsage',
    'getPublicationRequests',
    'reviewPublicationRequest',
    'transferContent',
    'getTemplateAssignments',
    'updateTemplateAssignments',
    'error.details',
  ]) assert.match(source, new RegExp(marker.replace(/[?.]/g, '\\$&')));
});

test('content library implements ownership transfer and template assignment modals', () => {
  const source = read('frontend/js/views/content-library.js');
  for (const marker of [
    'async function showTransferModal',
    'api.getWorkspaceMembers',
    'api.transferContent',
    'async function showTemplateAssignmentsModal',
    'api.getTemplateAssignments',
    'api.updateTemplateAssignments',
  ]) assert.match(source, new RegExp(marker.replace(/[?.]/g, '\\$&')));
});

test('English and Spanish locales name all four visibility levels', () => {
  for (const file of ['frontend/js/i18n/en.js', 'frontend/js/i18n/es.js']) {
    const source = read(file);
    for (const level of ['private', 'workspace_shared', 'organization_shared', 'platform_template']) {
      assert.match(source, new RegExp(`content\\.visibility\\.${level}`));
    }
  }
});
