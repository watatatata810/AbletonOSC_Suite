/**
 * LtcSender の中心。台帳・Live の監視・LTC ファイルの作成・途中から再生をまとめる。
 * 画面 (Socket.IO) とのやりとりは server.js が受け持ち、ここはイベントで状態を知らせる。
 *
 * イベント:
 * - 'state'  : 台帳と Live の構成 (トラック名・シーン名) が変わった
 * - 'status' : 監視の結果 (1 秒ごと)
 * - 'tc'     : 今出ている LTC の時刻 (LTC クリップの再生位置の通知のたび。最大 20 回/秒)
 */
const EventEmitter = require('events');
const tc = require('./timecode');
const cues = require('./cues');
const ltcFiles = require('./ltc-files');
const seek = require('./seek');
const { evaluate } = require('./checks');
const patch = require('./abletonosc-patch');
const { wavInfo } = require('./wav');

const MONITOR_MS = 1000;
const STRUCTURE_MS = 5000;
const SLOW_PROPS_MS = 10000;
const DISCONNECT_MS = 3000;
const VERIFY_WAIT_MS = 500;
const TC_EMIT_MS = 50;
// 返信は osc-router が全パッケージに配るので、他のパッケージが反応する問い合わせは毎秒は送らない。
// viewWaves は file_path の返信で波形を描き直してアニメーションし (2026-10-29 実測、毎秒発生)、
// warping / looping / loop_end の返信でマーカーを送り直し、tempo の返信でログを書き、
// track/scene の name の返信で画面を更新する。
// 毎秒読むのは、どのパッケージも反応しないものだけにする
const MONITOR_PROPS = ['is_playing', 'is_triggered', 'warp_mode'];
// 鳴るシーンが変わった時に読み、その後は SLOW_PROPS_MS ごと (file_path はシーンが変わった時だけ)
const SLOW_PROPS = ['warping', 'looping', 'loop_end'];
const SEEK_PROPS = ['is_playing', 'is_triggered', 'warping', 'looping', 'end_marker', 'loop_end', 'playing_position'];

class Controller extends EventEmitter {
    /**
     * @param {object} opts
     * @param {import('./live').Live} opts.live
     * @param {string} opts.dataFile - 台帳の保存先
     * @param {string} [opts.clipPyPath] - AbletonOSC の clip.py (改造の確認用)
     */
    constructor({ live, dataFile, clipPyPath }) {
        super();
        this.live = live;
        this.dataFile = dataFile;
        this.clipPyPath = clipPyPath;
        this.data = cues.load(dataFile);
        this.mode = 'show';
        this.trackNames = [];
        this.sceneNames = [];
        this.patchMissing = [];
        this.status = null;
        this.active = null; // { scene, cue, bgmTrack, ltcTrack }
        this.lastTcEmit = 0;
        this.fileSecondsCache = new Map();
        // 鳴っているシーンのクリップの、あまり変わらないプロパティ (key: "track_clip")
        this.slowCache = new Map();
        // テンポは Live からの変更の通知 (start_listen) で受け取る。viewWaves が張ったリスナーの通知も届く
        this.tempo = null;
        this.wasConnected = false;
        this.counts = { tracks: -1, scenes: -1 };
        this.timers = [];
        this.busy = false;
    }

    start() {
        this.checkPatch();
        this.live.on('message', (address, args) => this.onLiveMessage(address, args));
        this.refreshStructure(true);
        this.timers.push(setInterval(() => this.refreshStructure(false), STRUCTURE_MS));
        this.timers.push(setInterval(() => this.monitor(), MONITOR_MS));
    }

    stop() {
        this.timers.forEach(clearInterval);
        this.timers = [];
    }

    checkPatch() {
        this.patchMissing = patch.checkFile(this.clipPyPath).missing;
    }

    // ---- 台帳 ----

    show() {
        return cues.getShow(this.data);
    }

    publicState() {
        return {
            mode: this.mode,
            data: this.data,
            show: this.show(),
            trackNames: this.trackNames,
            sceneNames: this.sceneNames,
            patchMissing: this.patchMissing,
            rates: Object.keys(tc.RATES)
        };
    }

    saveData() {
        cues.save(this.dataFile, this.data);
        this.emit('state', this.publicState());
    }

    /**
     * 台帳を変える操作。fn(data, show) の中で書き換え、検査に通れば保存して知らせる。
     * 失敗したら書き換える前の状態に戻す
     */
    editLedger(fn) {
        const before = JSON.parse(JSON.stringify(this.data));
        try {
            const result = fn(this.data, this.data.shows[this.data.active]);
            const show = this.data.shows[this.data.active];
            if (show) {
                const errors = cues.validateShow({ ...cues.DEFAULT_SHOW, ...show });
                if (errors.length > 0) throw new Error(errors.join(' / '));
            }
            this.saveData();
            return result;
        } catch (err) {
            this.data = before;
            throw err;
        }
    }

