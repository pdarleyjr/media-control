'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const unzipper = require('unzipper');

const { renderDeckToPptxBuffer } = require('../services/pptx');
const { PROFILE_IDS } = require('../lib/presentation-template-registry');

function deck(profile) {
  return {
    version: 'mbfd-deck-v2', deck_id: 'export-test', title: 'Export Test',
    theme_id: 'mbfd-videowall-v2', wall_profile: profile, template_system_version: '2.0.0',
    course_section: 'Operations', assets: [],
    slides: [{
      id: 'slide_001', template_id: 'STANDARD_PARAGRAPH',
      slots: { TV1_TITLE: 'Editable title', TV1_PARAGRAPH: 'Editable paragraph', GLOBAL_PRESENTATION_TITLE: 'Export Test' },
      speaker_notes: 'Editable speaker notes', duration_seconds: 12,
    }],
  };
}

async function inspect(profile) {
  const buffer = await renderDeckToPptxBuffer(deck(profile));
  assert.ok(Buffer.isBuffer(buffer));
  const zip = await unzipper.Open.buffer(buffer);
  const presentation = await zip.files.find((entry) => entry.path === 'ppt/presentation.xml').buffer();
  const slide = await zip.files.find((entry) => entry.path === 'ppt/slides/slide1.xml').buffer();
  const notes = await zip.files.find((entry) => entry.path === 'ppt/notesSlides/notesSlide1.xml').buffer();
  const media = zip.files.filter((entry) => entry.path.startsWith('ppt/media/'));
  return { presentation: presentation.toString('utf8'), slide: slide.toString('utf8'), notes: notes.toString('utf8'), media };
}

test('v2 PPTX exports exact two-display EMU dimensions with editable text and notes', async () => {
  const output = await inspect(PROFILE_IDS.TWO_DISPLAY);
  assert.match(output.presentation, /<p:sldSz[^>]*cx="32512000"[^>]*cy="9144000"/);
  assert.match(output.slide, /Editable title/);
  assert.match(output.slide, /Editable paragraph/);
  assert.match(output.notes, /Editable speaker notes/);
  assert.ok(output.media.length >= 2, 'approved MBFD logo and watermark must remain embedded');
  assert.doesNotMatch(output.slide, /seam[-_ ]guide|safe[-_ ]area/i);
});

test('v2 PPTX exports exact three-display EMU dimensions', async () => {
  const output = await inspect(PROFILE_IDS.THREE_DISPLAY);
  assert.match(output.presentation, /<p:sldSz[^>]*cx="48768000"[^>]*cy="9144000"/);
});

test('v2 PPTX embeds approved local video and audio as native package media', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-pptx-media-'));
  const videoPath = path.join(temp, 'clip.mp4');
  const audioPath = path.join(temp, 'briefing.mp3');
  fs.writeFileSync(videoPath, Buffer.from('test-video-bytes'));
  fs.writeFileSync(audioPath, Buffer.from('test-audio-bytes'));
  const mediaDeck = deck(PROFILE_IDS.TWO_DISPLAY);
  mediaDeck.slides[0].template_id = 'VIDEO_FOCUS';
  mediaDeck.slides[0].slots = {
    TV1_TITLE: 'Embedded training video',
    TV2_VIDEO: { type: 'video', content_id: 'video-1', caption: 'Training clip' },
  };
  mediaDeck.slides.push({
    id: 'slide_002', template_id: 'VIDEO_FOCUS', speaker_notes: '', duration_seconds: 12,
    slots: {
      TV1_TITLE: 'Embedded radio traffic',
      TV2_VIDEO: { type: 'audio', content_id: 'audio-1', caption: 'Radio traffic' },
    },
  });
  const assets = new Map([
    ['video-1', { path: videoPath, mime: 'video/mp4' }],
    ['audio-1', { path: audioPath, mime: 'audio/mpeg' }],
  ]);
  const buffer = await renderDeckToPptxBuffer(mediaDeck, { resolveContentAsset: async (id) => assets.get(id) || null });
  const zip = await unzipper.Open.buffer(buffer);
  assert.ok(zip.files.some((entry) => /^ppt\/media\/media-.*\.mp4$/.test(entry.path)), 'video must be embedded');
  assert.ok(zip.files.some((entry) => /^ppt\/media\/media-.*\.mp3$/.test(entry.path)), 'audio must be embedded');
  const videoRelationships = (await zip.files.find((entry) => entry.path === 'ppt/slides/_rels/slide1.xml.rels').buffer()).toString('utf8');
  const audioRelationships = (await zip.files.find((entry) => entry.path === 'ppt/slides/_rels/slide2.xml.rels').buffer()).toString('utf8');
  assert.match(videoRelationships, /relationships\/video/);
  assert.match(audioRelationships, /relationships\/audio/);
});
