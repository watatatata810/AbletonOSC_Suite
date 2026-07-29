/**
 * 波形表示まわりの純粋関数群。
 *
 * DOM にも WaveSurfer にも依存しないため、ここに置いた関数は Node からそのまま
 * ユニットテストできる（test/waveform-math.test.js）。
 * ブラウザでは従来どおりグローバル関数として app.js から呼ばれる。
 */
(function (root) {
    'use strict';

    /**
     * 進行度（0.0〜1.0）を計算する
     * @param {number} position 現在の拍数 (beats)
     * @param {Object} markerData マーカー情報
     * @param {number} durationSec 音声ファイルの実時間 (seconds)
     * @returns {number} 波形全体に対する絶対的なパーセンテージ
     */
    function calculateAbsoluteProgress(position, markerData, durationSec) {
        if (position === undefined || !markerData || durationSec <= 0) return 0;

        if (markerData.isWarped) {
            const totalBeats = durationSec * (markerData.tempo / 60);
            return totalBeats > 0 ? position / totalBeats : 0;
        } else {
            return position / durationSec;
        }
    }

    /**
     * マーカーの表示用パーセンテージを計算する
     * @param {Object} markerData マーカー情報
     * @param {number} durationSec 音声ファイルの実時間 (seconds)
     * @returns {{startPct: number, endPct: number}}
     */
    function calculateMarkerPercentages(markerData, durationSec) {
        if (!markerData || durationSec <= 0) return { startPct: 0, endPct: 1 };

        let startPct = 0;
        let endPct = 1;

        // AbletonOSCの仕様対応：非ループ時でもエンドポイントを動かすとloop_endが変化するため、
        // isLoopingのON/OFFに関わらず「より手前にあるマーカー」を常に実質的なエンドとする
        const actualEnd = (markerData.loopEnd !== undefined && markerData.loopEnd < markerData.endMarker)
            ? markerData.loopEnd
            : markerData.endMarker;

        if (markerData.isWarped) {
            const totalBeats = durationSec * (markerData.tempo / 60);
            if (totalBeats > 0) {
                startPct = Math.max(0, markerData.startMarker / totalBeats);
                endPct = Math.min(1, actualEnd / totalBeats);
            }
        } else {
            startPct = Math.max(0, markerData.startMarker / durationSec);
            endPct = Math.min(1, actualEnd / durationSec);
        }

        // 異常値の場合は補正
        if (startPct >= 1) startPct = 0;
        if (endPct <= startPct) endPct = 1;

        return { startPct, endPct };
    }

    /**
     * タイマー表示用の文字列を生成する。
     *
     * 丸めの仕様（安全側＝実際より長く残っているように見せない）:
     *   - 経過時間: 切り捨て
     *   - 残り時間（通常表示）: 切り捨て。表示より短く残っていることはない
     *   - 残り15秒以下のカウントダウン: 秒は小数第2位まで（toFixed による丸め）、
     *     括弧内の整数は切り上げ（0 になった瞬間が終端）
     *
     * @param {number} extrapolatedProgress 現在の進行割合 (0.0〜1.0)
     * @param {number} durationMs 音声ファイルの実時間 (ms)
     * @param {number} startPct マーカーの開始割合 (0.0〜1.0)
     * @param {number} endPct マーカーの終了割合 (0.0〜1.0)
     * @returns {{text: string, isCountdown: boolean}} フォーマットされた時間文字列と状態
     */
    function calculateTimeDisplay(extrapolatedProgress, durationMs, startPct, endPct) {
        if (durationMs <= 0) return { text: "00:00 / -00:00", isCountdown: false };

        // 再生区間（スタート〜エンド）に対する相対的な進行度
        const elapsedProgress = Math.max(0, extrapolatedProgress - startPct);
        const remainingProgress = Math.max(0, endPct - Math.max(startPct, extrapolatedProgress));

        const elapsedSec = (elapsedProgress * durationMs) / 1000;
        const remainingSec = (remainingProgress * durationMs) / 1000;

        const elMin = Math.floor(elapsedSec / 60);
        const elSec = Math.floor(elapsedSec % 60);
        const elStr = `${elMin.toString().padStart(2, '0')}:${elSec.toString().padStart(2, '0')}`;

        const isCountdown = remainingSec > 0 && remainingSec <= 15;
        let remStr = '';

        if (isCountdown) {
            const remMin = Math.floor(remainingSec / 60);
            const remSecOnly = remainingSec % 60;
            // 小数点第2位まで（e.g. 14.30）
            const remSecFixed = remSecOnly.toFixed(2).padStart(5, '0');

            // 整数カウントダウン（0で終了）
            const countdownInt = Math.ceil(remainingSec).toString().padStart(2, '0');

            remStr = `-${remMin.toString().padStart(2, '0')}:${remSecFixed} (${countdownInt})`;
        } else {
            const remTotalSec = Math.floor(remainingSec);
            const remMin = Math.floor(remTotalSec / 60);
            const remSec = remTotalSec % 60;
            remStr = `-${remMin.toString().padStart(2, '0')}:${remSec.toString().padStart(2, '0')}`;
        }

        return { text: `${elStr} / ${remStr}`, isCountdown };
    }

    /**
     * ableton_status を受け取ったとき、画面（全トラック）を初期化すべきかを判定する。
     *
     * 2段階タイムアウトの設計（docs/260627-1548_ableton-two-stage-timeout-design.md §2.2）:
     *   - connected: true                → 何もしない
     *   - connected: false, reset: false → 4秒の一時切断。波形は残したまま疎通待ちにする
     *   - connected: false, reset: true  → 20秒超の完全切断。画面を初期化する
     *
     * この判定は過去に3回実装が往復している（0749f7d → 3717348 → 84a5c04）。
     * 意図せず戻さないようテストで固定している。
     *
     * @param {{connected: boolean, reset?: boolean}} status
     * @returns {boolean}
     */
    function shouldResetTracksUI(status) {
        if (!status || status.connected) return false;
        return status.reset === true;
    }

    const api = {
        calculateAbsoluteProgress,
        calculateMarkerPercentages,
        calculateTimeDisplay,
        shouldResetTracksUI
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;      // Node（ユニットテスト）
    } else {
        Object.assign(root, api);  // ブラウザ（app.js からグローバル関数として使う）
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
