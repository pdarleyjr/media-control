const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { isConvertibleOfficeMime, getOfficePdf, OFFICE_DOC_MIMES } = require('../lib/doc-pdf');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-docpdf-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const hasSoffice = (() => {
  try { require('child_process').execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 5000 }); return true; }
  catch { return false; }
})();

test('isConvertibleOfficeMime accepts the 9 Office/ODF mimes', () => {
  for (const mt of [
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
  ]) {
    assert.equal(isConvertibleOfficeMime(mt), true, `${mt} should convert`);
  }
  assert.equal(OFFICE_DOC_MIMES.size, 9);
});

test('isConvertibleOfficeMime rejects PDF and media types (PDF is served directly)', () => {
  for (const mt of ['application/pdf', 'image/png', 'video/mp4', 'text/html', '']) {
    assert.equal(isConvertibleOfficeMime(mt), false, `${mt} should NOT convert`);
  }
});

test('getOfficePdf throws for a non-convertible mime', async () => {
  await assert.rejects(
    () => getOfficePdf('id-1', __filename, 'application/pdf', { outDir: tmp }),
    /not a convertible office mime/
  );
});

test('getOfficePdf throws when the source file is missing', async () => {
  await assert.rejects(
    () => getOfficePdf('id-2', path.join(tmp, 'nope.pptx'), 'application/vnd.ms-powerpoint', { outDir: tmp }),
    /source file missing/
  );
});

test('getOfficePdf returns a cached PDF without re-converting', async () => {
  // Pre-seed the cache file the way a prior conversion would have. The cache key
  // is `docpdf_<id>_<round(mtimeMs)>.pdf`; reconstruct it from the source mtime
  // so this test never needs LibreOffice.
  const src = path.join(tmp, 'cached.docx');
  fs.writeFileSync(src, 'PK not really a zip, but enough for a stat');
  const id = 'cache-hit-id';
  const mtimeMs = fs.statSync(src).mtimeMs;
  const cached = path.join(tmp, `docpdf_${id}_${Math.round(mtimeMs)}.pdf`);
  fs.writeFileSync(cached, '%PDF-1.4 cached body');

  const out = await getOfficePdf(
    id, src,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    { outDir: tmp }
  );
  assert.equal(out, cached, 'should return the pre-existing cached PDF path');
  assert.equal(fs.readFileSync(out, 'utf8'), '%PDF-1.4 cached body', 'cached file must be untouched');
});

// Real conversion only runs where LibreOffice is installed (the container, not a
// Windows dev box). Build a minimal ODF doc and assert a real PDF comes out.
test('getOfficePdf converts an ODF document to a real PDF (requires LibreOffice)', async (t) => {
  if (!hasSoffice) { t.skip('soffice not installed'); return; }
  const archiver = require('archiver');
  // A complete minimal ODT package LibreOffice reliably opens: the `mimetype`
  // entry stored first (uncompressed), META-INF/manifest.xml, and a content.xml
  // with the full namespace set + office:version.
  const odt = path.join(tmp, 'mini.odt');
  const manifest =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">' +
    '<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.text"/>' +
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
    '</manifest:manifest>';
  const content =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<office:document-content ' +
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
    'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
    'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
    'office:version="1.2">' +
    '<office:body><office:text><text:p>MBFD doc-pdf test</text:p></office:text></office:body>' +
    '</office:document-content>';
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(odt);
    const ar = archiver('zip');
    out.on('close', resolve); ar.on('error', reject); ar.pipe(out);
    ar.append('application/vnd.oasis.opendocument.text', { name: 'mimetype', store: true });
    ar.append(manifest, { name: 'META-INF/manifest.xml' });
    ar.append(content, { name: 'content.xml' });
    ar.finalize();
  });

  const out = await getOfficePdf('odf-real-id', odt, 'application/vnd.oasis.opendocument.text', { outDir: tmp });
  assert.ok(fs.existsSync(out), 'PDF should be produced');
  const head = fs.readFileSync(out).subarray(0, 5).toString('latin1');
  assert.equal(head, '%PDF-', 'output must be a real PDF');
});
