'use strict';

const VISIBILITY = Object.freeze({
  PRIVATE: 'private',
  WORKSPACE_SHARED: 'workspace_shared',
  ORGANIZATION_SHARED: 'organization_shared',
  PLATFORM_TEMPLATE: 'platform_template',
});

const VISIBILITY_VALUES = Object.freeze(Object.values(VISIBILITY));
const MIGRATION_ID = 'content_visibility_v1';

function isPlatform(ctx) {
  return ctx?.isPlatformAdmin === true
    || ctx?.userRole === 'platform_admin'
    || ctx?.userRole === 'superadmin';
}

function isOrgAdmin(ctx) {
  return ctx?.orgRole === 'org_owner' || ctx?.orgRole === 'org_admin';
}

function isWorkspaceAdmin(ctx) {
  return ctx?.workspaceRole === 'workspace_admin';
}

function contextFromRequest(req, overrides = {}) {
  return {
    userId: req?.user?.id || null,
    userRole: req?.user?.role || null,
    workspaceId: req?.workspaceId || null,
    organizationId: req?.organizationId || null,
    workspaceRole: req?.workspaceRole || null,
    orgRole: req?.orgRole || null,
    isPlatformAdmin: req?.isPlatformAdmin === true
      || req?.user?.role === 'platform_admin'
      || req?.user?.role === 'superadmin',
    ...overrides,
  };
}

function normalizeVisibility(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return VISIBILITY_VALUES.includes(normalized) ? normalized : null;
}

function addColumn(db, table, name, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === name);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function applyContentVisibilityMigration(db) {
  const apply = db.transaction(() => {
    const firstRun = !db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MIGRATION_ID);
    addColumn(db, 'content', 'published_at', 'INTEGER');
    addColumn(db, 'content', 'published_by', 'TEXT');
    addColumn(db, 'content', 'source_content_id', 'TEXT REFERENCES content(id) ON DELETE SET NULL');
    addColumn(db, 'content', 'version', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'content', 'archived_at', 'INTEGER');

    const unclassifiedGlobal = db.prepare(`
      SELECT COUNT(*) AS count
      FROM content
      WHERE workspace_id IS NULL
        AND COALESCE(access_level, '') <> ?
    `).get(VISIBILITY.PLATFORM_TEMPLATE);
    if (Number(unclassifiedGlobal?.count) > 0) {
      throw new Error(
        `refusing governed-content migration: ${unclassifiedGlobal.count} global content row(s) require explicit platform_template classification`,
      );
    }

    // Preserve only rows already explicitly classified as templates. Never
    // infer template visibility from workspace_id IS NULL alone.
    db.prepare(`
      UPDATE content
      SET access_level = CASE
        WHEN access_level IN (?, ?, ?, ?) THEN access_level
        ELSE ?
      END
    `).run(
      VISIBILITY.PRIVATE,
      VISIBILITY.WORKSPACE_SHARED,
      VISIBILITY.ORGANIZATION_SHARED,
      VISIBILITY.PLATFORM_TEMPLATE,
      VISIBILITY.PRIVATE,
    );

    db.exec(`
      CREATE TABLE IF NOT EXISTS content_publication_requests (
        id                  TEXT PRIMARY KEY,
        content_id          TEXT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
        requested_by        TEXT NOT NULL REFERENCES users(id),
        requested_visibility TEXT NOT NULL DEFAULT 'organization_shared'
          CHECK (requested_visibility = 'organization_shared'),
        status              TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
        decided_by          TEXT REFERENCES users(id),
        decision_reason     TEXT,
        requested_version   INTEGER NOT NULL DEFAULT 1,
        requested_sha256    TEXT,
        decided_at          INTEGER,
        created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE IF NOT EXISTS content_template_assignments (
        content_id   TEXT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        assigned_by  TEXT REFERENCES users(id),
        assigned_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (content_id, workspace_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_content_publication_request_pending
        ON content_publication_requests(content_id)
        WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_content_visibility_workspace
        ON content(workspace_id, access_level, archived_at, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_content_visibility_owner
        ON content(user_id, access_level, archived_at, created_at DESC);

      CREATE TRIGGER IF NOT EXISTS trg_content_visibility_insert
      BEFORE INSERT ON content
      WHEN NEW.access_level IS NULL OR NEW.access_level NOT IN
        ('private', 'workspace_shared', 'organization_shared', 'platform_template')
      BEGIN
        SELECT RAISE(ABORT, 'invalid content visibility');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_content_visibility_update
      BEFORE UPDATE OF access_level ON content
      WHEN NEW.access_level IS NULL OR NEW.access_level NOT IN
        ('private', 'workspace_shared', 'organization_shared', 'platform_template')
      BEGIN
        SELECT RAISE(ABORT, 'invalid content visibility');
      END;
    `);
    addColumn(db, 'content_publication_requests', 'requested_version', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'content_publication_requests', 'requested_sha256', 'TEXT');
    if (firstRun) {
      db.prepare(`INSERT OR IGNORE INTO content_template_assignments (content_id, workspace_id, assigned_by)
        SELECT c.id, w.id, c.user_id
        FROM content c CROSS JOIN workspaces w
        WHERE c.access_level = 'platform_template'`).run();
    }
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MIGRATION_ID);
  });
  apply();
}

