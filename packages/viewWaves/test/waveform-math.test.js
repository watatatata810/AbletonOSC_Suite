const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    calculateAbsoluteProgress,
    calculateMarkerPercentages,
    calculateTimeDisplay,
    shouldResetTracksUI
} = require('../public/waveform-math.js');

// テンポ120 の場合 1秒 = 2 beats。60秒のファイルなら全体で 120 beats。
const warped = { isWarped: true, tempo: 120, startMarker: 0, endMarker: 120 };
const nonWarped = { isWarped: false, startMarker: 0, endMarker: 60 };

describe('calculateAbsoluteProgress', () => {
    test('ワープ有効時は拍数を「実時間×テンポ」で割る', () => {
        // 60秒 @ 120BPM = 120 beats。60 beats は中間地点
        assert.equal(calculateAbsoluteProgress(60, warped, 60), 0.5);
        assert.equal(calculateAbsoluteProgress(0, warped, 60), 0);
        assert.equal(calculateAbsoluteProgress(120, warped, 60), 1);
    });

    test('ワープ無効時は秒数をそのまま実時間で割る', () => {
        assert.equal(calculateAbsoluteProgress(30, nonWarped, 60), 0.5);
        assert.equal(calculateAbsoluteProgress(15, nonWarped, 60), 0.25);
    });

    test('テンポが変わると同じ拍数でも進行度が変わる', () => {
        const slow = { isWarped: true, tempo: 60 };
        // 60秒 @ 60BPM = 60 beats なので、60 beats で終端
        assert.equal(calculateAbsoluteProgress(60, slow, 60), 1);
    });

    test('入力が欠けている場合は 0 を返す（NaN を出さない）', () => {
        assert.equal(calculateAbsoluteProgress(undefined, warped, 60), 0);
        assert.equal(calculateAbsoluteProgress(10, null, 60), 0);
        assert.equal(calculateAbsoluteProgress(10, warped, 0), 0);
        assert.equal(calculateAbsoluteProgress(10, warped, -1), 0);
    });

    test('テンポ0でも 0 を返す（ゼロ除算しない）', () => {
        assert.equal(calculateAbsoluteProgress(10, { isWarped: true, tempo: 0 }, 60), 0);
    });
});

describe('calculateMarkerPercentages', () => {
    test('ワープ有効時は拍数ベースで範囲を算出する', () => {
        // 60秒 @ 120BPM = 全120beats。30〜90beats は 25%〜75%
        const r = calculateMarkerPercentages(
            { isWarped: true, tempo: 120, startMarker: 30, endMarker: 90 }, 60
        );
        assert.equal(r.startPct, 0.25);
        assert.equal(r.endPct, 0.75);
    });

    test('ワープ無効時は秒数ベースで範囲を算出する', () => {
        const r = calculateMarkerPercentages(
            { isWarped: false, startMarker: 15, endMarker: 45 }, 60
        );
        assert.equal(r.startPct, 0.25);
        assert.equal(r.endPct, 0.75);
    });

    test('loopEnd が endMarker より手前ならそちらを実質の終端にする', () => {
        // AbletonOSC は非ループ時でもエンドポイント操作で loop_end が動くため
        const r = calculateMarkerPercentages(
            { isWarped: false, startMarker: 0, endMarker: 60, loopEnd: 30 }, 60
        );
        assert.equal(r.endPct, 0.5);
    });

    test('loopEnd が endMarker より後ろなら endMarker を使う', () => {
        const r = calculateMarkerPercentages(
            { isWarped: false, startMarker: 0, endMarker: 30, loopEnd: 60 }, 60
        );
        assert.equal(r.endPct, 0.5);
    });

    test('マーカー情報が無い/実時間が0なら全体表示にフォールバックする', () => {
        assert.deepEqual(calculateMarkerPercentages(null, 60), { startPct: 0, endPct: 1 });
        assert.deepEqual(calculateMarkerPercentages(nonWarped, 0), { startPct: 0, endPct: 1 });
    });

    test('開始位置がファイル長以上という異常値は 0 に補正する', () => {
        const r = calculateMarkerPercentages(
            { isWarped: false, startMarker: 120, endMarker: 200 }, 60
        );
        assert.equal(r.startPct, 0);
    });

    test('終端が開始以下になる異常値は 1 に補正する', () => {
        const r = calculateMarkerPercentages(
            { isWarped: false, startMarker: 30, endMarker: 10 }, 60
        );
        assert.equal(r.endPct, 1);
    });

    test('開始位置は負にならない', () => {
        const r = calculateMarkerPercentages(
            { isWarped: false, startMarker: -10, endMarker: 30 }, 60
        );
        assert.equal(r.startPct, 0);
    });
});

