/**
 * 波形描画レイヤー（共有WebGLコンテキスト方式）
 *
 * 設計方針:
 *  1. WebGLコンテキストはアプリ全体で **1個だけ** 生成する。
 *     ブラウザの同時WebGLコンテキスト数の上限は概ね16であり、トラック毎に確保すると
 *     16トラックを超えるセットで古いコンテキストからロストし、波形が無言で消える。
 *     （WaveSurfer側は waveColor: transparent なので、WebGLが死ぬ＝完全に不可視になる）
 *  2. 共有コンテキストはオフスクリーンで描画し、結果を各トラックの2Dキャンバスへ
 *     drawImage で転送する。2Dコンテキストには個数上限が無いため、
 *     DOM構造と重ね順を一切変えずにコンテキスト数だけを1へ畳める。
 *  3. 描画は「可視範囲の頂点のみ」に限定する（vertexAttribPointer のオフセット指定）。
 *  4. 頂点インデックスは共有の小さなバッファ + uniform で合成し、
 *     トラック毎のインデックスバッファを廃止する（VRAM 約半減）。
 *  5. devicePixelRatio を考慮してバッキングストアを確保する（HiDPIでのボケ防止）。
 */

// LOD 0 は原データ（間引きなし）。1以降は min/max デシメーション。
const LOD_FACTORS = [0, 10, 100, 1000];

class SharedWaveformRenderer {
    constructor() {
        // オフスクリーンの描画用キャンバス（DOMには追加しない）
        this.canvas = document.createElement('canvas');
        this.canvas.width = 1;
        this.canvas.height = 1;

        this.gl = this.canvas.getContext('webgl', {
            antialias: false,
            // 2Dキャンバスへ drawImage で転送するため、合成規約を揃えて縁の暗化を防ぐ
            premultipliedAlpha: true,
            // 描画直後に blit するので本来は不要だが、ブラウザ差異に対する保険
            preserveDrawingBuffer: true
        });

        this.supported = !!this.gl;
        if (!this.supported) {
            console.error('[Waveform] WebGL is not supported in this browser. Falling back to WaveSurfer rendering.');
            return;
        }

        /** @type {Set<TrackWaveform>} 生存中のトラックレンダラー */
        this.renderers = new Set();
        /** @type {Set<TrackWaveform>} 次のフレームで再描画すべきレンダラー */
        this.dirty = new Set();
        this.flushHandle = null;

        this.contextLost = false;

        // 共有頂点IDバッファ（0,1,2,...）。可視範囲ぶんの長さがあれば足りる。
        this.vertexIdBuffer = this.gl.createBuffer();
        this.vertexIdCapacity = 0;
        this._ensureVertexIds(65536);

        this._initShaders();

        this.canvas.addEventListener('webglcontextlost', (e) => {
            // preventDefault しないと webglcontextrestored が発火しない
            e.preventDefault();
            this.contextLost = true;
            console.warn('[Waveform] WebGL context lost. Waiting for restore...');
        });

        this.canvas.addEventListener('webglcontextrestored', () => {
            console.warn('[Waveform] WebGL context restored. Rebuilding GPU resources.');
            this.contextLost = false;
            this.vertexIdBuffer = this.gl.createBuffer();
            this.vertexIdCapacity = 0;
            this._ensureVertexIds(65536);
            this._initShaders();
            // 各トラックへ「バッファを作り直したいのでPCMを再供給してほしい」と通知する
            this.renderers.forEach(r => r._handleContextRestored());
        });

        // リサイズ監視は共有側で1本だけ持つ（インスタンス毎に張るとリスナーがリークする）
        this._onWindowResize = () => this.renderers.forEach(r => r.resize());
        window.addEventListener('resize', this._onWindowResize);
    }

    /**
     * トラック1つぶんの描画ハンドルを生成する。
     * @param {HTMLCanvasElement} targetCanvas 転送先（各トラックのDOM上のcanvas）
     * @param {{color?: number[]}} options
     * @returns {TrackWaveform}
     */
    createTrackRenderer(targetCanvas, options = {}) {
        return new TrackWaveform(this, targetCanvas, options);
    }