function contentVisibilityScope(ctx, options = {}) {
  const alias = /^[A-Za-z_][A-Za-z0-9_]*$/.test(options.alias || '') ? options.alias : 'content';
  const includeArchived = options.includeArchived === true;
  const prefix = `${alias}.`;

  if (isPlatform(ctx)) {
    return {
      clause: includeArchived ? '1 = 1' : `${prefix}archived_at IS NULL`,
      params: [],
    };
  }

  const clauses = [];
  const params = [];

  if (ctx?.workspaceId) {
    clauses.push(`(${prefix}access_level = '${VISIBILITY.PLATFORM_TEMPLATE}' AND EXISTS (
      SELECT 1 FROM content_template_assignments visibility_template
      WHERE visibility_template.content_id = ${prefix}id AND visibility_template.workspace_id = ?
    ))`);
    params.push(ctx.workspaceId);
  }

  if (ctx?.workspaceId && ctx?.userId) {
    clauses.push(`(${prefix}workspace_id = ? AND ${prefix}user_id = ?)`);
    params.push(ctx.workspaceId, ctx.userId);
    clauses.push(`(${prefix}workspace_id = ? AND ${prefix}access_level = '${VISIBILITY.WORKSPACE_SHARED}')`);
    params.push(ctx.workspaceId);
  }

  if (ctx?.organizationId) {
    clauses.push(`(${prefix}access_level = '${VISIBILITY.ORGANIZATION_SHARED}' AND EXISTS (
      SELECT 1 FROM workspaces visibility_ws
      WHERE visibility_ws.id = ${prefix}workspace_id AND visibility_ws.organization_id = ?
    ))`);
    params.push(ctx.organizationId);
  }

  if (isWorkspaceAdmin(ctx) && ctx?.workspaceId) {
    clauses.push(`${prefix}workspace_id = ?`);
    params.push(ctx.workspaceId);
  }

  if (isOrgAdmin(ctx) && ctx?.organizationId) {
    clauses.push(`EXISTS (
      SELECT 1 FROM workspaces visibility_admin_ws
      WHERE visibility_admin_ws.id = ${prefix}workspace_id AND visibility_admin_ws.organization_id = ?
    )`);
    params.push(ctx.organizationId);
  }

  const visible = clauses.length ? `(${clauses.join(' OR ')})` : '0 = 1';
  return {
    clause: includeArchived ? visible : `(${prefix}archived_at IS NULL AND ${visible})`,
    params,
  };
}

function sameWorkspace(content, ctx) {
  return !!content?.workspace_id && content.workspace_id === ctx?.workspaceId;
}

function sameOrganization(content, ctx) {
  return !!content?.organization_id && content.organization_id === ctx?.organizationId;
}

function canReadContent(content, ctx) {
  if (!content || !ctx) return false;
  if (content.archived_at != null && ctx.includeArchived !== true) return false;
  if (isPlatform(ctx)) return true;
  const visibility = normalizeVisibility(content.access_level) || VISIBILITY.PRIVATE;
  if (visibility === VISIBILITY.PLATFORM_TEMPLATE) return content.template_assigned === true || content.template_assigned === 1;
  if (content.user_id && content.user_id === ctx.userId && sameWorkspace(content, ctx)) return true;
  if (isOrgAdmin(ctx) && sameOrganization(content, ctx)) return true;
  if (isWorkspaceAdmin(ctx) && sameWorkspace(content, ctx)) return true;
  if (visibility === VISIBILITY.WORKSPACE_SHARED) return sameWorkspace(content, ctx);
  if (visibility === VISIBILITY.ORGANIZATION_SHARED) return sameOrganization(content, ctx);
  return false;
}

