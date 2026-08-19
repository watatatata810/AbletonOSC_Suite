const socket = io();
// Text status was removed, we use body class instead
const waveformsContainer = document.getElementById('waveforms-container');

// グローバルなシーン名のキャッシュ（key: sceneIndex, value: name）
const globalSceneNames = {};

// ラグ補正（レイテンシ先読み）の設定値
let latencyOffsetMs = 0;
const latencySlider = document.getElementById('latency-slider');
const latencyValue = document.getElementById('latency-value');

function updateEmptyState() {
    const emptyMsg = document.getElementById('empty-state-message');
    if (!emptyMsg) return;
    
    const hasVisibleTrack = document.querySelector('.track-box.visible:not(.user-hidden)');
    if (hasVisibleTrack) {
        emptyMsg.classList.add('hidden');
    } else {
        emptyMsg.classList.remove('hidden');
    }
}

if (latencySlider && latencyValue) {
    latencySlider.addEventListener('input', (e) => {
        latencyOffsetMs = parseInt(e.target.value, 10);
        latencyValue.textContent = latencyOffsetMs;
    });
}

const syncButton = document.getElementById('sync-button');
if (syncButton) {
    syncButton.addEventListener('click', () => {
        // ボタンの視覚的フィードバック
        const originalText = syncButton.textContent;
        syncButton.textContent = '⏳ 同期中...';
        syncButton.style.opacity = '0.7';
        syncButton.style.pointerEvents = 'none';
        
        setTimeout(() => {
            syncButton.textContent = originalText;
            syncButton.style.opacity = '1';
            syncButton.style.pointerEvents = 'auto';
        }, 1000);

        Object.values(tracks).forEach(t => {
            t.boxEl.classList.remove('visible');
            t.currentSceneIndex = -1;
            t.infoEl.textContent = '同期中...';
        });
        socket.emit('force_sync');
        updateGlobalSceneStatus();
    });
}

// Track state
// key: trackId, value: { ws, containerEl }
const tracks = {};

// ==========================================
// トラック表示設定（メニューから切替、localStorage で永続化）
// ==========================================
// 再生状態を表す .visible とは独立に、ユーザー設定の .user-hidden で表示を抑制する。
// 音声のロードやシーンバッジの構成は従来通り動くため、隠したトラックのクリップも
// STANDBY/PLAYING の判定には寄与し続ける（表示だけを隠す）。
const HIDDEN_TRACKS_STORAGE_KEY = 'viewwaves.hiddenTracks';

const hiddenTracks = new Set((() => {
    try {
        const stored = JSON.parse(localStorage.getItem(HIDDEN_TRACKS_STORAGE_KEY));
        return Array.isArray(stored) ? stored.filter(Number.isInteger) : [];
    } catch (e) {
        return [];
    }
})());

const trackVisibilityList = document.getElementById('track-visibility-list');

function setTrackHidden(trackId, hidden) {
    if (hidden) {
        hiddenTracks.add(trackId);
    } else {
        hiddenTracks.delete(trackId);
    }
    localStorage.setItem(HIDDEN_TRACKS_STORAGE_KEY, JSON.stringify([...hiddenTracks]));

    const t = tracks[trackId];
    if (t) {
        t.boxEl.classList.toggle('user-hidden', hidden);
    }
    sortVisibleTracks();
    updateEmptyState();
}

function renderTrackVisibilityList() {
    if (!trackVisibilityList) return;

    trackVisibilityList.innerHTML = '';
    const trackIds = Object.keys(tracks).map(Number).sort((a, b) => a - b);

    trackIds.forEach(trackId => {
        const label = document.createElement('label');
        label.className = 'track-visibility-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !hiddenTracks.has(trackId);
        checkbox.addEventListener('change', (e) => setTrackHidden(trackId, !e.target.checked));

        const name = document.createElement('span');
        name.textContent = `${trackId + 1}. ${tracks[trackId].trackName}`;

        label.appendChild(checkbox);
        label.appendChild(name);
        trackVisibilityList.appendChild(label);
    });
}

/**
 * トラック1つぶんのリソースを完全に解放する。
 * WaveSurfer（3レイヤー）・共有WebGL上のGPUバッファ・ResizeObserver・
 * 実行中のアニメーションフレームをすべて後始末してからDOMを外す。
 */
function destroyTrack(trackId) {
    const t = tracks[trackId];
    if (!t) return;

    // 破棄済みオブジェクトへコールバックが走らないよう、先にループを止める
    if (t.animationFrameId) cancelAnimationFrame(t.animationFrameId);
    if (t.zoomRAFId) cancelAnimationFrame(t.zoomRAFId);
    t.animationFrameId = null;
    t.zoomRAFId = null;

    // A/B/C 全レイヤーの WaveSurfer を破棄する
    // （破棄漏れは AudioContext とデコード済みバッファをそのまま残す）
    Object.keys(t.layers).forEach(key => {
        const layer = t.layers[key];
        if (layer && layer.ws) {
            try {
                layer.ws.destroy();
            } catch (e) {
                console.warn(`[UI] Track ${trackId} layer ${key} の WaveSurfer 破棄に失敗:`, e);
            }
        }
    });

    // 共有WebGLコンテキスト上のバッファと監視を解放する
    if (t.webglWaveform) t.webglWaveform.destroy();

    if (t.boxEl) t.boxEl.remove();
    delete tracks[trackId];
}

function resetAllTracksUI() {
    // 既存のトラック要素をDOMから削除し、WaveSurferインスタンスを破棄する
    Object.keys(tracks).forEach(trackId => destroyTrack(trackId));

    // 他のUI関連グローバル変数をリセット
    isSongPlaying = false;
    selectedSceneIndex = -1;
    
    // empty-state-message (同期待ち/接続待ち) の表示状態を更新
    updateEmptyState();
    updateGlobalSceneStatus();
    console.log('[UI] Ableton切断に伴い、すべてのトラック表示を初期化しました。');
}

let isSongPlaying = false;
let selectedSceneIndex = -1;

// ==========================================
// 純粋関数群 (Pure Functions)
// ==========================================
// calculateAbsoluteProgress / calculateMarkerPercentages / calculateTimeDisplay /
// shouldResetTracksUI は public/waveform-math.js へ移動した。
// DOM に依存しないため Node からユニットテストできる（test/waveform-math.test.js）。
// ブラウザではグローバル関数として読み込まれるので、呼び出し方は従来どおり。

// ==========================================
// UI更新関数群 (UI Update Functions)
// ==========================================

