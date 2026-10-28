/**
 * SMPTE タイムコードの計算。
 *
 * フレーム番号 (frames) は 00:00:00:00 からの通し番号。ドロップフレーム (DF) では
 * 毎分の頭のフレーム番号 00 と 01 を飛ばす (10 分の倍数の分は飛ばさない) ので、
 * 時刻の表示とフレーム番号は単純な掛け算では対応しない。
 */

// nominal: 時刻表示上の 1 秒のフレーム数 / actual: 実際の 1 秒あたりのフレーム数
const RATES = {
    '23.976': { name: '23.976', nominal: 24, drop: false, actual: 24000 / 1001 },
    '24': { name: '24', nominal: 24, drop: false, actual: 24 },
    '25': { name: '25', nominal: 25, drop: false, actual: 25 },
    '29.97': { name: '29.97', nominal: 30, drop: false, actual: 30000 / 1001 },
    '29.97DF': { name: '29.97DF', nominal: 30, drop: true, actual: 30000 / 1001 },
    '30': { name: '30', nominal: 30, drop: false, actual: 30 }
};

const DF_FRAMES_PER_MIN = 30 * 60 - 2; // 1798
const DF_FRAMES_PER_10MIN = DF_FRAMES_PER_MIN * 10 + 2; // 17982

/**
 * @param {string} name - '23.976' | '24' | '25' | '29.97' | '29.97DF' | '30'
 */
const getRate = (name) => {
    const rate = RATES[name];
    if (!rate) throw new Error(`未対応のフレームレートです: ${name}`);
    return rate;
};

/** 1 日 (24 時間) のフレーム数 */
const framesPerDay = (rate) => {
    if (rate.drop) return DF_FRAMES_PER_10MIN * 6 * 24;
    return rate.nominal * 86400;
};

/**
 * "HH:MM:SS:FF" / "HH:MM:SS;FF" を読む。区切りは ':' ';' '.' のどれでもよい。
 * @returns {{h:number,m:number,s:number,f:number}}
 */
const parseTC = (str) => {
    const m = /^\s*(\d{1,2})[:;.](\d{2})[:;.](\d{2})[:;.](\d{2})\s*$/.exec(String(str));
    if (!m) throw new Error(`タイムコードの形式が正しくありません: ${str}`);
    return { h: Number(m[1]), m: Number(m[2]), s: Number(m[3]), f: Number(m[4]) };
};

/**
 * タイムコードが実在するか (範囲外の値や、DF で飛ばされるフレーム番号でないか)
 */
const isValidTC = (tc, rate) => {
    if (tc.h < 0 || tc.h > 23 || tc.m < 0 || tc.m > 59 || tc.s < 0 || tc.s > 59) return false;
    if (tc.f < 0 || tc.f >= rate.nominal) return false;
    if (rate.drop && tc.s === 0 && tc.f < 2 && tc.m % 10 !== 0) return false;
    return true;
};

/** DF は秒とフレームの区切りを ';' にする (一般的な表記) */
const formatTC = (tc, rate) => {
    const p = (n) => String(n).padStart(2, '0');
    const sep = rate && rate.drop ? ';' : ':';
    return `${p(tc.h)}:${p(tc.m)}:${p(tc.s)}${sep}${p(tc.f)}`;
};

const tcToFrames = (tc, rate) => {
    if (!isValidTC(tc, rate)) throw new Error(`存在しないタイムコードです: ${formatTC(tc, rate)}`);
    const n = rate.nominal;
    const frames = ((tc.h * 60 + tc.m) * 60 + tc.s) * n + tc.f;
    if (!rate.drop) return frames;
    const totalMinutes = tc.h * 60 + tc.m;
    return frames - 2 * (totalMinutes - Math.floor(totalMinutes / 10));
};

const framesToTC = (frames, rate) => {
    const day = framesPerDay(rate);
    let n = ((Math.floor(frames) % day) + day) % day;
    if (rate.drop) {
        // 飛ばした番号を足し戻して、30fps の通し番号に直す
        const tenMin = Math.floor(n / DF_FRAMES_PER_10MIN);
        const rem = n % DF_FRAMES_PER_10MIN;
        n += 18 * tenMin;
        if (rem > 1) n += 2 * Math.floor((rem - 2) / DF_FRAMES_PER_MIN);
    }
    const fps = rate.nominal;
    return {
        h: Math.floor(n / (fps * 3600)),
        m: Math.floor(n / (fps * 60)) % 60,
        s: Math.floor(n / fps) % 60,
        f: n % fps
    };
};

/**
 * LTC ファイルの先頭からの経過秒 → その瞬間に出ている時刻。
 * @returns {{tc: object, frames: number, phase: number}} phase はフレーム内の位置 (0〜1)
 */
const fileTimeToTC = (seconds, startTC, rate) => {
    const exact = seconds * rate.actual;
    // 浮動小数点の誤差で 1 フレーム手前に落ちないよう、ごく僅かに丸める
    const whole = Math.floor(exact + 1e-9);
    const frames = tcToFrames(startTC, rate) + whole;
    return { tc: framesToTC(frames, rate), frames, phase: exact - whole };
};

module.exports = {
    RATES,
    getRate,
    framesPerDay,
    parseTC,
    isValidTC,
    formatTC,
    tcToFrames,
    framesToTC,
    fileTimeToTC
};
