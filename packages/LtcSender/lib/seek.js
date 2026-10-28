/**
 * 途中から再生・飛ばす操作の組み立て (純粋関数) と実行。
 *
 * 実機で確かめた仕組み (2026-10-28、docs/261028-2253_ltc-sender-design.md):
 * - 止まっているシーンを途中から: 全クリップへ scrub(拍) と stop_scrub() を 1 つのバンドルで送る。
 *   stop_scrub を遅らせると目的の位置の約 0.1 拍を繰り返すので、必ず同じバンドルに入れる
 * - 再生中に飛ばす: 同じく全クリップへ scrub(目的の拍) と stop_scrub() を 1 つのバンドルで送る。
 *   move_playing_pos はフォローアクションが有効なクリップに無視されるので使わない
 * 時刻 (秒) と拍の換算は「拍 = 秒 × テンポ ÷ 60」。全クリップの BPM が Set のテンポと同じ前提。
 */
const { f32 } = require('./live');
const { SYNC_TOLERANCE_BEATS, isClipPlaying } = require('./checks');

const secondsToBeats = (seconds, tempo) => seconds * tempo / 60;
const beatsToSeconds = (beats, tempo) => beats * 60 / tempo;

/**
 * クリップが鳴り終わる位置 (拍)。分からなければ null。
 * ループしないクリップは loop_end がファイルの終わり (実測)。end_marker はその 2 倍の値が
 * 返ってくることがあるので、両方ある時は小さい方を使う
 */
const clipEndBeats = (c) => {
    const values = [c.loopEnd, c.endMarker].filter((v) => typeof v === 'number' && v > 0);
    return values.length > 0 ? Math.min(...values) : null;
};

/**
 * 止まっているシーンを途中から鳴らす。その時刻より前に鳴り終わるクリップ (短い無音・効果音など) は
 * 普通にシーンを発音しても鳴り終わっているはずなので、鳴らさずに外す。
 * @param {object} opts
 * @param {number} opts.scene
 * @param {Array<object>} opts.clips - シーンのクリップ (Live.getClipState の戻り値)
 * @param {number} opts.seconds - 曲の頭からの秒
 * @param {number} opts.tempo
 * @returns {{ok:boolean, problems:string[], beats:number, targets:Array, skipped:Array, messages:Array}}
 */
const planStartFrom = ({ scene, clips, seconds, tempo }) => {
    const problems = [];
    if (!(tempo > 0)) problems.push('Live のテンポが読めません');
    if (!(seconds >= 0)) problems.push('時刻が正しくありません');
    if (clips.length === 0) problems.push(`シーン ${scene + 1} にクリップがありません`);
    const beats = secondsToBeats(seconds, tempo);
    const ended = (c) => {
        const end = clipEndBeats(c);
        return !c.looping && end !== null && beats >= end;
    };
    const targets = clips.filter((c) => !ended(c));
    const skipped = clips.filter(ended);
    if (clips.length > 0 && targets.length === 0) problems.push('その時刻には、どのクリップも鳴り終わっています');
    for (const c of targets) {
        if (!c.warping) problems.push(`トラック ${c.track + 1} のクリップが Warp オフです`);
    }
    const messages = [
        ...targets.map((c) => ['/live/clip/scrub', c.track, scene, f32(beats)]),
        ...targets.map((c) => ['/live/clip/stop_scrub', c.track, scene])
    ];
    return { ok: problems.length === 0, problems, beats, targets, skipped, messages };
};

