const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.resolve(__dirname, '../../services/podium-agent/src/index.ts'),
  'utf8',
);

test('podium USB discovery recognizes USB transport even when RM is zero', () => {
  assert.match(source, /tran\?: string \| null/);
  assert.match(source, /String\(device\.tran \|\| ''\)\.toLowerCase\(\) === 'usb'/);
  assert.match(source, /inheritedUsbTransport/);
  assert.match(source, /removable = inheritedRemovable \|\| usbTransport \|\| isRemovable\(device\.rm\)/);
  assert.match(source, /NAME,RM,TYPE,MOUNTPOINTS,LABEL,SIZE,MODEL,FSTYPE,TRAN/);
});