function updateOverlayUI(trackId) {
    const t = tracks[trackId];
    if (!t) return;
    const overlayLeft = document.getElementById(`overlay-left-${trackId}`);
    const overlayRight = document.getElementById(`overlay-right-${trackId}`);
    if (!overlayLeft || !overlayRight) return;

    const startPct = t.startPct || 0;
    const endPct = t.endPct || 1;

    let fullWidth = waveformsContainer.clientWidth || window.innerWidth;
    let scrollLeft = 0;

    // ズーム中かつ波形がレンダリングされている場合は、実際のスクロール領域の幅を取得
    if (t.ws && t.ws.renderer && t.ws.renderer.scrollContainer) {
        fullWidth = t.currentZoom === 0 ? t.ws.renderer.scrollContainer.clientWidth : t.ws.renderer.scrollContainer.scrollWidth;
        scrollLeft = t.ws.renderer.scrollContainer.scrollLeft;
    }

    // 左側のグレーアウト
    const leftWidth = startPct * fullWidth;
    overlayLeft.style.width = `${leftWidth}px`;
    overlayLeft.style.transform = `translateX(${-scrollLeft}px)`;

    // 右側のグレーアウト
    const rightWidth = (1 - endPct) * fullWidth;
    overlayRight.style.width = `${rightWidth}px`;
    const rightPos = endPct * fullWidth - scrollLeft;
    overlayRight.style.transform = `translateX(${rightPos}px)`;
}

function updateTimerUI(trackId, timeData) {
    const t = tracks[trackId];
    if (t && t.timeEl) {
        if (t.timeEl.textContent !== timeData.text) {
            t.timeEl.textContent = timeData.text;
        }
        
        // カウントダウン状態のクラス切り替え（フェードアニメーション用）
        if (timeData.isCountdown) {
            if (!t.timeEl.classList.contains('countdown-active')) {
                t.timeEl.classList.add('countdown-active');
            }
        } else {
            if (t.timeEl.classList.contains('countdown-active')) {
                t.timeEl.classList.remove('countdown-active');
            }
        }
    }
}

function updatePlayheadUI(trackId, progress) {
    const t = tracks[trackId];
    if (!t) return;

    // WaveSurferの内部カーソルを更新
    if (t.ws) {
        t.ws.seekTo(progress);
    }
}

/**
 * 次のシーンの準備完了状態（Next Readyバッジ）を更新する
 */
function updateLayerBadgesUI(trackId) {
    const t = tracks[trackId];
    if (!t || !t.layerBadges) return;
    
    Object.keys(t.layers).forEach(key => {
        const layer = t.layers[key];
        const badge = t.layerBadges[key];
        
        badge.className = 'layer-badge';
        
        const isActive = t.activeLayerKey === key && layer.url;
        const prefix = isActive ? '<span class="badge-prefix">▶</span> ' : '<span class="badge-prefix"></span>';
        
        if (isActive) {
            badge.classList.add('active');
        }
        
        if (!layer.url) {
            badge.classList.add('status-empty');
            badge.innerHTML = `${prefix}${key} : ---`;
        } else {
            const sceneNum = layer.slotIndex + 1;
            if (layer.isReady) {
                badge.classList.add('status-ready');
                badge.innerHTML = `${prefix}${key} : Scene ${sceneNum}`;
            } else {
                badge.classList.add('status-loading');
                badge.innerHTML = `${prefix}${key} : Scene ${sceneNum} <span class="badge-spinner">↺</span>`;
            }
        }
    });
}

/**
 * 表示中のトラックを曲時間（短い順）でソートして再配置する
 */
function sortVisibleTracks() {
    const visibleTracks = Object.values(tracks).filter(t =>
        t.boxEl.classList.contains('visible') && !t.boxEl.classList.contains('user-hidden'));
    
    visibleTracks.sort((a, b) => {
        const durA = (a.ws && a.ws.getDuration() > 0) ? a.ws.getDuration() : Infinity;
        const durB = (b.ws && b.ws.getDuration() > 0) ? b.ws.getDuration() : Infinity;
        return durA - durB;
    });
    
    // appendChildでDOMを移動するとCSSアニメーションがキャンセルされてしまうため、
    // Flexboxの order プロパティを使用して見た目の順序だけを変更する
    visibleTracks.forEach((t, index) => {
        t.boxEl.style.order = index;
    });
}

/**
 * このアプリが依存している WaveSurfer の内部（非公開）API。
 * 公開APIではないため、バージョンが上がると予告なく消える可能性がある。
 * そのため package.json では wavesurfer.js を **完全固定** している（caret を付けない）。
 */
const REQUIRED_WAVESURFER_INTERNALS = [
    'reRender',          // ズーム時のスクロール自動補正をスキップするために差し替える
    'render',            // パッチ版 reRender から直接呼ぶ
    'scrollIntoView',    // 自前でカーソル制御するため無効化する
    'unsubscribeOnScroll' // パッチ版 reRender でリスナーを解除する
];

let waveSurferInternalsChecked = false;

/**
 * 依存している内部APIが揃っているかを起動時に1度だけ検証する。
 * 固定を外した／npm update した等でAPIが消えた場合、
 * 波形が無言で壊れるのではなく、原因が分かる形で気づけるようにする。
 */
function assertWaveSurferInternals(ws) {
    if (waveSurferInternalsChecked) return;
    waveSurferInternalsChecked = true;

    const renderer = ws.renderer;
    if (!renderer) {
        console.error('[WaveSurfer] renderer が見つかりません。wavesurfer.js のバージョンを確認してください（想定: 7.12.8）。');
        return;
    }

    const missing = REQUIRED_WAVESURFER_INTERNALS.filter(key => renderer[key] === undefined);
    if (missing.length > 0) {
        console.error(
            `[WaveSurfer] 依存している内部APIが見つかりません: ${missing.join(', ')}\n` +
            'wavesurfer.js のバージョンが想定（7.12.8）と異なる可能性があります。' +
            'ズーム・スクロール・波形描画が正しく動作しません。'
        );
    }
}

/**
 * WaveSurfer V7 の renderer.reRender() をモンキーパッチし、
 * フラグが立っている間はズーム時のスクロール自動補正をスキップさせる。
 *
 * 原本の reRender() は以下を行う:
 *   1. スクロールリスナーの解除
 *   2. progressWrapper の画面位置を保存
 *   3. render(audioData) で波形を再描画
 *   4. scrollLeft を補正してプレイヘッドの画面位置を維持 ← これがマウスズームの邪魔
 * パッチ版は手順4だけをスキップする。
 */
