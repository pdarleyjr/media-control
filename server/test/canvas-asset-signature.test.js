const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canvasAssetUrl,
  signCanvasAsset,
  verifyCanvasAsset,
} = require('../lib/canvas-asset-signature');

const values = {
  endpointId: 'canvas-1',
  contentId: 'content-1',
  workspaceId: 'workspace-1',
  secret: 'local-test-secret',
};

test('canvas asset signatures bind endpoint, content, and workspace without exposing a token', () => {
  const signature = signCanvasAsset(values);
  assert.ok(signature.length >= 40);
  assert.equal(verifyCanvasAsset({ ...values, signature }), true);
  assert.equal(verifyCanvasAsset({ ...values, contentId: 'content-2', signature }), false);
  assert.equal(verifyCanvasAsset({ ...values, workspaceId: 'workspace-2', signature }), false);

  const url = canvasAssetUrl({ ...values, publicBase: 'https://media.example.test/' });
  assert.match(url, /^https:\/\/media\.example\.test\/player\/canvas-asset\/canvas-1\/content-1\//);
  assert.equal(url.includes(values.secret), false);
});
