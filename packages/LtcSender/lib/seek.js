/**
 * 途中から再生・飛ばす操作の組み立て (純粋関数) と実行。
 *
 * 実機で確かめた仕組み (2026-10-28、docs/261028-2253_ltc-sender-design.md):
 * - 止まっているシーンを途中から: 全クリップへ scrub(拍) と stop_scrub() を 1 つのバンドルで送る。
 *   stop_scrub を遅らせると目的の位置の約 0.1 拍を繰り返すので、必ず同じバンドルに入れる
 * - 再生中に飛ばす: 全クリップへ同じ拍数の move_playing_pos を 1 つのバンドルで送る。
 *   Warp オフ・再生待ち (is_triggered) のクリップには効かないので、送る前に確かめる
 * 時刻 (秒) と拍の換算は「拍 = 秒 × テンポ ÷ 60」。全クリップの BPM が Set のテンポと同じ前提。
 */
const { f32 } = require('./live');
const { SYNC_TOLERANCE_BEATS } = require('./checks');

const secondsToBeats = (seconds, tempo) => seconds * tempo / 60;
const beatsToSeconds = (beats, tempo) => beats * 60 / tempo;

/**
 * @param {object} opts
 * @param {number} opts.scene
 * @param {Array<object>} opts.clips - シーンのクリップ (Live.getClipState の戻り値)
 * @param {number} opts.seconds - 曲の頭からの秒
 * @param {number} opts.tempo
 * @returns {{ok:boolean, problems:string[], beats:number, messages:Array}}
 */
const planStartFrom = ({ scene, clips, seconds, tempo }) => {
    const problems = [];
    if (!(tempo > 0)) problems.push('Live のテンポが読めません');
    if (!(seconds >= 0)) problems.push('時刻が正しくありません');
    if (clips.length === 0) problems.push(`シーン ${scene + 1} にクリップがありません`);
    const beats = secondsToBeats(seconds, tempo);
    for (const c of clips) {
        if (!c.warping) problems.push(`トラック ${c.track + 1} のクリップが Warp オフです`);
        if (c.endMarker !== null && c.endMarker !== undefined && beats >= c.endMarker) {
            problems.push(`トラック ${c.track + 1} のクリップは ${beatsToSeconds(c.endMarker, tempo).toFixed(1)} 秒で終わります`);
        }
    }
    const messages = [
        ...clips.map((c) => ['/live/clip/scrub', c.track, scene, f32(beats)]),
        ...clips.map((c) => ['/live/clip/stop_scrub', c.track, scene])
    ];
    return { ok: problems.length === 0, problems, beats, messages };
};

/**
 * 再生中のクリップを、全部同じ拍数だけ動かす。
 * @param {object} opts
 * @param {Array<object>} opts.clips - 再生中のクリップ (Live.getClipState の戻り値)
 * @param {number} opts.referencePosition - 基準のクリップ (BGM) の今の位置 (拍)
 * @param {number} [opts.seconds] - 飛び先 (曲の頭からの秒)。deltaSeconds とどちらか
 * @param {number} [opts.deltaSeconds] - 今の位置から前後に何秒
 * @param {number} opts.tempo
 */
const planJump = ({ clips, referencePosition, seconds, deltaSeconds, tempo }) => {
    const problems = [];
    if (!(tempo > 0)) problems.push('Live のテンポが読めません');
    if (clips.length === 0) problems.push('再生中のクリップがありません');
    for (const c of clips) {
        if (!c.warping) problems.push(`トラック ${c.track + 1} のクリップが Warp オフです`);
        if (!c.isPlaying || c.isTriggered) problems.push(`トラック ${c.track + 1} のクリップが再生中ではありません`);
    }
    const target = seconds !== undefined
        ? secondsToBeats(seconds, tempo)
        : referencePosition + secondsToBeats(deltaSeconds, tempo);
    if (target < 0) problems.push('曲の頭より前には飛べません');
    const delta = target - referencePosition;
    const messages = clips.map((c) => ['/live/clip/move_playing_pos', c.track, c.clip, f32(delta)]);
    return { ok: problems.length === 0, problems, targetBeats: target, deltaBeats: delta, messages };
};

/**
 * 実行後に読み直した位置が揃っているか
 * @param {Array<{position:number|null, isPlaying:boolean|null}>} positions
 * @param {number} targetBeats - 飛び先
 * @param {number} elapsedBeats - 送ってから読み直すまでに進んだはずの拍の上限
 */
const verifyPositions = (positions, targetBeats, elapsedBeats) => {
    const problems = [];
    const values = positions.map((p) => p.position);
    if (positions.some((p) => !p.isPlaying || p.position === null)) problems.push('鳴っていないクリップがあります');
    const valid = values.filter((v) => v !== null);
    const spread = valid.length > 0 ? Math.max(...valid) - Math.min(...valid) : null;
    if (spread !== null && spread > SYNC_TOLERANCE_BEATS) problems.push(`クリップの位置が ${spread.toFixed(4)} 拍ずれています`);
    if (valid.some((v) => v < targetBeats - SYNC_TOLERANCE_BEATS || v > targetBeats + elapsedBeats)) {
        problems.push('飛び先の位置になっていません');
    }
    return { ok: problems.length === 0, problems, spread };
};

module.exports = {
    secondsToBeats,
    beatsToSeconds,
    planStartFrom,
    planJump,
    verifyPositions
};