function patchReRenderForZoom(ws) {
    assertWaveSurferInternals(ws);

    const renderer = ws.renderer;
    const origReRender = renderer.reRender.bind(renderer);

    renderer._skipScrollCorrection = false;

    renderer.reRender = function () {
        if (this._skipScrollCorrection) {
            // スクロール補正なしで再描画だけ行う
            this.unsubscribeOnScroll.forEach(fn => fn());
            this.unsubscribeOnScroll = [];
            if (!this.audioData) return;
            this.render(this.audioData);
        } else {
            origReRender();
        }
    };
}

// ----------------------------------------------------
// 波形のズーム機能 (Ctrl + ホイール / ピンチ操作)
// requestAnimationFrame でバッチ処理し、1フレームにつき1回の再描画に抑える
// ----------------------------------------------------
const MAX_ZOOM = 1000; // 最大のズーム倍率 (px/sec)

/**
 * 累積されたdeltaYをもとに、1フレーム分のズーム処理を実行する。
 * wheel イベントが複数回発火しても render() は1回しか呼ばれない。
 */
/**
 * 累積されたdeltaYをもとに、1フレーム分のズーム処理を実行する。
 * wheel イベントが複数回発火しても render() は1回しか呼ばれない。
 */
function applyPendingZoom(trackId) {
    const t = tracks[trackId];
    if (!t) return;
    t.zoomRAFId = null;

    const accumulatedDelta = t.pendingZoomDelta;
    const mouseClientX = t.lastZoomMouseClientX;
    t.pendingZoomDelta = 0; // 消費済み

    if (accumulatedDelta === 0) return;

    // 現在のウィンドウ幅とトラック時間
    const outerContainerWidth = waveformsContainer.clientWidth || window.innerWidth;
    const duration = (t.ws && t.ws.getDuration()) || 0;
    const fitZoom = duration > 0 ? (outerContainerWidth / duration) : 10;

    const isZoomingIn = accumulatedDelta < 0;
    const oldEffectiveZoom = t.currentZoom === 0 ? fitZoom : t.currentZoom;

    if (t.currentZoom === 0 && isZoomingIn) {
        t.currentZoom = fitZoom;
    }

    if (t.currentZoom !== 0 || isZoomingIn) {
        const zoomFactor = 1 + (accumulatedDelta * -0.005);
        t.currentZoom *= zoomFactor;

        // fitZoom以下に下がった場合のみフィット表示(0)にスナップする
        if (t.currentZoom <= fitZoom) {
            t.currentZoom = 0;
        } else if (t.currentZoom > MAX_ZOOM) {
            t.currentZoom = MAX_ZOOM;
        }

        const newEffectiveZoom = t.currentZoom === 0 ? fitZoom : t.currentZoom;
        const activeWs = t.ws;

        if (activeWs && activeWs.getDuration() > 0) {
            const scrollContainer = activeWs.renderer.scrollContainer;
            const containerRect = scrollContainer.getBoundingClientRect();
            const mouseXInContainer = Math.max(0, mouseClientX - containerRect.left);

            const oldFullWidth = duration * oldEffectiveZoom;
            const oldScrollLeft = scrollContainer.scrollLeft;
            const contentPosUnderMouse = oldScrollLeft + mouseXInContainer;

            activeWs.renderer._skipScrollCorrection = true;
            activeWs.zoom(t.currentZoom === 0 ? false : t.currentZoom);
            activeWs.renderer._skipScrollCorrection = false;

            const newFullWidth = duration * newEffectiveZoom;
            const scaledPos = contentPosUnderMouse * (newFullWidth / oldFullWidth);
            const newScrollLeft = Math.max(0, scaledPos - mouseXInContainer);

            scrollContainer.scrollLeft = newScrollLeft;
            updateOverlayUI(trackId);
            
            // スクロールイベントが発火しない場合（0から0への移動など）に備えて明示的にWebGLを更新
            if (t.webglWaveform) {
                t.webglWaveform.setView(newEffectiveZoom, newScrollLeft);
            }
        }
    }
}

socket.on('connect', () => {
    document.body.className = 'status-waiting'; // サーバー接続時はまずオレンジ枠
});

socket.on('disconnect', () => {
    document.body.className = 'status-disconnected'; // サーバー切断時は赤枠
    resetAllTracksUI(); // 画面をクリーンアップ
});

socket.on('ableton_status', (data) => {
    if (data.connected) {
        document.body.className = 'status-connected'; // Ableton疎通時は緑枠
    } else {
        document.body.className = 'status-waiting'; // 疎通待ち時はオレンジ枠
        // 2段階タイムアウト（docs/260627-1548_ableton-two-stage-timeout-design.md §2.2）:
        // 4秒の一時切断（reset: false）では波形を残したまま枠だけオレンジ明滅させ、
        // Ableton側が生きている前提でカーソルのローカル補間を継続する。
        // 20秒超の完全切断（reset: true）でのみ画面を初期化する。
        // 判定は waveform-math.js の純粋関数に委譲し、テストで固定している。
        if (shouldResetTracksUI(data)) {
            resetAllTracksUI();
        }
    }
});

/**
 * 現在のズーム状態と実サイズから、WebGL側の表示範囲を再計算して同期する。
 * フィット表示（currentZoom === 0）の倍率はコンテナ幅に依存するため、
 * ウィンドウリサイズ後はこれを呼ばないと波形が旧サイズのまま取り残される。
 */
function syncWebGLView(trackId) {
    const t = tracks[trackId];
    if (!t || !t.ws || !t.webglWaveform) return;

    const duration = t.ws.getDuration();
    const scrollContainer = t.ws.renderer && t.ws.renderer.scrollContainer;
    if (!duration || !scrollContainer) return;

    const pxPerSec = t.currentZoom === 0
        ? (scrollContainer.clientWidth / duration)
        : t.currentZoom;
    t.webglWaveform.setView(pxPerSec, scrollContainer.scrollLeft);
}

