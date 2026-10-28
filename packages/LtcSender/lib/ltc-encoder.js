/**
 * LTC (Linear Timecode) の符号化。
 *
 * 出典:
 * - ビットの割り当て・同期語・位相補正ビット: EBU Tech 3097 (25fps 系) と
 *   https://en.wikipedia.org/wiki/Linear_timecode (24/30 系で位相補正ビットが 27、25 系で 59)
 * - 位相補正ビット: 1 フレーム 80 ビット中の 0 の数が偶数になるように決める (EBU Tech 3097 §4.5)
 * - 波形の端: 10%〜90% の立ち上がり時間。EBU は 50 (+15/-10) µs、端は sine² 形 (EBU Tech 3097)。
 *   SMPTE 系の 25 µs は規格本体 (ST 12-1、有料) ではなくメーカー資料の値 (AEC PCIe-TC マニュアル)
 * - 符号: バイフェーズマーク。各ビットの頭で必ず反転し、1 のときだけビットの真ん中でもう一度反転する
 */
const { tcToFrames, framesToTC } = require('./timecode');

// ビット 64〜79 (送出順)
const SYNC_WORD = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];

// sine² の端で、10%〜90% にかかる時間は端全体の長さの約 0.5903 倍
const SINE2_10_90_RATIO = (2 / Math.PI) * (Math.asin(Math.sqrt(0.9)) - Math.asin(Math.sqrt(0.1)));

const defaultRiseTimeUs = (rate) => (rate.nominal === 25 ? 50 : 25);

/**
 * 1 フレーム分の 80 ビット (送出順、LSB から) を作る
 * @param {{h:number,m:number,s:number,f:number}} tc
 */
const frameBits = (tc, rate) => {
    const bits = new Array(80).fill(0);
    const put = (start, count, value) => {
        for (let i = 0; i < count; i++) bits[start + i] = (value >> i) & 1;
    };
    put(0, 4, tc.f % 10);
    put(8, 2, Math.floor(tc.f / 10));
    bits[10] = rate.drop ? 1 : 0;
    put(16, 4, tc.s % 10);
    put(24, 3, Math.floor(tc.s / 10));
    put(32, 4, tc.m % 10);
    put(40, 3, Math.floor(tc.m / 10));
    put(48, 4, tc.h % 10);
    put(56, 2, Math.floor(tc.h / 10));
    for (let i = 0; i < 16; i++) bits[64 + i] = SYNC_WORD[i];

    const parityBit = rate.nominal === 25 ? 59 : 27;
    const zeros = bits.filter((b, i) => i !== parityBit && b === 0).length;
    // parityBit 自身が 0 なら 0 の数に 1 足される。全体の 0 の数を偶数にする
    bits[parityBit] = zeros % 2 === 0 ? 1 : 0;
    return bits;
};

/**
 * LTC の波形を作る。ファイルの先頭 (0 秒) がちょうど startTC のフレームの頭になる。
 * @param {object} opts
 * @param {{h,m,s,f}} opts.startTC
 * @param {object} opts.rate - timecode.getRate() の戻り値
 * @param {number} opts.seconds - 長さ
 * @param {number} [opts.sampleRate=48000]
 * @param {number} [opts.levelDb=-18] - ピークのレベル (dBFS)
 * @param {number} [opts.riseTimeUs] - 10%〜90% の立ち上がり時間
 * @returns {Float32Array}
 */
const encodeLTC = ({ startTC, rate, seconds, sampleRate = 48000, levelDb = -18, riseTimeUs }) => {
    const amp = Math.pow(10, levelDb / 20);
    const rise = (riseTimeUs ?? defaultRiseTimeUs(rate)) * 1e-6;
    const edge = rise / SINE2_10_90_RATIO; // 端全体の長さ (秒)
    const bitDur = 1 / (rate.actual * 80);
    const total = Math.round(seconds * sampleRate);
    const out = new Float32Array(total);
    const startFrame = tcToFrames(startTC, rate);

    // 反転の時刻を順に作りながら、サンプルを埋める
    let level = -1; // 現在 (直前の反転が終わった後) の極性
    let sample = 0;
    let frameIndex = 0;
    const fill = (until, nextEdgeAt) => {
        // until (秒) の手前までのサンプルを埋める。nextEdgeAt の反転は sine² で滑らかにする
        for (; sample < total; sample++) {
            const t = sample / sampleRate;
            if (t >= until) break;
            const x = (t - (nextEdgeAt - edge / 2)) / edge;
            if (x <= 0) {
                out[sample] = level * amp;
            } else {
                const k = x >= 1 ? 1 : Math.sin((Math.PI / 2) * x) ** 2;
                out[sample] = (level + (-2 * level) * k) * amp;
            }
        }
    };

    const edges = [];
    while (sample < total) {
        const bits = frameBits(framesToTC(startFrame + frameIndex, rate), rate);
        const frameStart = frameIndex / rate.actual;
        edges.length = 0;
        for (let b = 0; b < 80; b++) {
            const t0 = frameStart + b * bitDur;
            edges.push(t0);
            if (bits[b] === 1) edges.push(t0 + bitDur / 2);
        }
        for (const e of edges) {
            // 反転の中心が e。端の後半 (e + edge/2) まで、この反転として扱う
            fill(e + edge / 2, e);
            level = -level;
        }
        frameIndex++;
    }
    return out;
};

module.exports = {
    SYNC_WORD,
    frameBits,
    encodeLTC,
    defaultRiseTimeUs
};
