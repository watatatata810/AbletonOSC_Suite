const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const tc = require('../lib/timecode');
const { encodeLTC, frameBits } = require('../lib/ltc-encoder');
const { decodeLTC, analyzeContinuity } = require('../lib/ltc-decoder');
const { encodeWav24Mono, parseWav, readChannel, readWavFile } = require('../lib/wav');

const roundTrip = (rateName, start, seconds) => {
    const rate = tc.getRate(rateName);
    const startTC = tc.parseTC(start);
    const samples = encodeLTC({ startTC, rate, seconds });
    // 24bit WAV を経由させて、書き出しと読み込みも一緒に試す
    const wav = parseWav(encodeWav24Mono(samples, 48000));
    const decoded = decodeLTC(readChannel(wav, 0), wav.sampleRate);
    return { rate, startTC, decoded, cont: analyzeContinuity(decoded.frames, rate) };
};

for (const [rateName, start] of [['29.97DF', '00:00:58;00'], ['25', '10:59:58:00'], ['30', '23:59:58:00'], ['24', '01:00:00:00']]) {
    test(`往復 ${rateName}: ${start} から 4 秒、途切れず解読できる`, () => {
        const { rate, startTC, decoded, cont } = roundTrip(rateName, start, 4);
        const first = decoded.frames[0];
        assert.ok(first, 'フレームが 1 つも解読できない');
        // 先頭フレームは同期語が来るまで確定しないので、最初に解読できるのは開始時刻のフレーム
        assert.equal(tc.formatTC(first.tc, rate), tc.formatTC(startTC, rate));
        assert.ok(first.time < 0.001, `先頭フレームの位置 ${first.time}s`);
        assert.equal(first.drop, rate.drop);
        assert.deepEqual(cont.breaks, []);
        // 最後の不完全なフレームを除き、ほぼ全フレームが読める
        assert.ok(decoded.frames.length >= Math.floor(4 * rate.actual) - 1, `frames=${decoded.frames.length}`);
    });
}

test('位相補正ビット: どのフレームも 0 の数が偶数', () => {
    for (const name of ['29.97DF', '25']) {
        const rate = tc.getRate(name);
        for (let n = 0; n < 5000; n += 7) {
            const bits = frameBits(tc.framesToTC(n, rate), rate);
            assert.equal(bits.filter((b) => b === 0).length % 2, 0);
        }
    }
});

test('レベル: 指定したピーク (dBFS) になる', () => {
    const samples = encodeLTC({ startTC: tc.parseTC('01:00:00;00'), rate: tc.getRate('29.97DF'), seconds: 1, levelDb: -18 });
    const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    assert.ok(Math.abs(20 * Math.log10(peak) + 18) < 0.01, `peak=${peak}`);
});

test('立ち上がり時間: 10%〜90% が 25µs 前後 (29.97DF)', () => {
    // 48kHz では 1 サンプル 20.8µs なので、1〜2 サンプルの中に収まることだけ確かめる
    const samples = encodeLTC({ startTC: tc.parseTC('01:00:00;00'), rate: tc.getRate('29.97DF'), seconds: 0.1, sampleRate: 192000 });
    const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    // ファイル先頭の反転は前半が欠けるので、1ms 以降で最初に -peak → +peak へ向かう反転を測る
    let i10 = -1;
    let i90 = -1;
    let i = 192;
    while (samples[i] > -peak * 0.99) i++;
    for (; i < samples.length; i++) {
        const x = (samples[i] / peak + 1) / 2;
        if (i10 < 0 && x >= 0.1) i10 = i;
        if (i90 < 0 && x >= 0.9) { i90 = i; break; }
    }
    const riseUs = ((i90 - i10) / 192000) * 1e6;
    assert.ok(riseUs >= 15 && riseUs <= 35, `rise=${riseUs}µs`);
});

test('実録音: 2026-10-28 に Live の LTC 出力を録音したファイル (8:00 からスクラブで発音)', () => {
    const file = path.join(__dirname, 'fixtures', 'live-scrub-0800.wav');
    const { samples, sampleRate } = readWavFile(file);
    const decoded = decodeLTC(samples, sampleRate);
    const rate = tc.getRate('29.97DF');
    assert.equal(tc.formatTC(decoded.frames[0].tc, rate), '01:08:00;02');
    // 01:00 台 (曲の頭) のフレームは 1 つも無い
    assert.ok(decoded.frames.every((f) => f.tc.h === 1 && f.tc.m === 8));
    assert.deepEqual(analyzeContinuity(decoded.frames, rate).breaks, []);
});