    setMode(mode) {
        if (mode !== 'show' && mode !== 'rehearsal') throw new Error(`不明なモードです: ${mode}`);
        this.mode = mode;
        this.emit('state', this.publicState());
    }

    // ---- Live の構成 ----

    /**
     * トラック名・シーン名を読み直す。名前の返信には viewWaves も反応するので、
     * ふだんはトラック数・シーン数だけを確かめ (viewWaves は同じ数なら何もしない)、
     * 数が変わった時か、force (起動時・画面の「読み直し」) の時だけ名前を読む
     */
    async refreshStructure(force) {
        const [tracks, scenes] = await Promise.all([
            this.live.value('/live/song/get/num_tracks', [], null),
            this.live.value('/live/song/get/num_scenes', [], null)
        ]);
        if (tracks === null || scenes === null) return;
        if (!force && tracks === this.counts.tracks && scenes === this.counts.scenes) return;
        const [names, sceneNames] = await Promise.all([this.live.getTrackNames(), this.live.getSceneNames()]);
        this.counts = { tracks, scenes };
        const changed = JSON.stringify(names) !== JSON.stringify(this.trackNames)
            || JSON.stringify(sceneNames) !== JSON.stringify(this.sceneNames);
        this.trackNames = names;
        this.sceneNames = sceneNames;
        if (changed) this.emit('state', this.publicState());
    }

    /** テンポ。通知を受けていなければ 1 回だけ問い合わせる */
    async currentTempo() {
        if (this.tempo === null) this.tempo = await this.live.getTempo();
        return this.tempo;
    }

    /**
     * あまり変わらないプロパティを、鳴るシーンが変わった時と SLOW_PROPS_MS ごとに読む。
     * file_path は viewWaves の波形の描き直しにつながるので、シーンが変わった時だけ読む
     */
    async slowProps(track, clip) {
        const key = `${track}_${clip}`;
        const cached = this.slowCache.get(key);
        const now = Date.now();
        if (cached && now - cached.at < SLOW_PROPS_MS) return cached.props;
        const props = cached ? SLOW_PROPS : [...SLOW_PROPS, 'file_path'];
        const fresh = await this.live.getClipState(track, clip, props);
        const merged = fresh ? { ...(cached ? cached.props : {}), ...fresh } : null;
        this.slowCache.set(key, { at: now, props: merged });
        return merged;
    }

    trackIndex(name) {
        if (!name) return -1;
        return this.trackNames.indexOf(name);
    }

    // ---- 監視 ----

    connected() {
        return Date.now() - this.live.lastMessageAt < DISCONNECT_MS;
    }

    /** 今鳴っているシーンの台帳を探す。BGM トラックの再生中スロットで判断する */
    async findActiveCue(show) {
        const bgmTracks = [...new Set(show.cues.map((c) => c.bgmTrack || show.bgmTrack))];
        const slots = {};
        await Promise.all(bgmTracks.map(async (name) => {
            const t = this.trackIndex(name);
            if (t >= 0) slots[name] = await this.live.value('/live/track/get/playing_slot_index', [t], -1);
        }));
        return show.cues.find((c) => slots[c.bgmTrack || show.bgmTrack] === c.scene) || null;
    }