function getOrCreateTrackUI(trackId) {
    if (tracks[trackId]) return tracks[trackId];

    const box = document.createElement('div');
    box.className = 'track-box';
    
    const header = document.createElement('div');
    header.className = 'track-header';
    
    const title = document.createElement('div');
    title.className = 'track-title';
    // Live uses 0-based index, so Track 0 is Track 1
    title.textContent = `Track ${trackId + 1}`;
    
    const info = document.createElement('div');
    info.className = 'track-info';
    info.id = `info-${trackId}`;
    info.textContent = '準備中...';
    
    header.appendChild(title);
    header.appendChild(info);
    
    const waveContainer = document.createElement('div');
    waveContainer.className = 'waveform';
    waveContainer.id = `waveform-${trackId}`;
    
    // ダブルバッファリング用のA面・B面レイヤー
    const wsLayerA = document.createElement('div');
    wsLayerA.className = 'ws-layer active';
    wsLayerA.id = `ws-layer-a-${trackId}`;
    
    const wsLayerB = document.createElement('div');
    wsLayerB.className = 'ws-layer inactive';
    wsLayerB.id = `ws-layer-b-${trackId}`;
    
    const wsLayerC = document.createElement('div');
    wsLayerC.className = 'ws-layer inactive';
    wsLayerC.id = `ws-layer-c-${trackId}`;
    
    // WebGL表示用レイヤー
    const webglCanvas = document.createElement('canvas');
    webglCanvas.className = 'webgl-layer';
    webglCanvas.id = `webgl-layer-${trackId}`;
    webglCanvas.style.position = 'absolute';
    webglCanvas.style.top = '0';
    webglCanvas.style.left = '0';
    webglCanvas.style.width = '100%';
    webglCanvas.style.height = '100%';
    webglCanvas.style.pointerEvents = 'none'; // クリック等を手前のWaveSurferに透過させる
    
    // オーバーレイを追加
    const overlayLeft = document.createElement('div');
    overlayLeft.className = 'overlay-left';
    overlayLeft.id = `overlay-left-${trackId}`;
    
    const overlayRight = document.createElement('div');
    overlayRight.className = 'overlay-right';
    overlayRight.id = `overlay-right-${trackId}`;
    
    const footerRow = document.createElement('div');
    footerRow.className = 'footer-row';
    
    const badgesWrapper = document.createElement('div');
    badgesWrapper.className = 'badges-wrapper';
    
    const layerBadges = {};
    ['A', 'B', 'C'].forEach(key => {
        const badge = document.createElement('div');
        badge.className = 'layer-badge status-empty';
        badge.innerHTML = `<span class="badge-prefix"></span>${key} : ---`;
        badgesWrapper.appendChild(badge);
        layerBadges[key] = badge;
    });
    
    const timeDisplay = document.createElement('div');
    timeDisplay.className = 'time-display';
    timeDisplay.id = `time-${trackId}`;
    timeDisplay.textContent = '00:00 / -00:00';
    
    footerRow.appendChild(badgesWrapper);
    footerRow.appendChild(timeDisplay);
    
    waveContainer.appendChild(wsLayerA);
    waveContainer.appendChild(wsLayerB);
    waveContainer.appendChild(wsLayerC);
    waveContainer.appendChild(webglCanvas);
    waveContainer.appendChild(overlayLeft);
    waveContainer.appendChild(overlayRight);
    
    box.appendChild(header);
    box.appendChild(waveContainer);
    box.appendChild(footerRow);
    
    waveformsContainer.appendChild(box);

    const wsOptions = {
        waveColor: 'transparent',
        progressColor: 'transparent',
        cursorColor: '#fff',
        cursorWidth: 2,
        height: 100,
        interact: false, // Prevent user clicking to seek
        autoScroll: true,  // overflow-x: auto を維持するため true (手動スクロール可能にする)
        autoCenter: false  // 自前で制御するため標準機能はオフ
    };

    const wsA = WaveSurfer.create({ container: `#ws-layer-a-${trackId}`, ...wsOptions });
    const wsB = WaveSurfer.create({ container: `#ws-layer-b-${trackId}`, ...wsOptions });
    const wsC = WaveSurfer.create({ container: `#ws-layer-c-${trackId}`, ...wsOptions });

    // WebGLコンテキストはアプリ全体で1個を共有し、ここではその描画ハンドルだけを受け取る
    // （トラック毎にコンテキストを確保すると、16トラック超のセットで上限に達して波形が消える）
    const webglWaveform = window.sharedWaveformRenderer.createTrackRenderer(webglCanvas, {
        color: [1.0, 0.596, 0.0, 1.0]
    });

    // GPUリセット等でコンテキストが失われた場合、デコード済みデータから作り直す
    webglWaveform.onContextRestored = () => {
        const t = tracks[trackId];
        if (!t) return;
        Object.keys(t.layers).forEach(key => {
            const decoded = t.layers[key].ws && t.layers[key].ws.getDecodedData();
            if (decoded) {
                webglWaveform.updateData(decoded.getChannelData(0), decoded.sampleRate, key);
            }
        });
        webglWaveform.setActiveLayer(t.activeLayerKey);
    };

    // ウィンドウリサイズ等で描画領域の実サイズが変わった時、
    // フィット表示の倍率とマーカーのグレーアウト位置を追従させる
    webglWaveform.onResize = () => {
        if (!tracks[trackId]) return;
        syncWebGLView(trackId);
        updateOverlayUI(trackId);
    };

    // スクロール時にもオーバーレイとWebGL位置を追従させる
    // （A/B/C で処理は同一。アクティブなレイヤーのスクロールだけを WebGL に反映する）
    Object.entries({ A: wsA, B: wsB, C: wsC }).forEach(([layerKey, ws]) => {
        ws.on('scroll', () => {
            updateOverlayUI(trackId);
            const t = tracks[trackId];
            if (t && t.activeLayerKey === layerKey) {
                syncWebGLView(trackId);
            }
        });
    });

    // WaveSurfer標準のジャンプスクロールを無効化（自前で滑らかに制御するため）
    // 3レイヤーすべてに適用する（漏らすとそのレイヤーがアクティブな時だけ挙動が変わる）
    wsA.renderer.scrollIntoView = () => {};
    wsB.renderer.scrollIntoView = () => {};
    wsC.renderer.scrollIntoView = () => {};
    
    patchReRenderForZoom(wsA);
    patchReRenderForZoom(wsB);
    patchReRenderForZoom(wsC);

    tracks[trackId] = {
        layers: {
            A: { ws: wsA, el: wsLayerA, url: null, slotIndex: -1, isReady: false },
            B: { ws: wsB, el: wsLayerB, url: null, slotIndex: -1, isReady: false },
            C: { ws: wsC, el: wsLayerC, url: null, slotIndex: -1, isReady: false }
        },
        webglWaveform: webglWaveform,
        activeLayerKey: 'A',
        currentZoom: 0,
        pendingZoomDelta: 0,
        lastZoomMouseClientX: 0,
        zoomRAFId: null,
        // ゲッター/セッターを用いて既存コードからの後方互換性を保つ
        get ws() { return this.layers[this.activeLayerKey].ws; },
        get loadedUrl() { return this.layers[this.activeLayerKey].url; },
        set loadedUrl(url) { this.layers[this.activeLayerKey].url = url; },
        
        infoEl: info,
        titleEl: title,
        boxEl: box,
        timeEl: timeDisplay,
        layerBadges: layerBadges,
        currentSceneIndex: -1,
        fileName: null,
        sceneName: null,
        trackName: `Track ${trackId + 1}`,
        lastProgress: 0,
        currentProgress: 0,
        velocity: 0,
        firstPositionTime: undefined,
        currentOffsetProgress: undefined,
        justLooped: false,
        animationFrameId: null,
        startPct: 0,
        endPct: 1,
        markerData: null
    };

    waveContainer.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault();
            const t = tracks[trackId];
            t.pendingZoomDelta += e.deltaY;
            t.lastZoomMouseClientX = e.clientX;
            if (!t.zoomRAFId) {
                t.zoomRAFId = requestAnimationFrame(() => applyPendingZoom(trackId));
            }
        }
    }, { passive: false });

    /**
     * レイヤーのデコード完了時の処理。A/B/C で内容が完全に同じなので生成関数にまとめる。
     * 非アクティブなレイヤーでも即座にWebGLバッファを構築しておく（プリレンダリング）ことで、
     * シーン切り替え時にレイヤーを差し替えるだけで表示が完了する。
     */
    const makeOnReady = (layerKey, ws) => () => {
        const t = tracks[trackId];
        if (!t) return; // 破棄済みトラックのready通知は無視する

        t.layers[layerKey].isReady = true;
        webglWaveform.resize();

        const decoded = ws.getDecodedData();
        if (decoded) {
            webglWaveform.updateData(decoded.getChannelData(0), decoded.sampleRate, layerKey);
        }

        if (t.currentZoom !== 0) {
            ws.zoom(t.currentZoom);
        }

        // ロード完了時にアクティブなレイヤーであれば、初期ズームとスクロール位置を適用する
        if (t.activeLayerKey === layerKey) {
            syncWebGLView(trackId);
        }

        updateTrackMarkers(t);
        updateLayerBadgesUI(trackId);
        sortVisibleTracks();
        updateGlobalSceneStatus();
    };

    wsA.on('ready', makeOnReady('A', wsA));
    wsB.on('ready', makeOnReady('B', wsB));
    wsC.on('ready', makeOnReady('C', wsC));

    if (hiddenTracks.has(trackId)) {
        box.classList.add('user-hidden');
    }
    renderTrackVisibilityList();

    return tracks[trackId];
}

