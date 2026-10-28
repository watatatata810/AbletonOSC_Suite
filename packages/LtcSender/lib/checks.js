/**
 * 本番中の監視の判定 (純粋関数)。Live から集めた状態を受け取り、問題の一覧を返す。
 *
 * level: 'error' は LTC が正しく出ていない・出なくなるおそれがあるもの (画面全体を赤くする)
 *        'warn' は今すぐは困らないが直すべきもの (黄色)
 */
const path = require('path');

// LOM の Clip.warp_mode
const WARP_MODE_REPITCH = 3;
// 2 つのクリップの start_time の差の許容 (拍)。120 BPM で 1ms
const SYNC_TOLERANCE_BEATS = 0.002;
// LTC クリップの長さとファイル長の食い違いの許容 (比率)
const RATIO_TOLERANCE = 0.005;

const issue = (level, code, message) => ({ level, code, message });

/**
 * クリップが鳴っているか。フォローアクションが有効なクリップは、鳴っている間も Live の API が
 * is_playing=False / is_triggered=True と答える (曲の終わりの発音が予約されているため。2026-10-28 実測)。
 * そのため、トラックで今鳴っているスロット (playing_slot_index) がそのクリップかでも判断する
 * @param {object} c - Live.getClipState の戻り値に playingSlot (トラックの playing_slot_index) を足したもの
 */
const isClipPlaying = (c) => Boolean(c && (c.isPlaying || (c.playingSlot !== undefined && c.playingSlot === c.clip)));

/**
 * @param {object} s
 * @param {boolean} s.connected - Live から返信が来ているか
 * @param {string[]} s.patchMissing - AbletonOSC に足りない命令
 * @param {number|null} s.tempo / s.quantization - Live の Set の値
 * @param {object|null} s.show - 台帳のショー
 * @param {object|null} s.cue - 今鳴っている (または選ばれている) シーンの台帳
 * @param {object|null} s.bgm / s.ltc - Live.getClipState の戻り値 (クリップが無ければ null)
 * @param {object|null} s.ltcTrack - Live.getTrackState の戻り値
 * @param {object|null} s.startTimes - { bgm, ltc } の start_time (揃っていれば同じ値)
 * @param {number|null} s.ltcFileSeconds - LTC クリップが鳴らしているファイルの長さ (秒)
 * @returns {Array<{level:string, code:string, message:string}>}
 */
const evaluate = (s) => {
    const out = [];
    if (!s.connected) {
        out.push(issue('error', 'LIVE_DISCONNECTED', 'Ableton Live から返信がありません'));
        return out;
    }
    if (s.patchMissing && s.patchMissing.length > 0) {
        out.push(issue('error', 'PATCH_MISSING', `AbletonOSC の改造がありません (${s.patchMissing.join(', ')})。apply-abletonosc-patch.js を実行して Live を再起動してください`));
    }
    if (s.show && s.tempo !== null && Math.abs(s.tempo - s.show.tempo) > 0.001) {
        out.push(issue('error', 'SET_TEMPO', `Live のテンポが ${s.tempo} です (台帳は ${s.show.tempo})`));
    }
    if (s.quantization !== null && s.quantization !== undefined && s.quantization !== 0) {
        out.push(issue('warn', 'SET_QUANT', 'グローバルクオンタイズが None ではありません (途中から再生の発音が遅れます)'));
    }
    if (s.ltcTrack) {
        if (s.ltcTrack.mute) out.push(issue('error', 'LTC_TRACK_MUTE', `LTC トラック「${s.ltcTrack.name}」がミュートされています`));
        if (s.ltcTrack.output === 'Master') out.push(issue('error', 'LTC_TRACK_OUTPUT', 'LTC トラックの出力が Master です (PA に LTC が出ます)'));
    }
    if (!s.cue) return out;

    const bgmPlaying = isClipPlaying(s.bgm);
    const ltcPlaying = isClipPlaying(s.ltc);
    if (!s.ltc) {
        out.push(issue(bgmPlaying ? 'error' : 'warn', 'LTC_MISSING', `シーン ${s.cue.scene + 1} の LTC トラックにクリップがありません`));
        return out;
    }
    if (bgmPlaying && !ltcPlaying) {
        out.push(issue('error', 'LTC_NOT_PLAYING', `シーン ${s.cue.scene + 1} の LTC が鳴っていません`));
    }
    if (bgmPlaying && ltcPlaying && s.startTimes && s.startTimes.bgm !== null && s.startTimes.ltc !== null) {
        const diff = Math.abs(s.startTimes.bgm - s.startTimes.ltc);
        if (diff > SYNC_TOLERANCE_BEATS) {
            out.push(issue('error', 'LTC_OUT_OF_SYNC', `BGM と LTC の位置が ${(diff * 60 / (s.tempo || 120) * 1000).toFixed(1)}ms ずれています`));
        }
    }
    if (!s.ltc.warping || s.ltc.warpMode !== WARP_MODE_REPITCH) {
        out.push(issue('error', 'LTC_WARP', 'LTC クリップを Warp オン・Re-Pitch にしてください'));
    }
    if (s.bgm && !s.bgm.warping) {
        out.push(issue('warn', 'BGM_WARP', 'BGM クリップが Warp オフです (途中から再生・飛ばす操作ができません)'));
    }
    // ループしないクリップの loop_end はファイルの終わりの拍。クリップの BPM がテンポと同じなら
    // loop_end × 60 ÷ テンポ = ファイルの長さ (秒) になる。end_marker は実測でその 2 倍の値が返るので使わない
    if (s.ltcFileSeconds && s.tempo && s.ltc.loopEnd && !s.ltc.looping) {
        const clipSeconds = s.ltc.loopEnd * 60 / s.tempo;
        if (Math.abs(clipSeconds - s.ltcFileSeconds) / s.ltcFileSeconds > RATIO_TOLERANCE) {
            out.push(issue('warn', 'LTC_RATIO', 'LTC クリップの BPM が Live のテンポと違う可能性があります (クリップの長さがファイルと合いません)'));
        }
    }
    if (s.cue.file && s.ltc.filePath && path.basename(s.ltc.filePath) !== path.basename(s.cue.file)) {
        out.push(issue('warn', 'LTC_FILE', `LTC クリップのファイルが台帳と違います (${path.basename(s.ltc.filePath)})`));
    }
    return out;
};

module.exports = {
    WARP_MODE_REPITCH,
    SYNC_TOLERANCE_BEATS,
    isClipPlaying,
    evaluate
};