    async monitor() {
        if (this.busy) return;
        this.busy = true;
        try {
            const quantization = await this.live.getQuantization();
            const connected = this.connected();
            if (connected && !this.wasConnected) this.onReconnected();
            this.wasConnected = connected;
            const tempo = connected ? await this.currentTempo() : this.tempo;
            const show = this.show();
            const snapshot = {
                connected, patchMissing: this.patchMissing, tempo, quantization,
                show, cue: null, bgm: null, ltc: null, ltcTrack: null, startTimes: null
            };
            const extra = [];
            let active = null;
            if (show && snapshot.connected && this.trackNames.length === 0) await this.refreshStructure(true);
            if (show && snapshot.connected) {
                const ltcIdx = this.trackIndex(show.ltcTrack);
                if (ltcIdx < 0) {
                    extra.push({ level: 'error', code: 'LTC_TRACK_NOT_FOUND', message: `LTC トラック「${show.ltcTrack}」が Live にありません` });
                } else {
                    // トラック名は読まない (name の返信で viewWaves が画面を更新するため)
                    const [mute, output] = await Promise.all([
                        this.live.value('/live/track/get/mute', [ltcIdx]),
                        this.live.value('/live/track/get/output_routing_type', [ltcIdx])
                    ]);
                    snapshot.ltcTrack = { track: ltcIdx, name: show.ltcTrack, mute, output };
                }
                for (const name of new Set(show.cues.map((c) => c.bgmTrack || show.bgmTrack))) {
                    if (this.trackIndex(name) < 0) {
                        extra.push({ level: 'warn', code: 'BGM_TRACK_NOT_FOUND', message: `BGM トラック「${name}」が Live にありません` });
                    }
                }
                const cue = await this.findActiveCue(show);
                if (cue) {
                    const bgmIdx = this.trackIndex(cue.bgmTrack || show.bgmTrack);
                    snapshot.cue = cue;
                    // 鳴るシーンが変わったら、あまり変わらないプロパティを読み直す
                    if (!this.active || this.active.scene !== cue.scene) this.slowCache.clear();
                    const [bgm, ltc, slots, bgmSlow, ltcSlow] = await Promise.all([
                        this.live.getClipState(bgmIdx, cue.scene, MONITOR_PROPS),
                        ltcIdx >= 0 ? this.live.getClipState(ltcIdx, cue.scene, MONITOR_PROPS) : null,
                        this.live.getPlayingSlots(ltcIdx >= 0 ? [bgmIdx, ltcIdx] : [bgmIdx]),
                        this.slowProps(bgmIdx, cue.scene),
                        ltcIdx >= 0 ? this.slowProps(ltcIdx, cue.scene) : null
                    ]);
                    // フォローアクションが有効なクリップを「鳴っている」と判断できるよう、鳴っているスロットを添える
                    snapshot.bgm = bgm ? { ...bgmSlow, ...bgm, playingSlot: slots[0] } : null;
                    snapshot.ltc = ltc ? { ...ltcSlow, ...ltc, playingSlot: slots[1] } : null;
                    if (ltcIdx >= 0 && snapshot.ltc) {
                        snapshot.ltcFileSeconds = this.fileSeconds(snapshot.ltc.filePath);
                        const [b, l] = await this.live.getStartTimes([[bgmIdx, cue.scene], [ltcIdx, cue.scene]]);
                        snapshot.startTimes = { bgm: b, ltc: l };
                        const changed = !this.active || this.active.scene !== cue.scene;
                        if (changed || Date.now() - this.lastTcEmit > 1500) this.listenLtc(ltcIdx, cue.scene);
                    }
                    active = { scene: cue.scene, cue, bgmTrack: bgmIdx, ltcTrack: ltcIdx };
                }
            }
            this.active = active;
            const issues = [...extra, ...evaluate(snapshot)];
            this.status = {
                connected: snapshot.connected,
                tempo,
                quantization,
                mode: this.mode,
                active: active ? {
                    scene: active.scene,
                    sceneName: this.sceneNames[active.scene] || '',
                    startTC: active.cue.startTC
                } : null,
                issues,
                checkedAt: Date.now()
            };
            this.emit('status', this.status);
        } catch (err) {
            console.error('[LtcSender] 監視中のエラー:', err);
        } finally {
            this.busy = false;
        }
    }

    /** WAV の長さ (秒)。読めなければ null。同じファイルは 1 回だけ読む */
    fileSeconds(filePath) {
        if (!filePath) return null;
        if (!this.fileSecondsCache.has(filePath)) {
            let seconds = null;
            try {
                const info = wavInfo(filePath);
                seconds = info ? info.seconds : null;
            } catch (err) {
                // Live が開いていて読めない等。BPM 違いの確認を省くだけにする
            }
            this.fileSecondsCache.set(filePath, seconds);
        }
        return this.fileSecondsCache.get(filePath);
    }

    /**
     * LTC クリップの再生位置の通知を受ける。他のパッケージが stop_listen すると止まるので、
     * 鳴るシーンが変わった時と、通知が 1.5 秒途切れた時に張り直す (AbletonOSC 側は同じキーなら 1 つにまとまる)
     */
    listenLtc(track, clip) {
        this.live.listenPosition(track, clip);
    }

    /** Live とつながり直した時 (Live の再起動など)。リスナーは消えているので張り直す */
    onReconnected() {
        this.tempo = null;
        this.slowCache.clear();
        this.live.send('/live/song/start_listen/tempo');
    }

    onLiveMessage(address, args) {
        if (address === '/live/song/get/tempo') {
            // 自分の問い合わせ・リスナーの通知・viewWaves の問い合わせへの返信のどれでも、今のテンポ
            this.tempo = args[0];
            return;
        }
        if (address !== '/live/clip/get/playing_position' || !this.active) return;
        const [track, clip, position] = args;
        if (track !== this.active.ltcTrack || clip !== this.active.scene) return;
        const now = Date.now();
        if (now - this.lastTcEmit < TC_EMIT_MS) return;
        this.lastTcEmit = now;
        const display = this.positionToTC(position, this.active.cue);
        if (display) this.emit('tc', display);
    }

