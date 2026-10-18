// Execute the production renderer's cosmetic closures with data-only views: no canvas, browser or GPU. This fork: the
// skin is the catalogue's UnitInfo.skinId (shared/skins.js); 设置「显示其他玩家的皮肤」 hides another seat's (render/app.js skinOf).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderInfo } from '../../public/js/render/app/info.js';
import { OPERATOR_SKINS } from '../../shared/skins.js';

const source = readFileSync(new URL('../../public/js/render/app.js', import.meta.url), 'utf8');
// a real catalogue skin: renderInfo keeps only a skinId of that operator (shared/skins.js skinFor)
const { charId: OP, id: SKIN } = OPERATOR_SKINS[0];
const bodyOf = (name) => {
  const start = source.indexOf(`  function ${name}(`);
  return start < 0 ? '' : source.slice(start, source.indexOf('\n  }', start) + 4);
};

function fixture() {
  const start = source.indexOf('  const skinOf = ');
  const end = source.indexOf('\n\n', source.indexOf('  const shownSkin = ', start));
  const s = source.indexOf('    setSettings(s) {');
  const settingsMethod = source.slice(s, source.indexOf('\n    },', s) + 6).trim();
  const infos = new Map(), views = new Map(), dropped = [];
  const ctx = { myPlayerId: 'p_0' }, settings = { otherSkins: true, quality: 'high' };
  class UnitView {
    constructor(_ctx, info) { this.info = info; }
    setWorld() {}
    setDir() {}
  }
  const factory = new Function('renderInfo', 'ctx', 'settings', 'infos', 'views', 'dropView', 'UnitView', `
    let mode = 'battle', lastPrep = null;
    const board3d = null;
    function resize() {} function syncOfficialFx() {} function heightAt() { return 0; }
    function setPrep() { syncReadOnlyPrepUnits(lastPrep.units); }
    ${source.slice(start, end)}
    ${['applyInfo', 'refreshSkins', 'setMe', 'setSkins', 'syncReadOnlyPrepUnits'].map(bodyOf).join('\n')}
    return { applyInfo, setMe, setSkins: typeof setSkins === 'function' ? setSkins : undefined,
      ${settingsMethod},
      readOnly(units) { mode = 'prep'; lastPrep = { units }; setPrep(); }
    };`);
  const api = factory(renderInfo, ctx, settings, infos, views, (id) => { dropped.push(id); views.delete(id); }, UnitView);
  return { api, infos, views, dropped };
}
const unit = (id, ownerId = 'p_1', skinId = SKIN) => ({ id, uid: id, kind: 'op', side: 'ally', ownerId, skinId, spine: OP });
const shown = (info) => info.skinId ?? null;

test('on → off → on restores loaded skins, including units first received while hidden', () => {
  const { api, infos, dropped } = fixture();
  api.applyInfo(unit(1));
  api.applyInfo(unit(2, 'p_0'));
  api.setSettings({ otherSkins: false });
  api.applyInfo(unit(3));
  assert.equal(shown(infos.get(1)), null);
  assert.equal(shown(infos.get(2)), SKIN);
  api.setSettings({ otherSkins: true });
  assert.equal(shown(infos.get(1)), SKIN);
  assert.equal(shown(infos.get(3)), SKIN);
  assert.deepEqual(dropped, [1, 1, 3]);
});

test('boss partner views refresh immediately when the setting or local identity changes', () => {
  const { api, views } = fixture();
  api.readOnly([unit(1)]);
  assert.equal(shown(views.get('m:1').info), SKIN);
  api.setSettings({ otherSkins: false });
  assert.equal(shown(views.get('m:1').info), null);
  api.setMe('p_1');
  assert.equal(shown(views.get('m:1').info), SKIN);
  api.setMe('p_0');
  assert.equal(shown(views.get('m:1').info), null);
  api.setSettings({ otherSkins: true });
  assert.equal(shown(views.get('m:1').info), SKIN);
});
