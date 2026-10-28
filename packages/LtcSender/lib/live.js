/**
 * AbletonOSC との通信。
 *
 * 送信は AbletonOSC (既定 127.0.0.1:11000) へ直接、返信は osc-router が複製転送してくる
 * このパッケージの oscPort で受ける。返信は全パッケージに届くので、他のパッケージが
 * 問い合わせた分の返信も流れてくる (アドレスと先頭の引数で自分の問い合わせと対応づける)。
 *
 * 約束: Live のプロジェクトを書き換える命令 (set 系) と stop_listen は送らない。
 * stop_listen は AbletonOSC 側で全パッケージ共通のリスナーを消してしまうため。
 */
const EventEmitter = require('events');
const { Client, Server, Bundle, Message } = require('node-osc');

/** OSC の float 型で送る (整数の値でも int にしない) */
const f32 = (value) => ({ type: 'float', value });

class Live extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string} opts.host - AbletonOSC のホスト
     * @param {number} opts.port - AbletonOSC の受信ポート (11000)
     * @param {number} opts.listenPort - このパッケージの受信ポート (osc-router からの転送先)
     * @param {number} [opts.timeout=1000] - 問い合わせの待ち時間 (ms)
     */
    constructor({ host, port, listenPort, timeout = 1000 }) {
        super();
        this.host = host;
        this.port = port;
        this.listenPort = listenPort;
        this.timeout = timeout;
        this.pending = new Set();
        this.lastMessageAt = 0;
        this.client = null;
        this.server = null;
    }

    start() {
        this.client = new Client(this.host, this.port);
        this.server = new Server(this.listenPort, '0.0.0.0');
        this.server.on('message', (msg) => this._onMessage(msg));
        this.server.on('bundle', (bundle) => {
            for (const el of bundle.elements) {
                if (Array.isArray(el)) this._onMessage(el);
            }
        });
        this.server.on('error', (err) => this.emit('error', err));
    }

    close() {
        if (this.client) this.client.close();
        if (this.server) this.server.close();
    }

    _onMessage(msg) {
        this.lastMessageAt = Date.now();
        const [address, ...args] = msg;
        for (const p of [...this.pending]) {
            if (p.match(address, args)) {
                this.pending.delete(p);
                clearTimeout(p.timer);
                p.resolve(address === '/live/error' ? null : args);
            }
        }
        this.emit('message', address, args);
    }

    send(address, ...args) {
        return new Promise((resolve) => {
            this.client.send(new Message(address, ...args), (err) => resolve(!err));
        });
    }

    /**
     * 複数のメッセージを 1 つの OSC バンドルで送る。AbletonOSC は 1 回の処理でまとめて実行する
     * @param {Array<[string, ...any]>} messages
     */
    sendBundle(messages) {
        const bundle = new Bundle(...messages.map(([address, ...args]) => new Message(address, ...args)));
        return new Promise((resolve) => {
            this.client.send(bundle, (err) => resolve(!err));
        });
    }

    /**
     * 問い合わせて返信を待つ。返信は「同じアドレスで、先頭の引数が送った引数と一致するもの」。
     * 返信が無い・エラーの場合は null。
     * @returns {Promise<any[]|null>} 送った引数を除いた残りの引数
     */
    query(address, ...args) {
        return new Promise((resolve) => {
            const p = {
                match: (addr, got) => {
                    if (addr === '/live/error') {
                        const text = String(got[0] ?? '');
                        return text.includes(address) && args.every((a) => text.includes(String(a)));
                    }
                    return addr === address && args.every((a, i) => got[i] === a);
                },
                resolve: (got) => resolve(got === null ? null : got.slice(args.length)),
                timer: null
            };
            p.timer = setTimeout(() => {
                this.pending.delete(p);
                resolve(null);
            }, this.timeout);
            this.pending.add(p);
            this.client.send(new Message(address, ...args), (err) => {
                if (err) {
                    this.pending.delete(p);
                    clearTimeout(p.timer);
                    resolve(null);
                }
            });
        });
    }

    /** 1 つの値だけ返る問い合わせ。無ければ fallback */
    async value(address, args = [], fallback = null) {
        const got = await this.query(address, ...args);
        return got && got.length > 0 ? got[0] : fallback;
    }

    // ---- 曲全体 ----

    getTempo() {
        return this.value('/live/song/get/tempo');
    }

    /** 0 = None (LOM の Song.clip_trigger_quantization) */
    getQuantization() {
        return this.value('/live/song/get/clip_trigger_quantization');
    }

    async getTrackNames() {
        const n = await this.value('/live/song/get/num_tracks', [], 0);
        const names = await Promise.all(
            Array.from({ length: n }, (_, i) => this.value('/live/track/get/name', [i]))
        );
        return names;
    }

    async getSceneNames() {
        const n = await this.value('/live/song/get/num_scenes', [], 0);
        return Promise.all(Array.from({ length: n }, (_, i) => this.value('/live/scene/get/name', [i], '')));
    }

    // ---- トラック・クリップ ----

    async getTrackState(track) {
        const [name, mute, volume, output] = await Promise.all([
            this.value('/live/track/get/name', [track]),
            this.value('/live/track/get/mute', [track]),
            this.value('/live/track/get/volume', [track]),
            this.value('/live/track/get/output_routing_type', [track])
        ]);
        return { track, name, mute, volume, output };
    }

    hasClip(track, clip) {
        return this.value('/live/clip_slot/get/has_clip', [track, clip], false);
    }

    /** クリップの状態。クリップが無ければ null */
    async getClipState(track, clip) {
        if (!(await this.hasClip(track, clip))) return null;
        const props = ['name', 'is_playing', 'is_triggered', 'playing_position', 'warping', 'warp_mode',
            'length', 'start_marker', 'end_marker', 'looping', 'file_path', 'sample_length'];
        const values = await Promise.all(props.map((p) => this.value(`/live/clip/get/${p}`, [track, clip])));
        const s = { track, clip };
        props.forEach((p, i) => {
            s[p.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = values[i];
        });
        return s;
    }

    /** シーンのクリップがあるトラックの番号の一覧 */
    async getSceneTracks(scene, trackCount) {
        const has = await Promise.all(Array.from({ length: trackCount }, (_, t) => this.hasClip(t, scene)));
        return has.map((h, t) => (h ? t : -1)).filter((t) => t >= 0);
    }

    /** 再生位置の通知を受け始める (止めない。osc-router 経由で他のパッケージにも届く) */
    listenPosition(track, clip) {
        return this.send('/live/clip/start_listen/playing_position', track, clip);
    }
}

module.exports = { Live, f32 };
