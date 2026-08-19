'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const unzipper = require('unzipper');
const { getProfile } = require('./presentation-template-registry');

const ALLOWED_NAMES = new Set(['GLOBAL_MBFD_LOGO', 'GLOBAL_MBFD_WATERMARK']);
const MIME_BY_EXT = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'],
]);
const cache = new Map();

function xmlAttributes(fragment) {
  return Object.fromEntries(Array.from(String(fragment || '').matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(["'])(.*?)\2/gs), (match) => [match[1], match[3]]));
}

async function loadAssets(profileId) {
  const profile = getProfile(profileId);
  const archive = await unzipper.Open.file(profile.production_template_path);
  const entries = new Map(archive.files.map((entry) => [entry.path, entry]));
  const slideEntry = entries.get('ppt/slides/slide1.xml');
  const relsEntry = entries.get('ppt/slides/_rels/slide1.xml.rels');
  if (!slideEntry || !relsEntry) throw new Error('Production template is missing its first slide assets');
  const [slideXml, relsXml] = await Promise.all([
    slideEntry.buffer().then((buffer) => buffer.toString('utf8')),
    relsEntry.buffer().then((buffer) => buffer.toString('utf8')),
  ]);
  const relationships = new Map();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const attrs = xmlAttributes(match[1]);
    if (attrs.Id && attrs.Target && !attrs.TargetMode) relationships.set(attrs.Id, attrs.Target);
  }
  const assets = new Map();
  for (const match of slideXml.matchAll(/<p:pic>([\s\S]*?)<\/p:pic>/gi)) {
    const picture = match[1];
    const properties = picture.match(/<p:cNvPr\b([^>]*)>/i);
    const blip = picture.match(/<a:blip\b([^>]*)>/i);
    const name = properties ? xmlAttributes(properties[1]).name : '';
    const relId = blip ? xmlAttributes(blip[1])['r:embed'] : '';
    if (!ALLOWED_NAMES.has(name) || !relationships.has(relId)) continue;
    const target = relationships.get(relId).replace(/\\/g, '/');
    const resolved = path.posix.normalize(path.posix.join('ppt/slides', target));
    if (!resolved.startsWith('ppt/media/')) throw new Error('Production template image escaped media directory');
    const entry = entries.get(resolved);
    const mime = MIME_BY_EXT.get(path.extname(resolved).toLowerCase());
    if (!entry || !mime) throw new Error(`Production template image unavailable: ${name}`);
    const buffer = await entry.buffer();
    assets.set(name, {
      name,
      mime,
      buffer,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    });
  }
  for (const name of ALLOWED_NAMES) if (!assets.has(name)) throw new Error(`Production template is missing ${name}`);
  return assets;
}

function getTemplateAssets(profileId) {
  if (!cache.has(profileId)) cache.set(profileId, loadAssets(profileId).catch((error) => { cache.delete(profileId); throw error; }));
  return cache.get(profileId);
}

async function getTemplateAsset(profileId, name) {
  if (!ALLOWED_NAMES.has(name)) return null;
  return (await getTemplateAssets(profileId)).get(name) || null;
}

module.exports = { ALLOWED_NAMES, getTemplateAssets, getTemplateAsset };
