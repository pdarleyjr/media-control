const { signedContentAssetUrl } = require('./content-asset-signature');

function contentRowsWithThumbnailUrls(rows, options = {}) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    ...row,
    thumbnail_url: row && row.thumbnail_path
      ? (/^https?:\/\//i.test(row.thumbnail_path)
        ? row.thumbnail_path
        : options.secret
        ? signedContentAssetUrl(row.id, 'thumbnail', options.secret, options)
        : `/api/content/${row.id}/thumbnail`)
      : null,
    ...(row && row.filepath ? {
      file_url: options.secret
        ? signedContentAssetUrl(row.id, 'file', options.secret, options)
        : `/api/content/${row.id}/file`,
    } : {}),
  }));
}

module.exports = { contentRowsWithThumbnailUrls };