    _ensureVertexIds(count) {
        if (count <= this.vertexIdCapacity) return;
        const gl = this.gl;
        // 伸長時の再確保を抑えるため2の冪で確保する
        let cap = Math.max(this.vertexIdCapacity || 1, 1024);
        while (cap < count) cap *= 2;

        const ids = new Float32Array(cap);
        for (let i = 0; i < cap; i++) ids[i] = i;

        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexIdBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, ids, gl.STATIC_DRAW);
        this.vertexIdCapacity = cap;
    }

    _initShaders() {
        const gl = this.gl;

        // a_v は「可視範囲の先頭からの連番」。実サンプル位置は u_indexBase からの合成で求める。
        // これにより巨大なインデックスバッファをトラック毎に持たずに済む。
        //
        // 精度について: 頂点シェーダの float は highp が保証され、2^24 (=16.7M) までの
        // 整数を誤差なく表現できる。44.1kHz なら約6分20秒ぶんに相当する。
        // これを超える素材では LOD0（最大ズーム時のみ使用）で1サンプル未満の誤差が出るが、
        // 最大ズームでも1ピクセルあたり44サンプルのため、表示上は影響しない。
        const vsSource = `
            attribute float a_v;
            attribute float a_amplitude;

            uniform float u_lodFactor;    // 0.0 = 原データ（間引きなし）
            uniform float u_indexBase;    // 可視範囲の先頭サンプル位置
            uniform float u_zoom;         // デバイスピクセル / サンプル
            uniform float u_offset;       // 横スクロール量（デバイスピクセル）
            uniform float u_canvasWidth;  // 描画領域の幅（デバイスピクセル）

            void main() {
                float idx;
                if (u_lodFactor == 0.0) {
                    idx = u_indexBase + a_v;
                } else {
                    // 2頂点で1チャンク（max と min）を構成する
                    float chunk = floor(a_v * 0.5);
                    float isMin = a_v - chunk * 2.0;
                    idx = u_indexBase + chunk * u_lodFactor + isMin * (u_lodFactor * 0.5);
                }

                float x_px = (idx * u_zoom) - u_offset;
                float x_clip = (x_px / u_canvasWidth) * 2.0 - 1.0;

                gl_Position = vec4(x_clip, a_amplitude, 0.0, 1.0);
            }
        `;

        const fsSource = `
            precision mediump float;
            uniform vec4 u_color;
            void main() {
                gl_FragColor = u_color;
            }
        `;

        const vertexShader = this._compileShader(gl.VERTEX_SHADER, vsSource);
        const fragmentShader = this._compileShader(gl.FRAGMENT_SHADER, fsSource);
        if (!vertexShader || !fragmentShader) return;

        this.program = gl.createProgram();
        gl.attachShader(this.program, vertexShader);
        gl.attachShader(this.program, fragmentShader);
        gl.linkProgram(this.program);

        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            console.error('[Waveform] Unable to link shader program: ' + gl.getProgramInfoLog(this.program));
            return;
        }

        gl.useProgram(this.program);

        this.locations = {
            a_v: gl.getAttribLocation(this.program, 'a_v'),
            a_amplitude: gl.getAttribLocation(this.program, 'a_amplitude'),
            u_lodFactor: gl.getUniformLocation(this.program, 'u_lodFactor'),
            u_indexBase: gl.getUniformLocation(this.program, 'u_indexBase'),
            u_zoom: gl.getUniformLocation(this.program, 'u_zoom'),
            u_offset: gl.getUniformLocation(this.program, 'u_offset'),
            u_canvasWidth: gl.getUniformLocation(this.program, 'u_canvasWidth'),
            u_color: gl.getUniformLocation(this.program, 'u_color')
        };
    }

    _compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error('[Waveform] Shader compile error: ' + gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    /** 再描画を次フレームへ予約する（同一フレーム内の重複描画をまとめる） */
    schedule(renderer) {
        if (!this.supported) return;
        this.dirty.add(renderer);
        if (this.flushHandle === null) {
            this.flushHandle = requestAnimationFrame(() => this._flush());
        }
    }

    _flush() {
        this.flushHandle = null;
        const pending = Array.from(this.dirty);
        this.dirty.clear();
        if (this.contextLost) return;

        // オフスクリーンキャンバスは全レンダラーを収容できるサイズへ伸長する（縮小はしない）
        let needW = 1;
        let needH = 1;
        pending.forEach(r => {
            if (!this.renderers.has(r)) return;
            // サイズが変わっていたら、描画倍率を再計算させてから描く
            if (r._measure()) r._notifyResize();
            needW = Math.max(needW, r.deviceWidth);
            needH = Math.max(needH, r.deviceHeight);
        });
        if (this.canvas.width < needW || this.canvas.height < needH) {
            this.canvas.width = Math.max(this.canvas.width, needW);
            this.canvas.height = Math.max(this.canvas.height, needH);
        }

        pending.forEach(r => {
            if (this.renderers.has(r)) r._draw();
        });
    }

    /** 共有リソースを解放する（ページ終了時以外は通常呼ばない） */
    destroy() {
        if (!this.supported) return;
        window.removeEventListener('resize', this._onWindowResize);
        Array.from(this.renderers).forEach(r => r.destroy());
        const ext = this.gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
    }
}