function updateTrackTitle(trackId) {
    const t = tracks[trackId];
    if (!t) return;
    
    // 「トラック名」 - 「シーン名」「『ファイル名』」 の形式で表示
    let text = t.trackName;
    
    if (t.sceneName || t.fileName) {
        text += ' - ';
        if (t.sceneName) text += t.sceneName;
        if (t.fileName) text += `『${t.fileName}』`;
    }
    
    t.titleEl.textContent = text;
}

socket.on('clip_playing', (data) => {
    const { trackId, slotIndex, filePath } = data;
    const t = getOrCreateTrackUI(trackId);
    
    // 違うクリップ（または同じトラックの別シーン）が再生された場合、完全にリセットする
    if (t.currentSceneIndex !== slotIndex) {
        t.firstPositionTime = undefined;
        t.baseProgress = 0;
        t.currentOffsetProgress = undefined;
        t.lastProgress = 0;
        t.currentProgress = undefined;
        t.justLooped = false;
    }
    
    t.infoEl.textContent = `Scene ${slotIndex + 1} `;
    t.currentSceneIndex = slotIndex;
    
    // ファイルパスからファイル名を抽出 (Windowsの\とMacの/両対応)
    t.fileName = filePath.split(/[\\/]/).pop();
    t.sceneName = null; // シーン名を受信するまでリセット
    updateTrackTitle(trackId);
    
    // 一番上に移動し、アニメーションクラスを追加
    waveformsContainer.prepend(t.boxEl);
    
    // アニメーションを確実に発火させるため、少しだけ遅延させる
    setTimeout(() => {
        t.boxEl.classList.add('visible');
        sortVisibleTracks();
        updateEmptyState();
    }, 10);
    
    const url = `/audio?path=${encodeURIComponent(filePath)}`;
    
    // すでにアクティブなレイヤーで読み込み済みの場合は何もしない
    if (t.layers[t.activeLayerKey].url === url) {
        t.layers[t.activeLayerKey].slotIndex = slotIndex;
        updateLayerBadgesUI(trackId);
        return;
    }
    
    // アクティブ以外のレイヤーの中に、すでにその URL がプリロードされているか探す
    let swapTargetKey = null;
    Object.keys(t.layers).forEach(key => {
        if (key !== t.activeLayerKey && t.layers[key].url === url) {
            swapTargetKey = key;
        }
    });
    
    if (swapTargetKey) {
        const activeLayer = t.layers[t.activeLayerKey];
        const targetLayer = t.layers[swapTargetKey];
        
        // クラスを切り替えてフェードアニメーションを発動
        activeLayer.el.classList.remove('active');
        activeLayer.el.classList.add('inactive');
        
        targetLayer.el.classList.remove('inactive');
        targetLayer.el.classList.add('active');
        
        t.activeLayerKey = swapTargetKey;
        t.layers[swapTargetKey].slotIndex = slotIndex;
        
        // 新しくアクティブになった WaveSurfer に現在のズーム倍率を適用
        if (t.ws && t.ws.getDecodedData()) {
            t.ws.zoom(t.currentZoom === 0 ? false : t.currentZoom);
            // WebGL側は事前に転送（プリレンダリング）が完了しているため、アクティブレイヤーをスワップするだけで完了
            t.webglWaveform.setActiveLayer(swapTargetKey);
            
            // スワップ直後に最新のズームとスクロール位置をWebGLに同期する
            syncWebGLView(trackId);
        }
        
        // スワップされた（元アクティブだった）レイヤーをリセットする
        activeLayer.url = null;
        activeLayer.slotIndex = -1;
        activeLayer.isReady = false;
        activeLayer.ws.empty();
        
        updateLayerBadgesUI(trackId);
        
        console.log(`[Swap] Track ${trackId + 1} instantly switched to preloaded layer ${swapTargetKey}`);
    } else {
        // プリロードされていなければ、従来通りアクティブなレイヤーにロードする
        console.log(`[Load] Loading audio for Track ${trackId + 1}: ${url}`);
        const activeLayer = t.layers[t.activeLayerKey];
        activeLayer.url = url;
        activeLayer.slotIndex = slotIndex;
        activeLayer.isReady = false;
        
        // 新規ロード時には、現在のアクティブレイヤーを描画対象として設定しておく
        t.webglWaveform.setActiveLayer(t.activeLayerKey);
        
        updateLayerBadgesUI(trackId);
        activeLayer.ws.load(url).catch(err => {
            if (err.name !== 'AbortError') console.error('WaveSurfer load error:', err);
        });
    }
    updateGlobalSceneStatus();
});

