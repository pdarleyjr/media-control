'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const MV = require('../player/multiview-core');
const {
  canServePublicContent,
  isGridDependency,
} = require('../lib/public-content-access');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      organization_id TEXT
    );
    CREATE TABLE content (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      access_level TEXT NOT NULL DEFAULT 'private',
      archived_at INTEGER,
      remote_url TEXT
    );
    CREATE TABLE content_template_assignments (
      content_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      PRIMARY KEY (content_id, workspace_id)
    );
    CREATE TABLE playlists (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL
    );
    CREATE TABLE playlist_items (
      playlist_id TEXT NOT NULL,
      content_id TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO workspaces (id, organization_id) VALUES (?, ?)').run('source', 'org-1');
  db.prepare('INSERT INTO workspaces (id, organization_id) VALUES (?, ?)').run('destination', 'org-1');
  db.prepare('INSERT INTO workspaces (id, organization_id) VALUES (?, ?)').run('foreign', 'org-2');
  return db;
}

function gridUrl(contentId) {
  const cells = MV.encodeCells({
    L1: { u: `/api/content/${encodeURIComponent(contentId)}/file`, l: 'Nested asset', k: 'v' },
  });
  return `/player/grid.html?cells=${cells}`;
}

function addContent(db, { id, workspaceId, accessLevel = 'private', remoteUrl = null }) {
  db.prepare(`INSERT INTO content (id, workspace_id, access_level, remote_url)
    VALUES (?, ?, ?, ?)`).run(id, workspaceId, accessLevel, remoteUrl);
  return db.prepare('SELECT * FROM content WHERE id = ?').get(id);
}

function assignGridToWorkspace(db, gridId, workspaceId) {
  const playlistId = `playlist-${workspaceId}`;
  db.prepare('INSERT INTO playlists (id, workspace_id) VALUES (?, ?)').run(playlistId, workspaceId);
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id) VALUES (?, ?)').run(playlistId, gridId);
}

test('organization-shared nested asset is served through a destination grid in the same organization', () => {
  const db = createDb();
  try {
    const asset = addContent(db, {
      id: 'org-asset', workspaceId: 'source', accessLevel: 'organization_shared',
    });
    addContent(db, {
      id: 'destination-grid', workspaceId: 'destination', remoteUrl: gridUrl(asset.id),
    });
    assignGridToWorkspace(db, 'destination-grid', 'destination');

    assert.equal(isGridDependency(db, asset), true);
    assert.equal(canServePublicContent(db, asset), true);
  } finally {
    db.close();
  }
});

test('platform-template nested asset requires an assignment for the grid destination workspace', () => {
  const db = createDb();
  try {
    const asset = addContent(db, {
      id: 'template-asset', workspaceId: 'source', accessLevel: 'platform_template',
    });
    addContent(db, {
      id: 'destination-grid', workspaceId: 'destination', remoteUrl: gridUrl(asset.id),
    });
    assignGridToWorkspace(db, 'destination-grid', 'destination');

    assert.equal(isGridDependency(db, asset), false, 'unassigned templates stay inaccessible');
    db.prepare(`INSERT INTO content_template_assignments (content_id, workspace_id)
      VALUES (?, ?)`).run(asset.id, 'destination');
    assert.equal(isGridDependency(db, asset), true);
    assert.equal(canServePublicContent(db, asset), true);
  } finally {
    db.close();
  }
});

test('grid dependency never grants private or cross-organization nested content', () => {
  const db = createDb();
  try {
    const privateAsset = addContent(db, {
      id: 'private-asset', workspaceId: 'source', accessLevel: 'private',
    });
    const foreignAsset = addContent(db, {
      id: 'foreign-asset', workspaceId: 'foreign', accessLevel: 'organization_shared',
    });
    addContent(db, {
      id: 'destination-grid', workspaceId: 'destination',
      remoteUrl: gridUrl(privateAsset.id),
    });
    addContent(db, {
      id: 'destination-grid-2', workspaceId: 'destination',
      remoteUrl: gridUrl(foreignAsset.id),
    });
    assignGridToWorkspace(db, 'destination-grid', 'destination');
    db.prepare('INSERT INTO playlist_items (playlist_id, content_id) VALUES (?, ?)')
      .run('playlist-destination', 'destination-grid-2');

    assert.equal(canServePublicContent(db, privateAsset), false);
    assert.equal(canServePublicContent(db, foreignAsset), false);
  } finally {
    db.close();
  }
});

test('unassigned or cross-scope grid rows cannot publish an otherwise authorized nested asset', () => {
  const db = createDb();
  try {
    const asset = addContent(db, {
      id: 'template-asset', workspaceId: 'source', accessLevel: 'platform_template',
    });
    db.prepare(`INSERT INTO content_template_assignments (content_id, workspace_id)
      VALUES (?, ?)`).run(asset.id, 'destination');
    addContent(db, {
      id: 'unassigned-grid', workspaceId: 'destination', remoteUrl: gridUrl(asset.id),
    });
    assert.equal(canServePublicContent(db, asset), false, 'a stored but unassigned grid is not public');

    addContent(db, {
      id: 'foreign-private-grid', workspaceId: 'foreign', remoteUrl: gridUrl(asset.id),
    });
    assignGridToWorkspace(db, 'foreign-private-grid', 'destination');
    assert.equal(
      canServePublicContent(db, asset),
      false,
      'a private grid cannot be assigned across workspace scope to publish dependencies',
    );
  } finally {
    db.close();
  }
});
