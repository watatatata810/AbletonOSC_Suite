const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../lib/checks');
const seek = require('../lib/seek');

const clip = (over = {}) => ({
    track: 0, clip: 12, isPlaying: true, isTriggered: false, warping: true, warpMode: 3,
    // 実測 (2026-10-28): 726.9 秒の曲で loop_end = 1453.8 拍、end_marker はその 2 倍の 2907.6 拍
    playingPosition: 960, loopEnd: 1453.75, endMarker: 2907.5, looping: false,
    filePath: 'C:\\LTC\\LTC_S013_01-00-00-00.wav', ...over
});
const base = (over = {}) => ({
    connected: true,
    patchMissing: [],
    tempo: 120,
    quantization: 0,
    show: { tempo: 120 },
    cue: { scene: 12, file: 'D:\\out\\LTC_S013_01-00-00-00.wav', fileSeconds: 1453.75 },
    bgm: clip({ warpMode: 0 }),
    ltc: clip({ track: 4 }),
    ltcTrack: { name: 'LTC', mute: false, output: 'Ext. Out' },
    // 実測 (2026-10-28): 揃って鳴っている 2 クリップの start_time は同じ値 (-94)
    startTimes: { bgm: -94, ltc: -94 },
    ltcFileSeconds: 726.875,
    ...over
});
const codes = (s) => evaluate(s).map((i) => i.code);

test('監視: 正常なら問題なし', () => {
    assert.deepEqual(evaluate(base()), []);
});

test('監視: Live から返信が無い時はそれだけを出す', () => {
    assert.deepEqual(codes(base({ connected: false, tempo: 99 })), ['LIVE_DISCONNECTED']);
});

test('監視: LTC が鳴っていない / ずれている / クリップが無い', () => {
    assert.ok(codes(base({ ltc: clip({ track: 4, isPlaying: false }) })).includes('LTC_NOT_PLAYING'));
    // フォローアクションが有効な LTC クリップ: API は再生待ちと答えるが、トラックで鳴っているスロットがそのシーン
    // (2026-10-28 実測、シーン 15 の M2_LTC)。鳴っていると判断して警告しない
    const followAction = clip({ track: 4, isPlaying: false, isTriggered: true, playingSlot: 12 });
    assert.deepEqual(codes(base({ ltc: followAction })), []);
    // 本当に発音待ち (鳴っているスロットが別) なら警告する
    assert.ok(codes(base({ ltc: clip({ track: 4, isPlaying: false, isTriggered: true, playingSlot: 3 }) })).includes('LTC_NOT_PLAYING'));
    // BGM 側がフォローアクションで再生待ちと答えても、鳴っていると判断して LTC を確かめる
    assert.ok(codes(base({ bgm: clip({ isPlaying: false, isTriggered: true, playingSlot: 12 }), ltc: clip({ track: 4, isPlaying: false }) })).includes('LTC_NOT_PLAYING'));
    // LTC だけ 1 拍ずらすと start_time が 1 違った (実測)
    assert.ok(codes(base({ startTimes: { bgm: -74, ltc: -75 } })).includes('LTC_OUT_OF_SYNC'));
    assert.ok(codes(base({ startTimes: { bgm: -94, ltc: -93.99 } })).includes('LTC_OUT_OF_SYNC'));
    assert.deepEqual(codes(base({ startTimes: { bgm: -94, ltc: -93.9985 } })), []);
    assert.deepEqual(codes(base({ ltc: null })), ['LTC_MISSING']);
    assert.equal(evaluate(base({ ltc: null })).find((i) => i.code === 'LTC_MISSING').level, 'error');
    // BGM が止まっていれば、LTC クリップが無くても警告どまり
    assert.equal(evaluate(base({ ltc: null, bgm: clip({ isPlaying: false }) }))[0].level, 'warn');
});

test('監視: Warp・テンポ・クオンタイズ・トラック', () => {
    assert.ok(codes(base({ ltc: clip({ track: 4, warpMode: 0 }) })).includes('LTC_WARP'));
    assert.ok(codes(base({ tempo: 128 })).includes('SET_TEMPO'));
    assert.ok(codes(base({ quantization: 4 })).includes('SET_QUANT'));
    assert.ok(codes(base({ ltcTrack: { name: 'LTC', mute: true, output: 'Ext. Out' } })).includes('LTC_TRACK_MUTE'));
    assert.ok(codes(base({ ltcTrack: { name: 'LTC', mute: false, output: 'Master' } })).includes('LTC_TRACK_OUTPUT'));
    assert.ok(codes(base({ bgm: clip({ warping: false }) })).includes('BGM_WARP'));
    assert.ok(codes(base({ patchMissing: ['scrub'] })).includes('PATCH_MISSING'));
});

test('監視: LTC クリップの長さがファイルと合わない (BPM 違い) / 別のファイル', () => {
    // クリップの BPM が 110 だと、ファイルの終わりは 726.875 秒 × 110/60 拍になる
    assert.ok(codes(base({ ltc: clip({ track: 4, loopEnd: 726.875 * 110 / 60 }) })).includes('LTC_RATIO'));
    // ループするクリップの loop_end はファイルの終わりではないので判定しない
    assert.deepEqual(codes(base({ ltc: clip({ track: 4, loopEnd: 100, looping: true }) })), []);
    assert.ok(codes(base({ ltc: clip({ track: 4, filePath: 'C:\\other.wav' }) })).includes('LTC_FILE'));
});

