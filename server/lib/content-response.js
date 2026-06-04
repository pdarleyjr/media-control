function contentRowsWithThumbnailUrls(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    ...row,
    thumbnail_url: row && row.thumbnail_path ? `/api/content/${row.id}/thumbnail` : null,
  }));
}

module.exports = { contentRowsWithThumbnailUrls };