    /** LTC クリップの位置 (拍) → 出ている時刻 */
    positionToTC(position, cue) {
        const show = this.show();
        const tempo = this.tempo;
        if (!show || !tempo || position === null || position === undefined) return null;
        const rate = tc.getRate(show.rate);
        const seconds = seek.beatsToSeconds(position, tempo);
        const r = tc.fileTimeToTC(seconds, tc.parseTC(cue.startTC), rate);
        return { text: tc.formatTC(r.tc, rate), seconds, scene: cue.scene, at: Date.now() };
    }

    // ---- LTC ファイル ----

    async createFile(scene) {
        const show = this.show();
        if (!show) throw new Error('ショーが選ばれていません');
        const cue = show.cues.find((c) => c.scene === scene);
        if (!cue) throw new Error(`シーン ${scene + 1} は台帳にありません`);
        const bgmIdx = this.trackIndex(cue.bgmTrack || show.bgmTrack);
        if (bgmIdx < 0) throw new Error(`BGM トラック「${cue.bgmTrack || show.bgmTrack}」が Live にありません`);
        const [tempo, bgm] = await Promise.all([
            this.currentTempo(),
            this.live.getClipState(bgmIdx, scene, ['file_path', 'end_marker', 'loop_end'])
        ]);
        if (!bgm) throw new Error(`シーン ${scene + 1} の BGM トラックにクリップがありません`);
        const duration = ltcFiles.bgmDuration(bgm.filePath, seek.clipEndBeats(bgm), tempo);
        if (!duration) throw new Error('曲の長さが分かりません');
        const made = ltcFiles.createLtcFile({ show, cue, bgmSeconds: duration.seconds });
        this.editLedger((data, s) => cues.upsertCue(s, { scene, ...made, durationSource: duration.source }));
        return { ...made, durationSource: duration.source };
    }

    // ---- 途中から再生・飛ばす ----

    /** 本番モードでは、画面で確認した操作だけを受け付ける */
    guard(confirmed) {
        if (this.mode === 'show' && !confirmed) throw new Error('本番モードでは確認が必要です');
    }

    /** シーンのクリップの状態に、トラックで今鳴っているスロット (playingSlot) を足して返す */
    async sceneClips(scene, props) {
        const tracks = await this.live.getSceneTracks(scene, this.trackNames.length);
        const [states, slots] = await Promise.all([
            Promise.all(tracks.map((t) => this.live.getClipState(t, scene, props))),
            this.live.getPlayingSlots(tracks)
        ]);
        return states
            .map((s, i) => (s ? { ...s, playingSlot: slots[i] } : null))
            .filter(Boolean);
    }

    async verifyAfter(clips, targetBeats, tempo) {
        await new Promise((r) => setTimeout(r, VERIFY_WAIT_MS));
        const res = await this.live.queryBundle([
            ['/live/song/get/current_song_time'],
            ...clips.map((c) => ['/live/clip/get/start_time', c.track, c.clip])
        ]);
        const songTime = res[0] ? res[0][0] : null;
        const startTimes = res.slice(1).map((r) => (r ? r[0] : null));
        // 送ってから読み直すまで (待ち時間 + 発音までの遅れ 0.4 秒) に進む分を許す
        const elapsed = seek.secondsToBeats((VERIFY_WAIT_MS + 1000) / 1000, tempo);
        return { tracks: clips.map((c) => c.track), startTimes, ...seek.verifyPositions(startTimes, songTime, targetBeats, elapsed) };
    }

    async startFrom(scene, seconds, confirmed) {
        this.guard(confirmed);
        const tempo = await this.currentTempo();
        const clips = await this.sceneClips(scene, SEEK_PROPS);
        const plan = seek.planStartFrom({ scene, clips, seconds, tempo });
        if (!plan.ok) return { ok: false, problems: plan.problems };
        await this.live.sendBundle(plan.messages);
        const verify = await this.verifyAfter(plan.targets, plan.beats, tempo);
        return { action: 'startFrom', scene, seconds, skipped: plan.skipped.map((c) => c.track), ...verify };
    }

    /**
     * @param {object} opts - { seconds } (曲の頭からの秒へ) か { deltaSeconds } (前後に何秒)
     */
    async jump(opts, confirmed) {
        this.guard(confirmed);
        if (!this.active) return { ok: false, problems: ['台帳のシーンが鳴っていません'] };
        const { scene, bgmTrack } = this.active;
        const tempo = await this.currentTempo();
        const clips = await this.sceneClips(scene, SEEK_PROPS);
        const referencePosition = await this.live.getExactPosition(bgmTrack, scene);
        const plan = seek.planJump({ clips, referencePosition, tempo, ...opts });
        if (!plan.ok) return { ok: false, problems: plan.problems };
        await this.live.sendBundle(plan.messages);
        const verify = await this.verifyAfter(plan.targets, plan.targetBeats, tempo);
        return { action: 'jump', scene, ...opts, skipped: plan.skipped.map((c) => c.track), ...verify };
    }
}

module.exports = { Controller };
