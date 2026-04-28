const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Verify a folder belongs to the current user (or null = root, also allowed).
// Returns the row, or null if it exists but isn't owned by the user.
function ownedFolder(req, folderId) {
  if (!folderId) return { id: null };
  if (!UUID_RE.test(folderId)) return null;
  const row = db.prepare('SELECT * FROM content_folders WHERE id = ?').get(folderId);
  if (!row) return null;
  const isAdmin = ['admin', 'superadmin'].includes(req.user.role);
  if (!isAdmin && row.user_id !== req.user.id) return null;
  return row;
}

// List folders for the current user. Returns the full tree as a flat array;
// the client builds the hierarchy from parent_id.
router.get('/', (req, res) => {
  const isAdmin = req.user.role === 'superadmin';
  const rows = isAdmin
    ? db.prepare('SELECT * FROM content_folders ORDER BY name COLLATE NOCASE').all()
    : db.prepare('SELECT * FROM content_folders WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(req.user.id);
  res.json(rows);
});

// Create a folder.
router.post('/', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name.length > 100) return res.status(400).json({ error: 'name too long' });

  const parentId = req.body.parent_id || null;
  if (parentId) {
    const parent = ownedFolder(req, parentId);
    if (!parent || parent.id === null) return res.status(400).json({ error: 'Invalid parent_id' });
  }

  const id = uuidv4();
  db.prepare(
    'INSERT INTO content_folders (id, user_id, parent_id, name) VALUES (?, ?, ?, ?)'
  ).run(id, req.user.id, parentId, name);

  res.status(201).json(db.prepare('SELECT * FROM content_folders WHERE id = ?').get(id));
});

// Rename / move a folder.
router.put('/:id', (req, res) => {
  const folder = ownedFolder(req, req.params.id);
  if (!folder || folder.id === null) return res.status(404).json({ error: 'Folder not found' });

  const updates = [];
  const values = [];

  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'name cannot be empty' });
    if (name.length > 100) return res.status(400).json({ error: 'name too long' });
    updates.push('name = ?');
    values.push(name);
  }

  if (req.body.parent_id !== undefined) {
    const newParent = req.body.parent_id || null;
    if (newParent === folder.id) return res.status(400).json({ error: 'Folder cannot be its own parent' });
    if (newParent) {
      const parent = ownedFolder(req, newParent);
      if (!parent || parent.id === null) return res.status(400).json({ error: 'Invalid parent_id' });
      // Reject cycles: walk up from the new parent and ensure we never hit this folder.
      let cursor = parent;
      const seen = new Set([folder.id]);
      while (cursor && cursor.parent_id) {
        if (seen.has(cursor.parent_id)) {
          return res.status(400).json({ error: 'Move would create a cycle' });
        }
        seen.add(cursor.parent_id);
        cursor = db.prepare('SELECT * FROM content_folders WHERE id = ?').get(cursor.parent_id);
      }
    }
    updates.push('parent_id = ?');
    values.push(newParent);
  }

  if (updates.length === 0) return res.json(folder);

  values.push(folder.id);
  db.prepare(`UPDATE content_folders SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM content_folders WHERE id = ?').get(folder.id));
});

// Delete a folder. Content inside it falls back to root via ON DELETE SET NULL.
// Subfolders cascade-delete; if the user wants to keep them they should move them first.
router.delete('/:id', (req, res) => {
  const folder = ownedFolder(req, req.params.id);
  if (!folder || folder.id === null) return res.status(404).json({ error: 'Folder not found' });

  db.prepare('DELETE FROM content_folders WHERE id = ?').run(folder.id);
  res.json({ success: true });
});

module.exports = router;
