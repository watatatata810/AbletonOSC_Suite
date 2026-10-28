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

const MONITOR_MS = 1000;
const STRUCTURE_MS = 5000;
const DISCONNECT_MS = 3000;
const VERIFY_WAIT_MS = 500;
const TC_EMIT_MS = 50;
// 監視で読むクリップのプロパティ (AbletonOSC への負荷を抑えるため必要な分だけ)
const MONITOR_PROPS = ['is_playing', 'is_triggered', 'warping', 'warp_mode', 'end_marker', 'file_path'];
const SEEK_PROPS = ['is_playing', 'is_triggered', 'warping', 'end_marker', 'playing_position'];

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
        this.timers = [];
        this.busy = false;
    }

    start() {
        this.checkPatch();
        this.live.on('message', (address, args) => this.onLiveMessage(address, args));
        this.refreshStructure();
        this.timers.push(setInterval(() => this.refreshStructure(), STRUCTURE_MS));
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

    async refreshStructure() {
        const [names, scenes] = await Promise.all([this.live.getTrackNames(), this.live.getSceneNames()]);
        const changed = JSON.stringify(names) !== JSON.stringify(this.trackNames)
            || JSON.stringify(scenes) !== JSON.stringify(this.sceneNames);
        this.trackNames = names;
        this.sceneNames = scenes;
        if (changed) this.emit('state', this.publicState());
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
            const [tempo, quantization] = await Promise.all([this.live.getTempo(), this.live.getQuantization()]);
            const show = this.show();
            const snapshot = {
                connected: this.connected(), patchMissing: this.patchMissing, tempo, quantization,
                show, cue: null, bgm: null, ltc: null, ltcTrack: null, positions: null
            };
            const extra = [];
            let active = null;
            if (show && snapshot.connected && this.trackNames.length === 0) await this.refreshStructure();
            if (show && snapshot.connected) {
                const ltcIdx = this.trackIndex(show.ltcTrack);
                if (ltcIdx < 0) {
                    extra.push({ level: 'error', code: 'LTC_TRACK_NOT_FOUND', message: `LTC トラック「${show.ltcTrack}」が Live にありません` });
                } else {
                    snapshot.ltcTrack = await this.live.getTrackState(ltcIdx);
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
                    [snapshot.bgm, snapshot.ltc] = await Promise.all([
                        this.live.getClipState(bgmIdx, cue.scene, MONITOR_PROPS),
                        ltcIdx >= 0 ? this.live.getClipState(ltcIdx, cue.scene, MONITOR_PROPS) : null
                    ]);
                    if (ltcIdx >= 0 && snapshot.ltc) {
                        const [b, l] = await this.live.getPositions([[bgmIdx, cue.scene], [ltcIdx, cue.scene]]);
                        snapshot.positions = { bgm: b.position, ltc: l.position };
                        this.listenLtc(ltcIdx, cue.scene);
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

    /**
     * LTC クリップの再生位置の通知を受ける。他のパッケージが stop_listen すると止まるので、
     * 毎回の監視で張り直す (AbletonOSC 側は同じキーなら 1 つにまとまる)
     */
    listenLtc(track, clip) {
        this.live.listenPosition(track, clip);
    }

    onLiveMessage(address, args) {
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
        const tempo = this.status && this.status.tempo;
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
            this.live.getTempo(),
            this.live.getClipState(bgmIdx, scene, ['file_path', 'end_marker'])
        ]);
        if (!bgm) throw new Error(`シーン ${scene + 1} の BGM トラックにクリップがありません`);
        const duration = ltcFiles.bgmDuration(bgm.filePath, bgm.endMarker, tempo);
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

    async sceneClips(scene, props) {
        const tracks = await this.live.getSceneTracks(scene, this.trackNames.length);
        const states = await Promise.all(tracks.map((t) => this.live.getClipState(t, scene, props)));
        return states.filter(Boolean);
    }

    async verifyAfter(clips, targetBeats, tempo) {
        await new Promise((r) => setTimeout(r, VERIFY_WAIT_MS));
        const positions = await this.live.getPositions(clips.map((c) => [c.track, c.clip]));
        // 送ってから読み直すまで (待ち時間 + 発音までの遅れ 0.4 秒) に進む分を許す
        const elapsed = seek.secondsToBeats((VERIFY_WAIT_MS + 1000) / 1000, tempo);
        return { positions, ...seek.verifyPositions(positions, targetBeats, elapsed) };
    }

    async startFrom(scene, seconds, confirmed) {
        this.guard(confirmed);
        const tempo = await this.live.getTempo();
        const clips = await this.sceneClips(scene, SEEK_PROPS);
        const plan = seek.planStartFrom({ scene, clips, seconds, tempo });
        if (!plan.ok) return { ok: false, problems: plan.problems };
        await this.live.sendBundle(plan.messages);
        return { action: 'startFrom', scene, seconds, ...(await this.verifyAfter(clips, plan.beats, tempo)) };
    }

    /**
     * @param {object} opts - { seconds } (曲の頭からの秒へ) か { deltaSeconds } (前後に何秒)
     */
    async jump(opts, confirmed) {
        this.guard(confirmed);
        if (!this.active) return { ok: false, problems: ['台帳のシーンが鳴っていません'] };
        const { scene, bgmTrack } = this.active;
        const tempo = await this.live.getTempo();
        const clips = await this.sceneClips(scene, SEEK_PROPS);
        const [ref] = await this.live.getPositions([[bgmTrack, scene]]);
        const plan = seek.planJump({ clips, referencePosition: ref.position, tempo, ...opts });
        if (!plan.ok) return { ok: false, problems: plan.problems };
        await this.live.sendBundle(plan.messages);
        return { action: 'jump', scene, ...opts, ...(await this.verifyAfter(clips, plan.targetBeats, tempo)) };
    }
}

module.exports = { Controller };
