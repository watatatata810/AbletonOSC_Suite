const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ltcFiles = require('../lib/ltc-files');
const { wavInfo } = require('../lib/wav');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ltcsender-files-'));

/** 16bit ステレオの無音 WAV (曲の代わり) */
const writeStereo16 = (file, seconds, sampleRate = 44100) => {
    const n = Math.round(seconds * sampleRate);
    const data = n * 4;
    const buf = Buffer.alloc(44 + data);
    buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + data, 4); buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
    buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36, 'ascii'); buf.writeUInt32LE(data, 40);
    fs.writeFileSync(file, buf);
};

test('wavInfo: ヘッダーだけで長さが分かる', () => {
    const dir = tmp();
    const file = path.join(dir, 'bgm.wav');
    writeStereo16(file, 3.5);
    const info = wavInfo(file);
    assert.equal(info.sampleRate, 44100);
    assert.equal(info.channels, 2);
    assert.ok(Math.abs(info.seconds - 3.5) < 1e-6);
    fs.rmSync(dir, { recursive: true });
});

test('bgmDuration: WAV でなければクリップの終了位置 (拍) から求める', () => {
    const dir = tmp();
    const file = path.join(dir, 'bgm.mp3');
    fs.writeFileSync(file, 'ID3 not a wav');
    assert.deepEqual(ltcFiles.bgmDuration(file, 240, 120), { seconds: 120, source: 'end_marker' });
    assert.equal(ltcFiles.bgmDuration(null, 0, 120), null);
    fs.rmSync(dir, { recursive: true });
});

test('createLtcFile: 作った直後の検査に合格する', () => {
    const dir = tmp();
    const show = { rate: '29.97DF', levelDb: -18, outputDir: dir };
    const cue = { scene: 12, startTC: '01:00:00;00' };
    const r = ltcFiles.createLtcFile({ show, cue, bgmSeconds: 5.2 });
    assert.equal(path.basename(r.file), 'LTC_S013_01-00-00-00.wav');
    assert.equal(r.fileSeconds, 16);
    assert.equal(r.fileCheck.ok, true, r.fileCheck.problems.join(' / '));
    assert.equal(r.fileCheck.firstTC, '01:00:00;00');
    fs.rmSync(dir, { recursive: true });
});

test('verifyLtcFile: 開始時刻が違うファイルは不合格', () => {
    const dir = tmp();
    const show = { rate: '25', levelDb: -18, outputDir: dir };
    const r = ltcFiles.createLtcFile({ show, cue: { scene: 0, startTC: '02:00:00:00' }, bgmSeconds: 1 });
    const tc = require('../lib/timecode');
    const check = ltcFiles.verifyLtcFile(r.file, tc.parseTC('03:00:00:00'), tc.getRate('25'), r.fileSeconds);
    assert.equal(check.ok, false);
    assert.ok(check.problems[0].includes('開始時刻'));
    fs.rmSync(dir, { recursive: true });
});

test('出力フォルダが未設定なら作らない', () => {
    assert.throws(() => ltcFiles.createLtcFile({ show: { rate: '25', outputDir: '' }, cue: { scene: 0, startTC: '01:00:00:00' }, bgmSeconds: 1 }));
});