function canUseContentInWorkspace(content, ctx) {
  if (!content || !ctx?.workspaceId || content.archived_at != null) return false;
  if (isPlatform(ctx)) return true;
  const visibility = normalizeVisibility(content.access_level) || VISIBILITY.PRIVATE;
  if (visibility === VISIBILITY.PLATFORM_TEMPLATE) {
    return content.template_assigned === true || content.template_assigned === 1;
  }
  if (visibility === VISIBILITY.ORGANIZATION_SHARED) {
    return sameOrganization(content, ctx);
  }
  if (!sameWorkspace(content, ctx)) return false;
  if (visibility === VISIBILITY.WORKSPACE_SHARED) return true;
  if (visibility === VISIBILITY.PRIVATE) {
    return content.user_id === ctx.userId || isWorkspaceAdmin(ctx) || (isOrgAdmin(ctx) && sameOrganization(content, ctx));
  }
  return false;
}

function contentUseDecision(db, contentId, targetWorkspaceId, ctx = {}) {
  const target = db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(targetWorkspaceId);
  if (!target) return { allowed: false, reason: 'Target workspace not found', content: null };
  const content = db.prepare(`
    SELECT c.*, source_ws.organization_id,
      EXISTS (
        SELECT 1 FROM content_template_assignments cta
        WHERE cta.content_id = c.id AND cta.workspace_id = ?
      ) AS template_assigned
    FROM content c
    LEFT JOIN workspaces source_ws ON source_ws.id = c.workspace_id
    WHERE c.id = ?
  `).get(targetWorkspaceId, contentId);
  if (!content) return { allowed: false, reason: 'Content not found', content: null };
  const useCtx = { ...ctx, workspaceId: targetWorkspaceId, organizationId: target.organization_id };
  if (!canUseContentInWorkspace(content, useCtx)) {
    return { allowed: false, reason: 'Content is not available in the target workspace', content };
  }
  return { allowed: true, reason: null, content };
}

function contentCapabilities(content, ctx) {
  const platform = isPlatform(ctx);
  const orgAdmin = isOrgAdmin(ctx) && sameOrganization(content, ctx);
  const workspaceAdmin = isWorkspaceAdmin(ctx) && sameWorkspace(content, ctx);
  const owner = !!content?.user_id && content.user_id === ctx?.userId && sameWorkspace(content, ctx);
  const workspaceWriter = ctx?.workspaceRole === 'workspace_admin'
    || ctx?.workspaceRole === 'workspace_editor';
  const ownerWriter = owner && workspaceWriter;
  const template = content?.access_level === VISIBILITY.PLATFORM_TEMPLATE;
  const canManage = platform || orgAdmin || workspaceAdmin || ownerWriter;

  let allowedVisibilities = [];
  if (platform) {
    allowedVisibilities = [...VISIBILITY_VALUES];
  } else if (orgAdmin) {
    allowedVisibilities = [VISIBILITY.PRIVATE, VISIBILITY.WORKSPACE_SHARED, VISIBILITY.ORGANIZATION_SHARED];
  } else if (workspaceAdmin || ownerWriter) {
    allowedVisibilities = [VISIBILITY.PRIVATE, VISIBILITY.WORKSPACE_SHARED];
  }

  return {
    isOwner: owner,
    canRead: canReadContent(content, ctx),
    canEditMetadata: canManage && (!template || platform),
    canChangeVisibility: allowedVisibilities.length > 0 && (!template || platform),
    allowedVisibilities,
    canRequestOrganization: ownerWriter && !platform && !orgAdmin && !template,
    canDuplicate: canReadContent(content, ctx) && (platform || orgAdmin || workspaceWriter),
    canArchive: canManage && (!template || platform),
    // Permanent removal is a second, explicit lifecycle step after archive.
    // This keeps an operator from destroying an active asset with one click.
    canDelete: canManage && content.archived_at != null && (!template || platform),
    canTransfer: (platform || orgAdmin || workspaceAdmin) && !template,
    canReviewPublicationRequests: platform || orgAdmin,
  };
}

module.exports = {
  VISIBILITY,
  VISIBILITY_VALUES,
  MIGRATION_ID,
  normalizeVisibility,
  contextFromRequest,
  applyContentVisibilityMigration,
  contentVisibilityScope,
  canReadContent,
  canUseContentInWorkspace,
  contentUseDecision,
  contentCapabilities,
};
