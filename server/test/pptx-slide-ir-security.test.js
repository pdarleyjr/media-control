'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PptxGenJS = require('pptxgenjs');
const unzipper = require('unzipper');
const {
  extractPptxToSlideIr,
  validateEntryName,
  validateRelationshipTarget,
  validateXml,
} = require('../services/pptx-slide-ir');
const { renderComplexSlideFallbacks } = require('../services/presentation-conversion-job');

test('package guards reject traversal, unsafe links, and active XML declarations', () => {
  for (const name of ['../escape.xml', '/absolute.xml', 'ppt/../../escape.xml', 'C:\\escape.xml']) {
    assert.throws(() => validateEntryName(name), /unsafe|path|entry/i);
  }
  assert.throws(() => validateRelationshipTarget('file:///etc/passwd', 'External'), /unsafe|protocol/i);
  assert.throws(() => validateRelationshipTarget('javascript:alert(1)', 'External'), /unsafe|protocol/i);
  assert.doesNotThrow(() => validateRelationshipTarget('https://www.youtube.com/watch?v=test', 'External'));
  assert.throws(() => validateXml('<!DOCTYPE x [<!ENTITY boom SYSTEM "file:///etc/passwd">]><x>&boom;</x>'), /DOCTYPE|ENTITY|unsafe/i);
});

test('linked local media is inert, path-redacted, and review-flagged instead of aborting conversion', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-slide-ir-linked-media-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const base = path.join(temp, 'base.pptx'); const linked = path.join(temp, 'linked.pptx');
  const pptx = new PptxGenJS(); pptx.addSlide().addText('Linked media source', { x: 1, y: 1, w: 5, h: 1 });
  await pptx.writeFile({ fileName: base });
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(base));
  const relPath = 'ppt/slides/_rels/slide1.xml.rels';
  const relationships = await zip.file(relPath).async('string');
  zip.file(relPath, relationships.replace('</Relationships>', '<Relationship Id="rIdLinkedVideo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="file:///C:/Users/Instructor/Videos/pump.mp4" TargetMode="External"/></Relationships>'));
  fs.writeFileSync(linked, await zip.generateAsync({ type: 'nodebuffer' }));
  const ir = await extractPptxToSlideIr(linked);
  const media = ir.slides[0].elements.find((element) => element.kind === 'video' && element.external);
  assert.ok(media);
  assert.equal(media.url, null);
  assert.doesNotMatch(JSON.stringify(ir), /C:\/Users\/Instructor/i);
  assert.ok(ir.slides[0].warnings.some((warning) => /External linked media unavailable/.test(warning)));
});

test('deterministic PPTX extraction preserves order, prose, bullets, hyperlinks, notes, and dimensions', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-slide-ir-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'fixture.pptx');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  const first = pptx.addSlide();
  first.addText('Training title', { x: 1, y: 0.5, w: 8, h: 0.5 });
  first.addText('Paragraph remains a paragraph.', { x: 1, y: 1.3, w: 8, h: 1 });
  first.addText([
    { text: 'Bullet one', options: { bullet: { code: '2022' }, breakLine: true } },
    { text: 'Bullet two', options: { bullet: { code: '2022' } } },
  ], { x: 1, y: 2.5, w: 8, h: 1.5 });
  first.addText('YouTube', { x: 1, y: 4.5, w: 2, h: 0.4, hyperlink: { url: 'https://www.youtube.com/watch?v=test' } });
  const videoPath = path.join(temp, 'fixture.mp4');
  const audioPath = path.join(temp, 'fixture.mp3');
  fs.writeFileSync(videoPath, Buffer.concat([Buffer.from('000000186674797069736f6d', 'hex'), Buffer.alloc(32, 1)]));
  fs.writeFileSync(audioPath, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32, 2)]));
  first.addMedia({ type: 'video', path: videoPath, x: 9.2, y: .5, w: 1.5, h: 1.2 });
  first.addMedia({ type: 'audio', path: audioPath, x: 9.2, y: 2, w: 1.5, h: 1.2 });
  first.addMedia({ type: 'online', link: 'https://www.youtube.com/embed/test', x: 9.2, y: 3.5, w: 1.5, h: 1.2 });
  first.addNotes('Speaker note survives extraction.');
  const second = pptx.addSlide();
  second.addText('Second slide', { x: 1, y: 1, w: 8, h: 1 });
  await pptx.writeFile({ fileName: file });

  await assert.rejects(
    () => extractPptxToSlideIr(file, { limits: { maxArchiveBytes: 1 } }),
    /archive size exceeds limit/i,
  );

  const ir = await extractPptxToSlideIr(file);
  assert.equal(ir.slides.length, 2);
  assert.equal(ir.slides[0].source_slide_number, 1);
  assert.equal(ir.slides[1].source_slide_number, 2);
  assert.ok(ir.slides[0].elements.some((element) => element.kind === 'paragraph' && /Paragraph remains/.test(element.text)));
  assert.ok(ir.slides[0].elements.some((element) => element.kind === 'bullets' && element.items.includes('Bullet one')));
  assert.ok(ir.slides[0].relationships.some((rel) => rel.kind === 'hyperlink' && rel.target.includes('youtube.com')));
  assert.ok(ir.slides[0].elements.some((element) => element.kind === 'video' && element.asset_ref));
  assert.ok(ir.slides[0].elements.some((element) => element.kind === 'audio' && element.asset_ref));
  assert.ok(ir.slides[0].elements.some((element) => element.kind === 'youtube' && element.url.includes('youtube.com')));
  assert.ok(ir.assets.some((asset) => asset.kind === 'video'));
  assert.ok(ir.assets.some((asset) => asset.kind === 'audio'));
  assert.match(ir.slides[0].speaker_notes, /Speaker note survives/);
  assert.ok(ir.source_dimensions_emu.w > 0);
  assert.ok(ir.source_dimensions_emu.h > 0);

  const zip = await unzipper.Open.file(file);
  assert.ok(zip.files.some((entry) => entry.path === 'ppt/presentation.xml'));
});