socket.on('clip_stopped', (data) => {
    const { trackId } = data;
    if (tracks[trackId]) {
        const t = tracks[trackId];
        t.infoEl.textContent = '停止中';
        t.currentSceneIndex = -1;
        t.fileName = null;
        t.sceneName = null;
        
        Object.keys(t.layers).forEach(key => {
            const layer = t.layers[key];
            layer.url = null;
            layer.slotIndex = -1;
            layer.isReady = false;
            layer.ws.empty();
        });
        
        // WebGLバッファメモリを解放して描画をクリア
        t.webglWaveform.clear();
        
        updateLayerBadgesUI(trackId);
        updateTrackTitle(trackId);
        
        // アニメーションを停止し、変数をリセット
        cancelAnimationFrame(t.animationFrameId);
        t.animationFrameId = null;
        t.velocity = 0;
        t.lastPositionTime = 0;
        t.firstPositionTime = undefined;
        t.currentOffsetProgress = undefined;
        
        // 瞬時に非表示にする（アニメーションなし）
        t.boxEl.classList.remove('visible');
        updateEmptyState();
    }
    updateGlobalSceneStatus();
});

socket.on('song_stopped', () => {
    isSongPlaying = false;
    Object.values(tracks).forEach(t => {
        // 全トラックの波形を非表示にする
        t.boxEl.classList.remove('visible');
        
        // アニメーションを停止
        cancelAnimationFrame(t.animationFrameId);
        t.animationFrameId = null;
        t.firstPositionTime = undefined; // 次回再開時に基準時間をリセットさせる
        
        if (t.currentSceneIndex >= 0) {
            t.infoEl.textContent = '一時停止中';
        }
    });
    updateEmptyState();
    updateGlobalSceneStatus();
});

socket.on('song_playing', () => {
    isSongPlaying = true;
    Object.values(tracks).forEach(t => {
        if (t.currentSceneIndex >= 0) {
            // 再生中のクリップがあるトラックのみ再表示
            t.boxEl.classList.add('visible');
            t.infoEl.textContent = `Scene ${t.currentSceneIndex + 1} `;
            // 再生再開・再トリガー時にAbletonの実際の位置から同期し直すためリセット
            // 次の clip_position イベントで firstPositionTime と baseProgress が正しく設定される
            t.firstPositionTime = undefined;
            t.currentProgress = undefined;
        }
    });
    updateEmptyState();
    updateGlobalSceneStatus();
});

socket.on('clip_position', (data) => {
    let { trackId, slotIndex, progress, position } = data;
    const t = tracks[trackId];
    if (t) {
        // サーバーから送られた生のpositionを使って、マーカー表示時と完全に同じ分母でprogressを再計算する
        // （純粋関数に委譲してロジックを分離）
        if (t.ws && t.ws.getDuration() > 0) {
            progress = calculateAbsoluteProgress(position, t.markerData, t.ws.getDuration());
        }

        // サーバーが古いバージョン（slotIndex未定義）の場合はスキップしない
        if (slotIndex !== undefined && t.currentSceneIndex !== slotIndex) {
            // console.log(`[IGNORE] 遅延パケット無視: Track ${trackId + 1}, 現在のScene ${t.currentSceneIndex + 1} !== パケットのScene ${slotIndex + 1}`);
            return;
        }
        
        if (!isSongPlaying) return; // 一時停止中は何もしない
        
        const now = performance.now();
        
        // 初回、大きな前方ジャンプ（シーク等）、または「過去への巻き戻り（ループや再トリガー）」を確実に検出
        // ※以前は5%以上のジャンプのみを検出していたため、曲の序盤（数秒以内）で再トリガーした際に巻き戻りを検知できず波形が戻らないバグが発生していました
        if (t.firstPositionTime === undefined || (progress - (t.lastProgress || 0)) > 0.05 || progress < (t.lastProgress || 0) - 0.001) {
            t.firstPositionTime = now;
            t.baseProgress = progress; // シーク時の基準位置
            t.justLooped = true;
            t.currentOffsetProgress = undefined; // オフセット履歴もリセット
            t.currentProgress = undefined;       // 後退防止ガードもリセット（同シーン再トリガー対応）
        }
        
        // Abletonからの進行度は基準として保持（ローカルアニメーションの絶対的な速度計算には使わない）
        t.lastProgress = progress;
        t.lastPositionTime = now;
        
        // ローカル補間アニメーションが回っていなければ開始
        if (!t.animationFrameId) {
            t.animationFrameId = requestAnimationFrame(() => animateCursor(trackId));
        }
    }
});

