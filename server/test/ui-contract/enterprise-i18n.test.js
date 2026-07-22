const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { importModule } = require('./lib/esm-bundle.js');

const I18N = path.join(__dirname, '../../../frontend/js/state/enterprise-i18n.js');

test('every operator state meta label key resolves to a non-key string', async () => {
  const m = await importModule(I18N);
  const t = m.createEnterpriseI18n();
  const stateMod = await importModule(path.join(__dirname, '../../../frontend/js/state/operator-state.js'));
  for (const s of stateMod.OPERATOR_STATES) {
    const key = stateMod.OPERATOR_STATE_META[s].labelKey;
    assert.ok(t(key) !== key, `untranslated state label: ${key}`);
  }
});

test('every error recovery key resolves', async () => {
  const m = await importModule(I18N);
  const t = m.createEnterpriseI18n();
  const errMod = await importModule(path.join(__dirname, '../../../frontend/js/state/error-recovery.js'));
  for (const code of Object.values(errMod.ERROR_CODES)) {
    const r = errMod.recoveryForCode(code);
    for (const k of [r.titleKey, r.whatHappenedKey, r.remainsActiveKey, r.actionKey]) {
      assert.ok(t(k) !== k, `untranslated error key: ${k}`);
    }
  }
});

test('layout + content + playback + screen-share + privacy keys resolve', async () => {
  const m = await importModule(I18N);
  const t = m.createEnterpriseI18n();
  const samples = ['mc.e.layout.single', 'mc.e.layout.audio.primary', 'mc.e.content.facet.mine', 'mc.e.pb.next', 'mc.e.ss.degraded', 'mc.e.privacy.delete_blocked', 'mc.e.send.classroom'];
  for (const k of samples) assert.ok(t(k) !== k, `untranslated: ${k}`);
});

test('falls back to a provided base t for unknown keys', async () => {
  const m = await importModule(I18N);
  const t = m.createEnterpriseI18n((k) => `base:${k}`);
  assert.equal(t('some.unknown.key'), 'base:some.unknown.key');
});
