/**
 * LTC (Linear Timecode) の解読。作った LTC ファイルや、Live の出力を録音したファイルの検査に使う。
 *
 * バイフェーズマーク符号の反転の間隔を「長い = 0」「短い 2 つ = 1」に分類し、
 * 同期語 (ビット 64〜79) が現れた位置から 80 ビットのフレームを切り出す。
 * 順方向の再生だけを扱う (逆再生の同期語は探さない)。
 */
const { SYNC_WORD } = require('./ltc-encoder');
const { tcToFrames, isValidTC, framesPerDay } = require('./timecode');

/** 振幅の 10% のヒステリシスで、符号が反転したサンプル位置を拾う */
const findTransitions = (samples) => {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    const hyst = (peak || 1) * 0.1;
    const edges = [];
    let state = samples[0] > 0 ? 1 : -1;
    for (let i = 0; i < samples.length; i++) {
        const v = samples[i];
        if (state < 0 && v > hyst) {
            state = 1;
            edges.push(i);
        } else if (state > 0 && v < -hyst) {
            state = -1;
            edges.push(i);
        }
    }
    return { edges, peak };
};

const bcd = (bits, start, count) => {
    let v = 0;
    for (let i = 0; i < count; i++) v |= bits[start + i] << i;
    return v;
};

/**
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {{peak:number, bitSamples:number, frames:Array<{time:number, tc:{h,m,s,f}, drop:boolean}>}}
 */
const decodeLTC = (samples, sampleRate) => {
    const { edges, peak } = findTransitions(samples);
    const gaps = [];
    for (let i = 1; i < edges.length; i++) gaps.push(edges[i] - edges[i - 1]);
    if (gaps.length < 160) return { peak, bitSamples: 0, frames: [] };

    const sorted = [...gaps].sort((a, b) => a - b);
    const longGap = sorted[Math.floor(sorted.length * 0.9)]; // 長い間隔 ≒ 1 ビット
    const thr = longGap * 0.75;

    // bits[i] は 0 / 1 / null (途切れ・判別不能)。at[i] はそのビットの頭のサンプル位置
    const bits = [];
    const at = [];
    for (let i = 0; i < gaps.length;) {
        const g = gaps[i];
        if (g > longGap * 1.5) {
            bits.push(null);
            at.push(edges[i]);
            i++;
        } else if (g >= thr) {
            bits.push(0);
            at.push(edges[i]);
            i++;
        } else if (i + 1 < gaps.length && gaps[i + 1] < thr) {
            bits.push(1);
            at.push(edges[i]);
            i += 2;
        } else {
            bits.push(null);
            at.push(edges[i]);
            i++;
        }
    }

    const frames = [];
    for (let j = 79; j < bits.length; j++) {
        let isSync = true;
        for (let k = 0; k < 16; k++) {
            if (bits[j - 15 + k] !== SYNC_WORD[k]) {
                isSync = false;
                break;
            }
        }
        if (!isSync) continue;
        const fb = bits.slice(j - 79, j - 15);
        if (fb.length !== 64 || fb.some((b) => b === null)) continue;
        frames.push({
            time: at[j - 79] / sampleRate,
            tc: {
                h: bcd(fb, 48, 4) + 10 * bcd(fb, 56, 2),
                m: bcd(fb, 32, 4) + 10 * bcd(fb, 40, 3),
                s: bcd(fb, 16, 4) + 10 * bcd(fb, 24, 3),
                f: bcd(fb, 0, 4) + 10 * bcd(fb, 8, 2)
            },
            drop: fb[10] === 1
        });
    }
    return { peak, bitSamples: longGap, frames };
};

/**
 * 解読したフレームの連続性を調べる。
 * @param {Array} frames - decodeLTC の frames
 * @param {object} rate - timecode.getRate() の戻り値
 * @returns {{breaks:Array<{at:number, from:object, to:object, deltaFrames:number|null}>, invalid:number}}
 */
const analyzeContinuity = (frames, rate) => {
    const breaks = [];
    let invalid = 0;
    const index = (f) => (isValidTC(f.tc, rate) ? tcToFrames(f.tc, rate) : null);
    for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1];
        const b = frames[i];
        const ia = index(a);
        const ib = index(b);
        if (ib === null) invalid++;
        const dt = b.time - a.time;
        const expectedDt = 1 / rate.actual;
        // 24 時の折り返しをまたいでも、前後どちらに何フレーム動いたかで表す
        const day = framesPerDay(rate);
        const delta = ia !== null && ib !== null ? ((((ib - ia) % day) + day + day / 2) % day) - day / 2 : null;
        if (delta !== 1 || Math.abs(dt - expectedDt) > expectedDt / 2) {
            breaks.push({ at: b.time, from: a.tc, to: b.tc, deltaFrames: delta });
        }
    }
    return { breaks, invalid };
};

module.exports = {
    findTransitions,
    decodeLTC,
    analyzeContinuity
};