describe('calculateTimeDisplay', () => {
    const TEN_MIN_MS = 600000;

    test('実時間が0なら固定文字列を返す', () => {
        assert.deepEqual(
            calculateTimeDisplay(0.5, 0, 0, 1),
            { text: '00:00 / -00:00', isCountdown: false }
        );
    });

    test('経過・残りともゼロ埋め2桁で表示する', () => {
        // 10分尺の 10% = 1分経過、残り9分
        const r = calculateTimeDisplay(0.1, TEN_MIN_MS, 0, 1);
        assert.equal(r.text, '01:00 / -09:00');
        assert.equal(r.isCountdown, false);
    });

    test('経過時間は切り捨てる', () => {
        // 59.9秒経過 → 00:59（60秒に繰り上げない）
        const r = calculateTimeDisplay(59.9 / 600, TEN_MIN_MS, 0, 1);
        assert.match(r.text, /^00:59 \//);
    });

    test('残り時間は切り捨てる（実際より長く残っているように見せない）', () => {
        // 残り 20.9秒 → -00:20 と表示（-00:21 にはしない）
        const progress = (600 - 20.9) / 600;
        const r = calculateTimeDisplay(progress, TEN_MIN_MS, 0, 1);
        assert.equal(r.text.split(' / ')[1], '-00:20');
    });

    // 注: 0.2 や 0.7 は二進小数で表現できず、引き算の結果が 0.49999999999999994 の
    // ように 1ulp 下振れする。表示は切り捨てのため -05:00 が -04:59 になる。
    // 「実際より長く残っているように見せない」という方針では安全側なので、
    // ここでは二進で厳密な値（0.25 / 0.5 / 0.75）を使って丸め仕様そのものを固定し、
    // 誤差の向きは別テスト（安全側であること）で担保する。
    test('マーカー範囲を基準に経過・残りを計算する', () => {
        // 25%〜75% を再生範囲とし、現在50% → 区間内で25%経過、25%残り
        const r = calculateTimeDisplay(0.5, TEN_MIN_MS, 0.25, 0.75);
        assert.equal(r.text, '02:30 / -02:30');
    });

    test('開始マーカーより手前では経過0・残りは区間全体', () => {
        const r = calculateTimeDisplay(0.1, TEN_MIN_MS, 0.25, 0.75);
        assert.equal(r.text, '00:00 / -05:00');
    });

    test('残り15秒以下でカウントダウン表示に切り替わる', () => {
        const at = (remainSec) => calculateTimeDisplay((600 - remainSec) / 600, TEN_MIN_MS, 0, 1);

        assert.equal(at(14.9).isCountdown, true, '15秒未満はカウントダウン');
        assert.equal(at(15.5).isCountdown, false, '15秒超は通常表示');
    });

    test('残り時間を実際より長く表示しない（丸め誤差の向きが安全側である）', () => {
        // 残り時間の表示は「表示された時間より長く残っていることはない」を保証する。
        // 浮動小数点誤差が乗っても、この向きだけは崩れてはいけない。
        for (let remainSec = 0.5; remainSec <= 120; remainSec += 0.5) {
            const r = calculateTimeDisplay((600 - remainSec) / 600, TEN_MIN_MS, 0, 1);
            const body = r.text.split(' / ')[1].replace('-', '').split(' ')[0];
            const [min, sec] = body.split(':').map(Number);
            const shown = min * 60 + sec;

            assert.ok(
                shown <= remainSec + 1e-6,
                `残り${remainSec}秒に対し ${r.text} と表示された（実際より長い）`
            );
        }
    });

    test('カウントダウンは小数第2位まで＋括弧内は切り上げ整数', () => {
        const r = calculateTimeDisplay((600 - 14.3) / 600, TEN_MIN_MS, 0, 1);
        assert.equal(r.isCountdown, true);
        assert.equal(r.text.split(' / ')[1], '-00:14.30 (15)');
    });

    test('カウントダウンの秒はゼロ埋めされる（1桁秒でも崩れない）', () => {
        const r = calculateTimeDisplay((600 - 5.1) / 600, TEN_MIN_MS, 0, 1);
        assert.equal(r.text.split(' / ')[1], '-00:05.10 (06)');
    });

    test('残り0（終端到達）ではカウントダウンにしない', () => {
        const r = calculateTimeDisplay(1, TEN_MIN_MS, 0, 1);
        assert.equal(r.isCountdown, false);
        assert.equal(r.text, '10:00 / -00:00');
    });

    test('終端を過ぎても負の残り時間を表示しない', () => {
        const r = calculateTimeDisplay(1.5, TEN_MIN_MS, 0, 1);
        assert.equal(r.text.split(' / ')[1], '-00:00');
    });
});

describe('shouldResetTracksUI（2段階タイムアウト）', () => {
    // 過去に3回実装が往復している判定。意図せず戻さないよう固定する。

    test('疎通中は初期化しない', () => {
        assert.equal(shouldResetTracksUI({ connected: true }), false);
        assert.equal(shouldResetTracksUI({ connected: true, reset: true }), false);
    });

    test('4秒の一時切断（reset: false）では初期化しない＝波形を残す', () => {
        assert.equal(shouldResetTracksUI({ connected: false, reset: false }), false);
    });

    test('20秒超の完全切断（reset: true）でのみ初期化する', () => {
        assert.equal(shouldResetTracksUI({ connected: false, reset: true }), true);
    });

    test('reset が省略された場合は初期化しない（安全側）', () => {
        assert.equal(shouldResetTracksUI({ connected: false }), false);
    });

    test('不正な入力でも例外を投げない', () => {
        assert.equal(shouldResetTracksUI(null), false);
        assert.equal(shouldResetTracksUI(undefined), false);
    });
});