test('途中から: scrub を全部送ってから stop_scrub を全部送る (1 バンドル)', () => {
    const p = seek.planStartFrom({ scene: 12, clips: [clip({ track: 0 }), clip({ track: 4 })], seconds: 480, tempo: 120 });
    assert.equal(p.ok, true);
    assert.equal(p.beats, 960);
    assert.deepEqual(p.messages.map((m) => [m[0], m[1], m[2]]), [
        ['/live/clip/scrub', 0, 12], ['/live/clip/scrub', 4, 12],
        ['/live/clip/stop_scrub', 0, 12], ['/live/clip/stop_scrub', 4, 12]
    ]);
    assert.deepEqual(p.messages[0][3], { type: 'float', value: 960 });
});

test('途中から: Warp オフのクリップや曲の長さを超える時刻は送らない', () => {
    assert.equal(seek.planStartFrom({ scene: 1, clips: [clip({ warping: false })], seconds: 10, tempo: 120 }).ok, false);
    assert.equal(seek.planStartFrom({ scene: 1, clips: [clip()], seconds: 2000, tempo: 120 }).ok, false);
    assert.equal(seek.planStartFrom({ scene: 1, clips: [], seconds: 10, tempo: 120 }).ok, false);
});

test('途中から: その時刻より前に鳴り終わるクリップ (20 秒の無音など) は外して鳴らさない', () => {
    // 2026-10-28 のシーン 13: トラック 2 に 20 秒の無音 (loop_end = end_marker = 40 拍)
    const silent = clip({ track: 1, loopEnd: 40, endMarker: 40 });
    const p = seek.planStartFrom({ scene: 12, clips: [clip({ track: 0 }), silent, clip({ track: 4 })], seconds: 480, tempo: 120 });
    assert.equal(p.ok, true);
    assert.deepEqual(p.targets.map((c) => c.track), [0, 4]);
    assert.deepEqual(p.skipped.map((c) => c.track), [1]);
    assert.equal(p.messages.length, 4);
    // 10 秒からなら 3 本とも鳴らす
    assert.equal(seek.planStartFrom({ scene: 12, clips: [clip({ track: 0 }), silent], seconds: 10, tempo: 120 }).targets.length, 2);
});

test('飛ばす: 鳴り終わったクリップは外す', () => {
    const p = seek.planJump({ clips: [clip(), clip({ track: 1, isPlaying: false })], referencePosition: 1000, deltaSeconds: -10, tempo: 120 });
    assert.equal(p.ok, true);
    assert.deepEqual(p.targets.map((c) => c.track), [0]);
    assert.deepEqual(p.skipped.map((c) => c.track), [1]);
});

test('飛ばす: 全クリップへ目的の位置の scrub + stop_scrub を送る (1 バンドル)', () => {
    const clips = [clip({ track: 0 }), clip({ track: 4 })];
    const back = seek.planJump({ clips, referencePosition: 1000, deltaSeconds: -10, tempo: 120 });
    assert.equal(back.ok, true);
    assert.equal(back.targetBeats, 980);
    assert.equal(back.deltaBeats, -20);
    assert.deepEqual(back.messages.map((m) => [m[0], m[1]]), [
        ['/live/clip/scrub', 0], ['/live/clip/scrub', 4], ['/live/clip/stop_scrub', 0], ['/live/clip/stop_scrub', 4]
    ]);
    assert.deepEqual(back.messages[0][3], { type: 'float', value: 980 });
    const to = seek.planJump({ clips, referencePosition: 1000, seconds: 83, tempo: 120 });
    assert.equal(to.targetBeats, 166);
    assert.equal(to.deltaBeats, -834);
});

test('飛ばす: フォローアクションが有効なクリップ (API 上は再生待ち) も鳴っているとして動かす', () => {
    // 2026-10-28 実測: シーン 29 の BGM (M-6 Judas) は鳴っているのに is_playing=False / is_triggered=True。
    // トラックの playing_slot_index はそのシーンを指していた
    const followAction = clip({ track: 0, clip: 28, isPlaying: false, isTriggered: true, playingSlot: 28 });
    const p = seek.planJump({ clips: [followAction, clip({ track: 4, clip: 28 })], referencePosition: 100, deltaSeconds: 5, tempo: 120 });
    assert.equal(p.ok, true);
    assert.deepEqual(p.targets.map((c) => c.track), [0, 4]);
});

test('飛ばす: 本当に発音待ちのクリップがあれば送らない (飛ばした後に頭から鳴ってずれるため)', () => {
    const pending = clip({ track: 4, isPlaying: false, isTriggered: true, playingSlot: -1 });
    const p = seek.planJump({ clips: [clip(), pending], referencePosition: 100, deltaSeconds: 5, tempo: 120 });
    assert.equal(p.ok, false);
    assert.ok(p.problems.some((x) => x.includes('トラック 5')));
    assert.equal(seek.planJump({ clips: [clip()], referencePosition: 10, deltaSeconds: -10, tempo: 120 }).ok, false);
    assert.equal(seek.planJump({ clips: [clip()], referencePosition: null, deltaSeconds: 5, tempo: 120 }).ok, false);
});

test('実行後の確認: 位置は曲全体の時刻 − start_time で求め、揃っていて飛び先にあれば合格', () => {
    // 曲全体の時刻 886.2、start_time -74 → 位置 960.2
    const ok = seek.verifyPositions([-74, -74], 886.2, 960, 1.5);
    assert.equal(ok.ok, true);
    assert.ok(Math.abs(ok.positions[0] - 960.2) < 1e-9);
    assert.equal(seek.verifyPositions([-74, -75], 886.2, 960, 1.5).ok, false);
    assert.equal(seek.verifyPositions([-74], 10, 960, 1.5).ok, false);
    assert.equal(seek.verifyPositions([-74, null], 886.2, 960, 1.5).ok, false);
});