test('group and OLE markers become explicit review elements instead of warning-only drops', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-slide-ir-complex-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const base = path.join(temp, 'base.pptx'); const complex = path.join(temp, 'complex.pptx');
  const pptx = new PptxGenJS(); const slide = pptx.addSlide(); slide.addText('Complex source', { x: 1, y: 1, w: 5, h: 1 });
  await pptx.writeFile({ fileName: base });
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(base));
  const original = await zip.file('ppt/slides/slide1.xml').async('string');
  const injected = original.replace('</p:spTree>', '<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm><a:off x="1" y="1"/><a:ext cx="2" cy="2"/></a:xfrm></p:grpSpPr><p:sp><p:txBody><a:p><a:r><a:t>Grouped process</a:t></a:r></a:p></p:txBody></p:sp></p:grpSp><p:oleObj/></p:spTree>');
  zip.file('ppt/slides/slide1.xml', injected);
  fs.writeFileSync(complex, await zip.generateAsync({ type: 'nodebuffer' }));
  const ir = await extractPptxToSlideIr(complex);
  assert.ok(ir.slides[0].elements.some((element) => element.kind === 'group'));
  assert.ok(ir.slides[0].elements.some((element) => element.kind === 'ole'));
  assert.ok(ir.slides[0].warnings.some((warning) => /Grouped shapes/.test(warning)));
  assert.ok(ir.slides[0].warnings.some((warning) => /OLE object/.test(warning)));
});

test('complex source objects use a bounded LibreOffice/PDF rendered fallback when available', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-rendered-fallback-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'complex.pptx'); fs.writeFileSync(source, 'fixture');
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32, 1)]);
  const calls = [];
  const execFile = async (command, args) => {
    calls.push({ command, args });
    if (/libreoffice|soffice/i.test(command)) fs.writeFileSync(path.join(args[args.indexOf('--outdir') + 1], 'complex.pdf'), 'pdf');
    else if (command === 'pdftoppm') fs.writeFileSync(`${args.at(-1)}.png`, png);
    else throw new Error('unexpected renderer');
    return { stdout: '', stderr: '' };
  };
  const ir = { assets: [], slides: [{ source_slide_number: 1, elements: [{ id: 'chart-1', kind: 'chart' }], warnings: [] }] };
  const result = await renderComplexSlideFallbacks(source, ir, temp, { execFile });
  assert.equal(result.length, 1);
  assert.equal(result[0].mime, 'image/png');
  assert.ok(fs.existsSync(result[0].finalPath));
  assert.ok(ir.slides[0].elements.some((element) => element.rendered_fallback === true));
  assert.ok(calls.some((call) => call.command === 'pdftoppm'));
});
