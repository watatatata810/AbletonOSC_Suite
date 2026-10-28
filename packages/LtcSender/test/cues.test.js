const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cues = require('../lib/cues');

const newShow = () => {
    const data = cues.emptyData();
    cues.createShow(data, 'NBAL', { bgmTrack: 'A ch' });
    return { data, show: data.shows.NBAL };
};

test('保存と読み込みの往復', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltcsender-cues-'));
    const file = path.join(dir, 'project_data.json');
    const { data, show } = newShow();
    cues.upsertCue(show, { scene: 12, sceneName: 'M1', bgmTrack: 'A ch', startTC: '01:00:00;00' });
    cues.save(file, data);
    const back = cues.load(file);
    assert.equal(back.active, 'NBAL');
    assert.equal(cues.getShow(back).cues[0].startTC, '01:00:00;00');
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    fs.rmSync(dir, { recursive: true });
});

test('壊れた台帳は退避して空から始める', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltcsender-cues-'));
    const file = path.join(dir, 'project_data.json');
    fs.writeFileSync(file, '{ broken');
    const orig = console.error;
    console.error = () => {};
    try {
        assert.deepEqual(cues.load(file).shows, {});
    } finally {
        console.error = orig;
    }
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.broken-')).length, 1);
    fs.rmSync(dir, { recursive: true });
});

test('開始時刻を変えると作成済みの LTC ファイルは無効になる', () => {
    const { show } = newShow();
    cues.upsertCue(show, { scene: 12, startTC: '01:00:00;00', file: 'a.wav', fileSeconds: 600, fileCheck: { ok: true } });
    cues.upsertCue(show, { scene: 12, sceneName: 'M1 改' });
    assert.equal(show.cues[0].file, 'a.wav');
    cues.upsertCue(show, { scene: 12, startTC: '02:00:00;00' });
    assert.equal(show.cues[0].file, null);
    assert.equal(show.cues[0].fileCheck, null);
});

test('自動割り振り: シーン順に 1 時間ずつ。24 時を超えたら警告', () => {
    const { show } = newShow();
    for (let s = 30; s >= 0; s--) cues.upsertCue(show, { scene: s, startTC: '00:00:00;00' });
    const warnings = cues.autoAssignHours(show, 1);
    assert.equal(show.cues[0].startTC, '01:00:00;00');
    assert.equal(show.cues[1].startTC, '02:00:00;00');
    assert.equal(show.cues[22].startTC, '23:00:00;00');
    assert.equal(warnings.length, 31 - 23);
});

test('検査: 同じシーンの重複と存在しない時刻', () => {
    const { show } = newShow();
    show.cues.push({ scene: 1, startTC: '00:01:00;00' }, { scene: 1, startTC: '01:00:00;00' });
    const errors = cues.validateShow(show);
    assert.ok(errors.some((e) => e.includes('2 回')));
    assert.ok(errors.some((e) => e.includes('存在しない時刻')));
});
