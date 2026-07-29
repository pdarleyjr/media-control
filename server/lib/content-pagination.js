'use strict';

function encodeContentCursor(row) {
  if (!row || !row.id || !Number.isFinite(Number(row.created_at))) return null;
  return Buffer.from(JSON.stringify({
    v: 1,
    folder: String(row.folder || ''),
    created_at: Number(row.created_at),
    id: String(row.id),
  })).toString('base64url');
}

function decodeContentCursor(value) {
  const raw = String(value || '');
  if (!raw || raw.length > 2048) throw new Error('invalid_content_cursor');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid_content_cursor');
  }
  if (parsed?.v !== 1
      || typeof parsed.folder !== 'string'
      || parsed.folder.length > 1000
      || !Number.isFinite(parsed.created_at)
      || typeof parsed.id !== 'string'
      || !parsed.id
      || parsed.id.length > 500) {
    throw new Error('invalid_content_cursor');
  }
  return parsed;
}

function contentCursorPredicate(cursor) {
  return {
    sql: `(
      COALESCE(c.folder, '') > ?
      OR (COALESCE(c.folder, '') = ? AND c.created_at < ?)
      OR (COALESCE(c.folder, '') = ? AND c.created_at = ? AND c.id < ?)
    )`,
    params: [
      cursor.folder,
      cursor.folder,
      cursor.created_at,
      cursor.folder,
      cursor.created_at,
      cursor.id,
    ],
  };
}

function contentFtsQuery(value) {
  const tokens = String(value || '').normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [];
  return tokens.slice(0, 20)
    .map((token) => `"${token.replace(/"/g, '""')}"*`)
    .join(' AND ');
}

module.exports = {
  contentCursorPredicate,
  contentFtsQuery,
  decodeContentCursor,
  encodeContentCursor,
};