/**
 * トラック1つぶんの波形描画ハンドル。
 * GPUバッファは共有コンテキスト上に確保し、描画結果は自前の2Dキャンバスへ転送する。
 */
class TrackWaveform {
    constructor(shared, targetCanvas, options = {}) {
        this.shared = shared;
        this.canvas = targetCanvas;
        this.ctx = targetCanvas.getContext('2d');
        this.color = options.color || [1.0, 0.5, 0.0, 1.0];

        /** レイヤー毎の LOD 群。各要素は { factor, ampBuf, count } */
        this.lods = { A: null, B: null, C: null };
        this.lengths = { A: 0, B: 0, C: 0 };
        this.sampleRates = { A: 44100, B: 44100, C: 44100 };

        this.activeLayerKey = 'A';
        this.zoom = 1.0;    // CSSピクセル / サンプル
        this.offset = 0.0;  // 横スクロール量（CSSピクセル）
        this.dpr = 1;
        this.deviceWidth = 1;
        this.deviceHeight = 1;
        this.destroyed = false;

        /**
         * コンテキストロストからの復帰時に、PCMの再供給を要求するコールバック。
         * app.js 側で WaveSurfer の getDecodedData() を再度流し込む。
         * @type {null | (() => void)}
         */
        this.onContextRestored = null;

        /**
         * 描画サイズが変わった時に呼ばれるコールバック。
         * フィット表示の倍率（pxPerSec）はコンテナ幅に依存するため、
         * リサイズ後は app.js 側で再計算して setView() し直す必要がある。
         * @type {null | (() => void)}
         */
        this.onResize = null;

        this.resizeObserver = null;

        if (shared.supported) {
            shared.renderers.add(this);
            this._measure();

            // トラックボックスは max-height のアニメーションで開閉するため、
            // 「いつ可視サイズが確定するか」をイベントで待つのは当てにならない。
            // 実サイズの変化を直接監視して追従させる。
            if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement) {
                this.resizeObserver = new ResizeObserver(() => this.resize());
                this.resizeObserver.observe(this.canvas.parentElement);
            }
        }
    }

    /**
     * 転送先キャンバスのバッキングストアを devicePixelRatio に合わせる。
     * @returns {boolean} サイズが変化したか
     */
    _measure() {
        const parent = this.canvas.parentElement;
        if (!parent) return false;
        const rect = parent.getBoundingClientRect();

        // トラックボックスが非表示（max-height: 0）の間はサイズ0になるため据え置く
        if (rect.width <= 0 || rect.height <= 0) return false;

        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(rect.width * dpr));
        const h = Math.max(1, Math.round(rect.height * dpr));

        if (this.canvas.width === w && this.canvas.height === h && this.dpr === dpr) {
            return false;
        }

        this.dpr = dpr;
        this.canvas.width = w;
        this.canvas.height = h;
        this.deviceWidth = w;
        this.deviceHeight = h;
        return true;
    }

    resize() {
        if (this.destroyed || !this.shared.supported) return;
        // 実測・リサイズ通知・再描画はすべて _flush 側でまとめて行う
        // （ここで _measure() すると、_flush 側の差分検出が空振りして
        //   onResize が呼ばれなくなる）
        this.render();
    }

    _notifyResize() {
        if (this.onResize) this.onResize();
    }

    /**
     * @param {Float32Array} float32Array デコード済みのチャンネルデータ
     * @param {number} sampleRate サンプルレート
     * @param {string} layerKey 対象レイヤー ('A' | 'B' | 'C')
     */
    updateData(float32Array, sampleRate = 44100, layerKey = 'A') {
        if (this.destroyed || !this.shared.supported || this.shared.contextLost) return;

        this._releaseLayer(layerKey);

        this.lengths[layerKey] = float32Array.length;
        this.sampleRates[layerKey] = sampleRate;

        const layerLods = [];
        for (const factor of LOD_FACTORS) {
            layerLods.push(factor === 0
                ? this._createFullBuffer(float32Array)
                : this._createLOD(float32Array, factor));
        }
        this.lods[layerKey] = layerLods;

        if (layerKey === this.activeLayerKey) this.render();
    }

    _createFullBuffer(data) {
        const gl = this.shared.gl;
        const ampBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, ampBuf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        return { factor: 0, ampBuf, count: data.length };
    }

    _createLOD(data, factor) {
        const numChunks = Math.ceil(data.length / factor);
        const amplitudes = new Float32Array(numChunks * 2);

        for (let i = 0; i < numChunks; i++) {
            let min = 1.0;
            let max = -1.0;
            const start = i * factor;
            const end = Math.min(start + factor, data.length);
            for (let j = start; j < end; j++) {
                const val = data[j];
                if (val < min) min = val;
                if (val > max) max = val;
            }
            // max → min の順に並べ、1チャンクを縦線として描く
            amplitudes[i * 2] = max;
            amplitudes[i * 2 + 1] = min;
        }

        const gl = this.shared.gl;
        const ampBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, ampBuf);
        gl.bufferData(gl.ARRAY_BUFFER, amplitudes, gl.STATIC_DRAW);

        return { factor, ampBuf, count: amplitudes.length };
    }

    _releaseLayer(layerKey) {
        const gl = this.shared.gl;
        const lods = this.lods[layerKey];
        if (lods && !this.shared.contextLost) {
            lods.forEach(lod => {
                if (lod.ampBuf) gl.deleteBuffer(lod.ampBuf);
            });
        }
        this.lods[layerKey] = null;
        this.lengths[layerKey] = 0;
    }

    /**
     * 表示倍率とスクロール位置を設定する。
     * @param {number} pxPerSec 1秒あたりのCSSピクセル数
     * @param {number} scrollLeft 横スクロール量（CSSピクセル）
     */
    setView(pxPerSec, scrollLeft) {
        const sampleRate = this.sampleRates[this.activeLayerKey] || 44100;
        this.zoom = pxPerSec / sampleRate;
        this.offset = scrollLeft;
        this.render();
    }

    setActiveLayer(layerKey) {
        if (!this.lods.hasOwnProperty(layerKey)) return;
        this.activeLayerKey = layerKey;
        this.render();
    }

    /** 全レイヤーのGPUバッファを解放して描画を消す */
    clear() {
        if (this.destroyed || !this.shared.supported) return;
        Object.keys(this.lods).forEach(key => this._releaseLayer(key));
        this.render();
    }

    /**
     * このトラックが破棄されるときに必ず呼ぶ。
     * GPUバッファと共有レンダラーへの参照を解放する。
     */
    destroy() {
        if (this.destroyed) return;
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.shared.supported) {
            Object.keys(this.lods).forEach(key => this._releaseLayer(key));
            this.shared.renderers.delete(this);
            this.shared.dirty.delete(this);
        }
        this.onContextRestored = null;
        this.destroyed = true;
    }

    render() {
        if (this.destroyed || !this.shared.supported) return;
        this.shared.schedule(this);
    }

    _handleContextRestored() {
        // ロスト時点でGPU側のバッファは全て無効になっているので参照を捨てる
        Object.keys(this.lods).forEach(key => {
            this.lods[key] = null;
            this.lengths[key] = 0;
        });
        if (this.onContextRestored) this.onContextRestored();
    }

    /** 共有コンテキストで描画し、自前の2Dキャンバスへ転送する（_flush からのみ呼ばれる） */
    _draw() {
        const shared = this.shared;
        const gl = shared.gl;
        // 共有キャンバスは _flush で必要サイズまで伸長済みだが、念のため収まる範囲に丸める
        const w = Math.min(this.deviceWidth, shared.canvas.width);
        const h = Math.min(this.deviceHeight, shared.canvas.height);

        if (!this.ctx || w <= 0 || h <= 0) return;

        // 転送先は毎回クリアする（データ無しの場合はここで終了＝消去される）
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        const activeLods = this.lods[this.activeLayerKey];
        const length = this.lengths[this.activeLayerKey] || 0;
        if (length === 0 || !activeLods || !shared.program) return;

        // --- 共有キャンバスの左上を作業領域として使う ---
        // WebGLのビューポート原点は左下なので、上端に合わせるためY位置をずらす
        const vpY = shared.canvas.height - h;
        gl.viewport(0, vpY, w, h);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, vpY, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // CSSピクセル基準の値をデバイスピクセルへ換算する
        const zoomDev = this.zoom * this.dpr;
        const offsetDev = this.offset * this.dpr;

        if (zoomDev > 0) {
            // 描画対象を可視範囲だけに絞る（全長を1本のLINE_STRIPで描くとGPUが飽和する）
            const samplesPerPixel = 1 / zoomDev;
            let lodIndex = 0;
            if (samplesPerPixel > 1000) lodIndex = 3;
            else if (samplesPerPixel > 100) lodIndex = 2;
            else if (samplesPerPixel > 50) lodIndex = 1;
            const lod = activeLods[lodIndex];

            // 可視範囲のサンプル位置（線の連続性を保つため前後に1ピクセルぶん余裕を持たせる）
            const firstSample = Math.max(0, Math.floor((offsetDev - 1) / zoomDev));
            const lastSample = Math.min(length - 1, Math.ceil((offsetDev + w + 1) / zoomDev));

            if (lastSample >= firstSample) {
                let firstVertex;
                let vertexCount;
                let indexBase;

                if (lod.factor === 0) {
                    firstVertex = firstSample;
                    vertexCount = lastSample - firstSample + 1;
                    indexBase = firstSample;
                } else {
                    const firstChunk = Math.floor(firstSample / lod.factor);
                    const lastChunk = Math.min(
                        Math.floor((lod.count / 2) - 1),
                        Math.ceil(lastSample / lod.factor)
                    );
                    firstVertex = firstChunk * 2;
                    vertexCount = (lastChunk - firstChunk + 1) * 2;
                    indexBase = firstChunk * lod.factor;
                }

                vertexCount = Math.min(vertexCount, lod.count - firstVertex);

                if (vertexCount > 0) {
                    shared._ensureVertexIds(vertexCount);
                    gl.useProgram(shared.program);

                    // 振幅は「可視範囲の先頭」からバイトオフセットで読み出す
                    gl.bindBuffer(gl.ARRAY_BUFFER, lod.ampBuf);
                    gl.enableVertexAttribArray(shared.locations.a_amplitude);
                    gl.vertexAttribPointer(
                        shared.locations.a_amplitude, 1, gl.FLOAT, false, 0,
                        firstVertex * Float32Array.BYTES_PER_ELEMENT
                    );

                    // 頂点IDは全トラック・全LOD共通の連番バッファを使い回す
                    gl.bindBuffer(gl.ARRAY_BUFFER, shared.vertexIdBuffer);
                    gl.enableVertexAttribArray(shared.locations.a_v);
                    gl.vertexAttribPointer(shared.locations.a_v, 1, gl.FLOAT, false, 0, 0);

                    gl.uniform1f(shared.locations.u_lodFactor, lod.factor);
                    gl.uniform1f(shared.locations.u_indexBase, indexBase);
                    gl.uniform1f(shared.locations.u_zoom, zoomDev);
                    gl.uniform1f(shared.locations.u_offset, offsetDev);
                    gl.uniform1f(shared.locations.u_canvasWidth, w);
                    gl.uniform4fv(shared.locations.u_color, this.color);

                    gl.drawArrays(gl.LINE_STRIP, 0, vertexCount);
                }
            }
        }

        gl.disable(gl.SCISSOR_TEST);

        // 共有キャンバスの左上領域を、このトラックのキャンバスへ転送する
        this.ctx.drawImage(shared.canvas, 0, 0, w, h, 0, 0, w, h);
    }
}

// アプリ全体で共有する唯一のインスタンス
window.SharedWaveformRenderer = SharedWaveformRenderer;
window.sharedWaveformRenderer = new SharedWaveformRenderer();
