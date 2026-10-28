const test = require('node:test');
const assert = require('node:assert/strict');
const tc = require('../lib/timecode');

const DF = tc.getRate('29.97DF');
const R25 = tc.getRate('25');
const R30 = tc.getRate('30');

const fmt = (t, rate) => tc.formatTC(t, rate);
const next = (str, rate) => fmt(tc.framesToTC(tc.tcToFrames(tc.parseTC(str), rate) + 1, rate), rate);

test('ドロップフレーム: 10 の倍数でない分の頭は 00 と 01 を飛ばす', () => {
    assert.equal(next('00:00:59;29', DF), '00:01:00;02');
    assert.equal(next('01:07:59;29', DF), '01:08:00;02');
});

test('ドロップフレーム: 10 分の倍数の分は飛ばさない', () => {
    assert.equal(next('00:09:59;29', DF), '00:10:00;00');
    assert.equal(next('00:59:59;29', DF), '01:00:00;00');
});

test('ドロップフレーム: 飛ばされる番号は存在しない時刻として扱う', () => {
    assert.equal(tc.isValidTC(tc.parseTC('00:01:00;00'), DF), false);
    assert.equal(tc.isValidTC(tc.parseTC('00:10:00;00'), DF), true);
    assert.throws(() => tc.tcToFrames(tc.parseTC('00:01:00;01'), DF));
});

test('ドロップフレーム: 1 時間は 107892 フレーム', () => {
    assert.equal(tc.tcToFrames(tc.parseTC('01:00:00;00'), DF), 107892);
});

test('フレーム番号と時刻の往復 (全フレームの一部を抜き取り)', () => {
    for (const rate of [DF, R25, R30, tc.getRate('23.976')]) {
        const day = tc.framesPerDay(rate);
        for (let n = 0; n < day; n += 997) {
            assert.equal(tc.tcToFrames(tc.framesToTC(n, rate), rate), n);
        }
    }
});

test('24 時間で 0 時に戻る', () => {
    assert.equal(next('23:59:59:24', R25), '00:00:00:00');
    assert.equal(next('23:59:59;29', DF), '00:00:00;00');
});

test('実測値と一致: 01:00:00;00 開始のファイルの 480 秒目は 01:07:59;29 の 61% の位置', () => {
    // 2026-10-28 の録音: 480 秒目から鳴らした LTC は、信号の出始めから 12ms 後に
    // 01:08:00;02 のフレームが始まった。残り 0.39 フレーム = 13ms と一致する
    const r = tc.fileTimeToTC(480, tc.parseTC('01:00:00;00'), DF);
    assert.equal(fmt(r.tc, DF), '01:07:59;29');
    assert.ok(Math.abs(r.phase - 0.614) < 0.001, `phase=${r.phase}`);
    assert.equal(fmt(tc.framesToTC(r.frames + 1, DF), DF), '01:08:00;02');
});

test('実測値と一致: 433 秒目は 01:07:13 台 (Start 866 拍 = LTC 01:07:13)', () => {
    const r = tc.fileTimeToTC(433, tc.parseTC('01:00:00;00'), DF);
    assert.equal(fmt(r.tc, DF), '01:07:13;01');
});

test('形式: 区切りはどれでも読める / DF だけ ; で書く', () => {
    assert.deepEqual(tc.parseTC('01.02.03.04'), { h: 1, m: 2, s: 3, f: 4 });
    assert.equal(fmt({ h: 1, m: 2, s: 3, f: 4 }, R25), '01:02:03:04');
    assert.equal(fmt({ h: 1, m: 2, s: 3, f: 4 }, DF), '01:02:03;04');
    assert.throws(() => tc.parseTC('1:2:3'));
});
