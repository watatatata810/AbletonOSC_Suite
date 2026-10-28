/**
 * LTC ファイルの作成と検査。
 *
 * 曲の長さ + 余白の LTC を WAV に書き、書いた直後に読み戻して解読し、
 * 開始時刻・途切れ・長さを確かめてから「作成済み」とする。
 */
const fs = require('fs');
const path = require('path');
const tc = require('./timecode');
const { encodeLTC } = require('./ltc-encoder');
const { decodeLTC, analyzeContinuity } = require('./ltc-decoder');
const { encodeWav24Mono, readWavFile, wavInfo } = require('./wav');

const SAMPLE_RATE = 48000;
const MARGIN_SECONDS = 10;

/**
 * 曲の長さ (秒)。WAV ならヘッダーから。読めなければ Live のクリップの終わりの位置 (拍) から
 * @param {string|null} filePath - BGM クリップの file_path
 * @param {number|null} endBeats - BGM クリップの終わりの位置 (seek.clipEndBeats)
 * @param {number} tempo
 * @returns {{seconds:number, source:'wav'|'end_marker'}|null}
 */
const bgmDuration = (filePath, endBeats, tempo) => {
    if (filePath) {
        try {
            const info = wavInfo(filePath);
            if (info) return { seconds: info.seconds, source: 'wav' };
        } catch (err) {
            // Live が開いていて読めない等。下の代わりの方法に回す
        }
    }
    if (endBeats > 0 && tempo > 0) return { seconds: endBeats * 60 / tempo, source: 'end_marker' };
    return null;
};

const fileNameFor = (cue) => {
    const scene = String(cue.scene + 1).padStart(3, '0');
    return `LTC_S${scene}_${cue.startTC.replace(/[:;.]/g, '-')}.wav`;
};

/**
 * LTC ファイルを読み戻して検査する
 * @returns {{ok:boolean, problems:string[], firstTC:string|null, frames:number, seconds:number}}
 */
const verifyLtcFile = (filePath, startTC, rate, expectedSeconds) => {
    const { samples, sampleRate } = readWavFile(filePath);
    const decoded = decodeLTC(samples, sampleRate);
    const problems = [];
    const first = decoded.frames[0];
    const firstTC = first ? tc.formatTC(first.tc, rate) : null;
    if (!first) {
        problems.push('LTC を解読できません');
    } else {
        if (firstTC !== tc.formatTC(startTC, rate)) problems.push(`開始時刻が違います (${firstTC})`);
        if (first.time > 0.001) problems.push(`先頭のフレームが ${first.time.toFixed(4)} 秒遅れています`);
        if (first.drop !== rate.drop) problems.push('ドロップフレームの印が設定と違います');
    }
    const cont = analyzeContinuity(decoded.frames, rate);
    if (cont.breaks.length > 0) problems.push(`途切れが ${cont.breaks.length} か所あります`);
    const seconds = samples.length / sampleRate;
    if (Math.abs(seconds - expectedSeconds) > 0.01) problems.push(`長さが違います (${seconds.toFixed(3)} 秒)`);
    // 末尾の不完全な 1 フレームを除いて全部読めているか
    if (decoded.frames.length < Math.floor(expectedSeconds * rate.actual) - 1) {
        problems.push(`読めたフレームが少なすぎます (${decoded.frames.length})`);
    }
    return { ok: problems.length === 0, problems, firstTC, frames: decoded.frames.length, seconds };
};

/**
 * @param {object} opts
 * @param {object} opts.show - 台帳のショー (rate, levelDb, outputDir)
 * @param {object} opts.cue - 台帳のシーン (scene, startTC)
 * @param {number} opts.bgmSeconds - 曲の長さ
 * @returns {{file:string, fileSeconds:number, fileCheck:object}}
 */
const createLtcFile = ({ show, cue, bgmSeconds }) => {
    if (!show.outputDir) throw new Error('LTC ファイルの出力フォルダが設定されていません');
    const rate = tc.getRate(show.rate);
    const startTC = tc.parseTC(cue.startTC);
    const seconds = Math.ceil(bgmSeconds + MARGIN_SECONDS);
    fs.mkdirSync(show.outputDir, { recursive: true });
    const file = path.join(show.outputDir, fileNameFor(cue));
    const samples = encodeLTC({ startTC, rate, seconds, sampleRate: SAMPLE_RATE, levelDb: show.levelDb });
    fs.writeFileSync(file, encodeWav24Mono(samples, SAMPLE_RATE));
    const check = verifyLtcFile(file, startTC, rate, seconds);
    return { file, fileSeconds: seconds, fileCheck: { ...check, checkedAt: new Date().toISOString() } };
};

module.exports = {
    SAMPLE_RATE,
    MARGIN_SECONDS,
    bgmDuration,
    fileNameFor,
    verifyLtcFile,
    createLtcFile
};