/**
 * 再生中のシーンの全クリップを、目的の位置へ揃えて動かす。
 * move_playing_pos ではなく scrub + stop_scrub を使う。move_playing_pos はフォローアクションが
 * 有効なクリップ (API 上は再生待ち) に送ると無視され、片方だけ動いてずれる (2026-10-28 実測)。
 * scrub はそのクリップにも効き、全クリップが同じ start_time に揃う。
 * 鳴っていないクリップと、飛び先の時刻より前に鳴り終わるクリップは外す。
 * @param {object} opts
 * @param {Array<object>} opts.clips - シーンのクリップ (playingSlot 付き。isClipPlaying を参照)
 * @param {number} opts.referencePosition - 基準のクリップ (BGM) の今の位置 (拍)
 * @param {number} [opts.seconds] - 飛び先 (曲の頭からの秒)。deltaSeconds とどちらか
 * @param {number} [opts.deltaSeconds] - 今の位置から前後に何秒
 * @param {number} opts.tempo
 */
const planJump = ({ clips, referencePosition, seconds, deltaSeconds, tempo }) => {
    const problems = [];
    if (!(tempo > 0)) problems.push('Live のテンポが読めません');
    if (referencePosition === null || referencePosition === undefined) problems.push('今の再生位置が読めません');
    const target = seconds !== undefined
        ? secondsToBeats(seconds, tempo)
        : referencePosition + secondsToBeats(deltaSeconds, tempo);
    if (target < 0) problems.push('曲の頭より前には飛べません');
    const playing = clips.filter(isClipPlaying);
    // 本当に発音待ちのクリップ (クオンタイズ待ちなど) は、飛ばした後に頭から鳴り始めてずれるので送らない
    for (const c of clips.filter((x) => x.isTriggered && !isClipPlaying(x))) {
        problems.push(`トラック ${c.track + 1} のクリップが発音待ちです`);
    }
    const endsBefore = (c) => {
        const end = clipEndBeats(c);
        return !c.looping && end !== null && target >= end;
    };
    const targets = playing.filter((c) => !endsBefore(c));
    const skipped = clips.filter((c) => !targets.includes(c));
    if (targets.length === 0) problems.push('飛び先の時刻に鳴っているクリップがありません');
    for (const c of targets) {
        if (!c.warping) problems.push(`トラック ${c.track + 1} のクリップが Warp オフです`);
    }
    const messages = [
        ...targets.map((c) => ['/live/clip/scrub', c.track, c.clip, f32(target)]),
        ...targets.map((c) => ['/live/clip/stop_scrub', c.track, c.clip])
    ];
    return { ok: problems.length === 0, problems, targetBeats: target, deltaBeats: target - referencePosition, targets, skipped, messages };
};

/**
 * 実行後に読み直した値で、全クリップが揃って飛び先にいるかを確かめる。
 * 位置は「曲全体の時刻 − start_time」で求める (is_playing はフォローアクションが有効なクリップで
 * False になり、playing_position はリスナーの通知と取り違えるため、どちらも使わない)
 * @param {Array<number|null>} startTimes - 各クリップの start_time (Live.getStartTimes)
 * @param {number|null} songTime - 同じ瞬間の曲全体の時刻 (current_song_time)
 * @param {number} targetBeats - 飛び先
 * @param {number} elapsedBeats - 送ってから読み直すまでに進んだはずの拍の上限
 */
const verifyPositions = (startTimes, songTime, targetBeats, elapsedBeats) => {
    const problems = [];
    const times = startTimes.filter((v) => v !== null);
    if (times.length !== startTimes.length || songTime === null) problems.push('位置を読めないクリップがあります');
    const spread = times.length > 0 ? Math.max(...times) - Math.min(...times) : null;
    if (spread !== null && spread > SYNC_TOLERANCE_BEATS) problems.push(`クリップが ${spread.toFixed(4)} 拍ずれています`);
    const positions = songTime === null ? [] : times.map((t) => songTime - t);
    if (positions.some((v) => v < targetBeats - SYNC_TOLERANCE_BEATS || v > targetBeats + elapsedBeats)) {
        problems.push('飛び先の位置になっていません');
    }
    return { ok: problems.length === 0, problems, spread, positions };
};

module.exports = {
    secondsToBeats,
    beatsToSeconds,
    clipEndBeats,
    isClipPlaying,
    planStartFrom,
    planJump,
    verifyPositions
};