function animateCursor(trackId) {
    const t = tracks[trackId];
    if (!t || t.currentSceneIndex === -1) {
        if (t) t.animationFrameId = null;
        return; // 停止状態ならアニメーション終了
    }
    
    const now = performance.now();
    const durationMs = t.ws && t.ws.getDuration() ? t.ws.getDuration() * 1000 : 0;
    
    if (durationMs === 0 || t.firstPositionTime === undefined) {
        // 波形がまだロードされていない、または初回パケット未受信の場合は待機
        t.animationFrameId = requestAnimationFrame(() => animateCursor(trackId));
        return;
    }
    
    // プレイヘッドは波形全体の幅（0〜1）に対する絶対的な割合として描画されるため、
    // velocity（1ミリ秒あたりの進行度）は常に「1 / 波形全体の実時間」とする必要があります。
    // （※スタートポイントをずらした際にプレイヘッドが加速してしまうバグを修正）
    t.velocity = 1 / Math.max(durationMs, 1);
    
    // ラグ補正（先読み）による目標オフセット値
    const targetOffsetProgress = t.velocity * latencyOffsetMs;
    
    // オフセット値の急変によるワープを防ぐため、滑らかに追従させる
    if (t.currentOffsetProgress === undefined) {
        t.currentOffsetProgress = targetOffsetProgress;
    } else {
        // 60fps環境で約0.1秒かけて滑らかに変化させる
        t.currentOffsetProgress = t.currentOffsetProgress * 0.85 + targetOffsetProgress * 0.15;
    }
    
    // 「再生開始位置」＋「実時間経過による物理的な進行」＋「滑らかなラグ補正オフセット」
    // Abletonからの狂ったprogressを使わず、自分自身のストップウォッチで完璧に進行させます
    const elapsedMs = now - t.firstPositionTime;
    let extrapolatedProgress = t.baseProgress + (t.velocity * elapsedMs) + t.currentOffsetProgress;
    extrapolatedProgress = Math.min(Math.max(extrapolatedProgress, 0), 1);
    
    // カーソルの「後ろへのワープ」を物理的に防止する最終保護処理
    if (t.currentProgress !== undefined) {
        if (t.justLooped) {
            t.justLooped = false; // ループ直後の1回だけワープ（巻き戻り）を許可
        } else if (extrapolatedProgress < t.currentProgress) {
            extrapolatedProgress = t.currentProgress; // それ以外は絶対に戻さない
        }
    }
    t.currentProgress = extrapolatedProgress;
    
    // 時間表示の更新
    const startPct = t.startPct || 0;
    const endPct = t.endPct || 1;
    const timeData = calculateTimeDisplay(extrapolatedProgress, durationMs, startPct, endPct);
    updateTimerUI(trackId, timeData);
    
    // WaveSurferのカーソルを進める
    updatePlayheadUI(trackId, extrapolatedProgress);
    
    // 次のフレームも実行
    t.animationFrameId = requestAnimationFrame(() => animateCursor(trackId));
}

/**
 * シーン名を1件取り込み、そのシーンを再生中のトラックのタイトルにも反映する。
 * 表示側は名前が空なら "Scene N" にフォールバックするため、
 * 名前無しのシーンをそのまま渡しても問題ない。
 */
function applySceneName(sceneIndex, name) {
    globalSceneNames[sceneIndex] = name;
    Object.keys(tracks).forEach(trackId => {
        const t = tracks[trackId];
        if (t.currentSceneIndex === sceneIndex) {
            t.sceneName = name;
            updateTrackTitle(parseInt(trackId));
        }
    });
}

socket.on('scene_name', (data) => {
    applySceneName(data.sceneIndex, data.name);
    updateGlobalSceneStatus();
});

// 全シーン名の一括受信。
// 以前は「再生を開始したシーン」の名前しか取得していなかったため、
// スタンバイ中のシーンは名前が付いていても "Scene N" と表示されていた。
socket.on('scene_names', (names) => {
    Object.keys(names).forEach(index => {
        applySceneName(Number(index), names[index]);
    });
    updateGlobalSceneStatus();
});

socket.on('track_name', (data) => {
    const { trackId, name } = data;
    const t = getOrCreateTrackUI(trackId);
    t.trackName = name;
    updateTrackTitle(trackId);
    renderTrackVisibilityList();
});

socket.on('selected_scene_changed', (data) => {
    selectedSceneIndex = data.sceneIndex;
    Object.keys(tracks).forEach(trackId => {
        updateLayerBadgesUI(trackId);
    });
    updateGlobalSceneStatus();
});

// 次のシーンの音声ファイルを裏でダウンロード（キャッシュ）しておく処理
socket.on('clip_preload', (data) => {
    const { trackId, slotIndex, filePath } = data;
    const url = `/audio?path=${encodeURIComponent(filePath)}`;
    
    const t = getOrCreateTrackUI(trackId);
    
    // すでにいずれかのレイヤーで読み込まれているかチェック
    let exists = false;
    Object.keys(t.layers).forEach(key => {
        if (t.layers[key].url === url) {
            t.layers[key].slotIndex = slotIndex;
            exists = true;
        }
    });
    if (exists) {
        updateLayerBadgesUI(trackId);
        return;
    }
    
    const inactiveKeys = Object.keys(t.layers).filter(key => key !== t.activeLayerKey);
    let targetKey = inactiveKeys.find(key => t.layers[key].url === null);
    
    if (!targetKey) {
        targetKey = inactiveKeys.find(key => t.layers[key].slotIndex !== selectedSceneIndex);
    }
    if (!targetKey) {
        targetKey = inactiveKeys[0];
    }
    
    console.log(`[Preload] Decoding NEXT READY audio in background layer ${targetKey} for Track ${trackId + 1}: ${url}`);
    const layer = t.layers[targetKey];
    layer.url = url;
    layer.slotIndex = slotIndex;
    layer.isReady = false;
    
    updateLayerBadgesUI(trackId);
    
    layer.ws.load(url).catch(err => {
        if (err.name !== 'AbortError') console.error('Preload WaveSurfer load error:', err);
    });
    updateGlobalSceneStatus();
});

socket.on('clip_selected_preload', (data) => {
    const { trackId, slotIndex, filePath } = data;
    
    if (selectedSceneIndex !== slotIndex) return;
    
    const url = `/audio?path=${encodeURIComponent(filePath)}`;
    const t = getOrCreateTrackUI(trackId);
    
    let exists = false;
    Object.keys(t.layers).forEach(key => {
        if (t.layers[key].url === url) {
            t.layers[key].slotIndex = slotIndex;
            exists = true;
        }
    });
    if (exists) {
        updateLayerBadgesUI(trackId);
        return;
    }
    
    const nextSlot = t.currentSceneIndex + 1;
    const inactiveKeys = Object.keys(t.layers).filter(key => key !== t.activeLayerKey);
    
    let targetKey = inactiveKeys.find(key => t.layers[key].url === null);
    if (!targetKey) {
        targetKey = inactiveKeys.find(key => t.layers[key].slotIndex !== nextSlot);
    }
    if (!targetKey) {
        targetKey = inactiveKeys[0];
    }
    
    console.log(`[Preload] Decoding SELECTED PRE LOAD audio in background layer ${targetKey} for Track ${trackId + 1}: ${url}`);
    const layer = t.layers[targetKey];
    layer.url = url;
    layer.slotIndex = slotIndex;
    layer.isReady = false;
    
    updateLayerBadgesUI(trackId);
    
    layer.ws.load(url).catch(err => {
        if (err.name !== 'AbortError') console.error('Selected preload WaveSurfer load error:', err);
    });
    updateGlobalSceneStatus();
});

