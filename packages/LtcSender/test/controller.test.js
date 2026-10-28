const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { Controller } = require('../lib/controller');
const cues = require('../lib/cues');

const make = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltcsender-ctrl-'));
    const live = Object.assign(new EventEmitter(), { lastMessageAt: 0 });
    const ctrl = new Controller({ live, dataFile: path.join(dir, 'project_data.json'), clipPyPath: path.join(dir, 'clip.py') });
    return { ctrl, dir };
};

test('台帳の変更が検査に落ちたら、書き換える前に戻して保存もしない', () => {
    const { ctrl, dir } = make();
    ctrl.editLedger((data) => cues.createShow(data, 'A'));
    ctrl.editLedger((data, show) => cues.upsertCue(show, { scene: 1, startTC: '01:00:00;00' }));
    assert.throws(() => ctrl.editLedger((data, show) => cues.upsertCue(show, { scene: 2, startTC: '00:01:00;00' })));
    assert.deepEqual(ctrl.show().cues.map((c) => c.scene), [1]);
    assert.deepEqual(cues.load(path.join(dir, 'project_data.json')).shows.A.cues.map((c) => c.scene), [1]);
    fs.rmSync(dir, { recursive: true });
});

test('本番モードでは確認の無い途中再生・飛ばす操作を断る。リハモードでは通す', async () => {
    const { ctrl, dir } = make();
    await assert.rejects(() => ctrl.startFrom(0, 10, false), /確認が必要/);
    await assert.rejects(() => ctrl.jump({ deltaSeconds: 5 }, false), /確認が必要/);
    ctrl.setMode('rehearsal');
    // リハモードでは確認なしで先へ進む (鳴っているシーンが無いので、その理由で断られる)
    const res = await ctrl.jump({ deltaSeconds: 5 }, false);
    assert.equal(res.ok, false);
    assert.match(res.problems[0], /鳴っていません/);
    assert.throws(() => ctrl.setMode('xxx'));
    fs.rmSync(dir, { recursive: true });
});
