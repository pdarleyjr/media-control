const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const inflight = new Map();

async function getCanvasImageVariant(contentId, sourcePath, width, height, outputDir) {
  const stat = fs.statSync(sourcePath);
  const safeWidth = Math.max(1, Math.min(7680, Math.round(Number(width) || 1920)));
  const safeHeight = Math.max(1, Math.min(4320, Math.round(Number(height) || 1080)));
  const fileName = `canvas_${contentId}_${Math.round(stat.mtimeMs)}_${safeWidth}x${safeHeight}.webp`;
  const outputPath = path.join(outputDir, fileName);
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) return outputPath;
  if (inflight.has(outputPath)) return inflight.get(outputPath);

  const job = (async () => {
    const temporary = `${outputPath}.${process.pid}.tmp`;
    try {
      await sharp(sourcePath, { limitInputPixels: false, failOn: 'none' })
        .rotate()
        .resize(safeWidth, safeHeight, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 88, effort: 4 })
        .toFile(temporary);
      fs.renameSync(temporary, outputPath);
      return outputPath;
    } finally {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    }
  })();
  inflight.set(outputPath, job);
  try {
    return await job;
  } finally {
    inflight.delete(outputPath);
  }
}

module.exports = { getCanvasImageVariant };