socket.on('clip_selected_preload_empty', (data) => {
    const { trackId, slotIndex } = data;
    if (selectedSceneIndex !== slotIndex) return;
    
    const t = getOrCreateTrackUI(trackId);
    
    Object.keys(t.layers).forEach(key => {
        if (key !== t.activeLayerKey && t.layers[key].slotIndex === slotIndex) {
            const layer = t.layers[key];
            layer.url = null;
            layer.slotIndex = -1;
            layer.isReady = false;
            layer.ws.empty();
        }
    });
    
    updateLayerBadgesUI(trackId);
    updateGlobalSceneStatus();
});

// マーカー情報を受信したときの処理
socket.on('clip_markers', (data) => {
    const trackId = data.trackId;
    const t = tracks[trackId];
    if (t && t.currentSceneIndex === data.slotIndex) {
        t.markerData = data;
        updateTrackMarkers(t);
    }
});

function updateTrackMarkers(t) {
    if (!t.markerData || !t.ws || t.ws.getDuration() === 0) return;
    
    const durationSec = t.ws.getDuration();
    
    // 純粋関数を使ってパーセンテージを計算
    const { startPct, endPct } = calculateMarkerPercentages(t.markerData, durationSec);
    
    // 状態を保持
    t.startPct = startPct;
    t.endPct = endPct;
    
    // UIを更新
    const trackId = Object.keys(tracks).find(key => tracks[key] === t);
    updateOverlayUI(trackId);
}

// ==========================================
// デジタル時計の更新処理
// ==========================================
const digitalClock = document.getElementById('digital-clock');
const clockToggle = document.getElementById('clock-toggle');
const badgeToggle = document.getElementById('badge-toggle');

// グローバル設定変数
let autoScrollMode = 'center'; // 'center', 'page', 'off'

// デジタル時計の表示・非表示切り替え
if (clockToggle && digitalClock) {
    clockToggle.addEventListener('change', (e) => {
        digitalClock.style.display = e.target.checked ? 'block' : 'none';
    });
}

// バッジの表示・非表示切り替え
if (badgeToggle) {
    badgeToggle.addEventListener('change', (e) => {
        if (e.target.checked) {
            document.body.classList.remove('hide-badges');
        } else {
            document.body.classList.add('hide-badges');
        }
    });
}



/**
 * 全トラックのロード状況を集約し、グローバルシーンステータスバーを更新する
 */
function updateGlobalSceneStatus() {
    const playingEl = document.getElementById('global-playing-scene');
    const standbyContainer = document.getElementById('global-standby-scenes');
    if (!playingEl || !standbyContainer) return;

    let activePlayingSceneIndex = -1;
    let isAnyTrackPlaying = false;
    
    // key: slotIndex, value: { isReady: boolean, tracksCount: number }
    const loadedScenesMap = {};

    Object.values(tracks).forEach(track => {
        // 再生中シーンの検出
        if (track.currentSceneIndex >= 0 && isSongPlaying) {
            activePlayingSceneIndex = track.currentSceneIndex;
            isAnyTrackPlaying = true;
        }

        // ロードされている各レイヤーの調査
        Object.keys(track.layers).forEach(layerKey => {
            const layer = track.layers[layerKey];
            if (layer.url) {
                const slot = layer.slotIndex;
                if (!loadedScenesMap[slot]) {
                    loadedScenesMap[slot] = {
                        isReady: true,
                        tracksCount: 0
                    };
                }
                loadedScenesMap[slot].tracksCount++;
                if (!layer.isReady) {
                    loadedScenesMap[slot].isReady = false; // 1つでもロード中でないトラックがあれば false
                }
            }
        });
    });

    // 1. 再生中シーンバッジの描画
    if (isAnyTrackPlaying && activePlayingSceneIndex >= 0) {
        const name = globalSceneNames[activePlayingSceneIndex] || `Scene ${activePlayingSceneIndex + 1}`;
        playingEl.textContent = name;
        playingEl.className = 'scene-badge status-playing';
    } else {
        playingEl.textContent = '---';
        playingEl.className = 'scene-badge status-empty';
    }

    // 2. スタンバイ中シーン一覧の描画
    // ロード済みシーンのうち「意図された次候補」だけを表示する:
    // グローバル再生シーンの次 と、Live で選択中のシーン。
    // 過去の選択の残骸 (一部トラックのレイヤーに残った古いプリロード) は表示しない。
    // レイヤー自体は破棄しないので、残骸シーンを再発火した場合の瞬時スワップは従来通り効く。
    const standbyCandidates = new Set();
    if (activePlayingSceneIndex >= 0) standbyCandidates.add(activePlayingSceneIndex + 1);
    if (selectedSceneIndex >= 0) standbyCandidates.add(selectedSceneIndex);

    const standbySlots = Object.keys(loadedScenesMap)
        .map(Number)
        .filter(slot => slot !== activePlayingSceneIndex && standbyCandidates.has(slot))
        .sort((a, b) => a - b);

    standbyContainer.innerHTML = '';
    
    if (standbySlots.length === 0) {
        const emptyBadge = document.createElement('div');
        emptyBadge.className = 'scene-badge status-empty';
        emptyBadge.textContent = '---';
        standbyContainer.appendChild(emptyBadge);
    } else {
        standbySlots.forEach(slot => {
            const sceneInfo = loadedScenesMap[slot];
            const name = globalSceneNames[slot] || `Scene ${slot + 1}`;
            
            const badge = document.createElement('div');
            badge.className = `scene-badge ${sceneInfo.isReady ? 'status-ready' : 'status-loading'}`;
            
            if (sceneInfo.isReady) {
                badge.textContent = name;
            } else {
                badge.innerHTML = `${name} <span class="badge-spinner">↺</span>`;
            }
            standbyContainer.appendChild(badge);
        });
    }
}

function updateClock() {
    if (!digitalClock) return;
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const timeString = `${h}:${m}:${s}`;
    
    // パフォーマンスのため、時刻文字列が変化したときだけDOMを更新する
    if (digitalClock.textContent !== timeString) {
        digitalClock.textContent = timeString;
    }
}

// 200ms間隔で時刻をチェックして毎秒正確に更新する
setInterval(updateClock, 200);
updateClock(); // 初回実行
