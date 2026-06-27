const socket = io();
// Text status was removed, we use body class instead
const waveformsContainer = document.getElementById('waveforms-container');

// ラグ補正（レイテンシ先読み）の設定値
let latencyOffsetMs = 0;
const latencySlider = document.getElementById('latency-slider');
const latencyValue = document.getElementById('latency-value');

function updateEmptyState() {
    const emptyMsg = document.getElementById('empty-state-message');
    if (!emptyMsg) return;
    
    const hasVisibleTrack = document.querySelector('.track-box.visible');
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
    });
}

// Track state
// key: trackId, value: { ws, containerEl }
const tracks = {};

function resetAllTracksUI() {
    // 既存のトラック要素をDOMから削除し、WaveSurferインスタンスを破棄する
    Object.keys(tracks).forEach(trackId => {
        const t = tracks[trackId];
        // ダブルバッファリングされている両レイヤーの WaveSurfer を破棄
        if (t.wavesurferA) {
            try { t.wavesurferA.destroy(); } catch (e) {}
        }
        if (t.wavesurferB) {
            try { t.wavesurferB.destroy(); } catch (e) {}
        }
        if (t.boxEl) {
            try { t.boxEl.remove(); } catch (e) {}
        }
        delete tracks[trackId];
    });
    
    // 他のUI関連グローバル変数をリセット
    isSongPlaying = false;
    selectedSceneIndex = -1;
    
    // empty-state-message (同期待ち/接続待ち) の表示状態を更新
    updateEmptyState();
    console.log('[UI] Ableton切断に伴い、すべてのトラック表示を初期化しました。');
}

let isSongPlaying = false;
let selectedSceneIndex = -1;

// ==========================================
// 純粋関数群 (Pure Functions)
// ==========================================

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
 * タイマー表示用の文字列を生成する
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
    const visibleTracks = Object.values(tracks).filter(t => t.boxEl.classList.contains('visible'));
    
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
        resetAllTracksUI(); // 画面をクリーンアップ
    }
});

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
        height: 128,
        interact: false, // Prevent user clicking to seek
        autoScroll: true,  // overflow-x: auto を維持するため true (手動スクロール可能にする)
        autoCenter: false  // 自前で制御するため標準機能はオフ
    };

    const wsA = WaveSurfer.create({ container: `#ws-layer-a-${trackId}`, ...wsOptions });
    const wsB = WaveSurfer.create({ container: `#ws-layer-b-${trackId}`, ...wsOptions });
    const wsC = WaveSurfer.create({ container: `#ws-layer-c-${trackId}`, ...wsOptions });

    const webglWaveform = new WebGLWaveform(webglCanvas, { color: [1.0, 0.596, 0.0, 1.0] });

    // スクロール時にもオーバーレイとWebGL位置を追従させる
    wsA.on('scroll', () => {
        updateOverlayUI(trackId);
        if (tracks[trackId].activeLayerKey === 'A') {
            const pxPerSec = tracks[trackId].currentZoom === 0 ? (wsA.renderer.scrollContainer.clientWidth / wsA.getDuration()) : tracks[trackId].currentZoom;
            webglWaveform.setView(pxPerSec, wsA.renderer.scrollContainer.scrollLeft);
        }
    });
    wsB.on('scroll', () => {
        updateOverlayUI(trackId);
        if (tracks[trackId].activeLayerKey === 'B') {
            const pxPerSec = tracks[trackId].currentZoom === 0 ? (wsB.renderer.scrollContainer.clientWidth / wsB.getDuration()) : tracks[trackId].currentZoom;
            webglWaveform.setView(pxPerSec, wsB.renderer.scrollContainer.scrollLeft);
        }
    });
    wsC.on('scroll', () => {
        updateOverlayUI(trackId);
        if (tracks[trackId].activeLayerKey === 'C') {
            const pxPerSec = tracks[trackId].currentZoom === 0 ? (wsC.renderer.scrollContainer.clientWidth / wsC.getDuration()) : tracks[trackId].currentZoom;
            webglWaveform.setView(pxPerSec, wsC.renderer.scrollContainer.scrollLeft);
        }
    });

    // WaveSurfer標準のジャンプスクロールを無効化（自前で滑らかに制御するため）
    wsA.renderer.scrollIntoView = () => {};
    wsB.renderer.scrollIntoView = () => {};
    
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

    const onReadyA = () => {
        tracks[trackId].layers.A.isReady = true;
        webglWaveform.resize();
        
        // Active/Inactiveに関わらず、デコード完了時に即座にWebGLバッファを構築（プリレンダリング）
        const decoded = wsA.getDecodedData();
        if (decoded) {
            webglWaveform.updateData(decoded.getChannelData(0), decoded.sampleRate, 'A');
        }
        
        if (tracks[trackId].currentZoom !== 0) {
            tracks[trackId].layers.A.ws.zoom(tracks[trackId].currentZoom);
        }
        
        // ロード完了時にアクティブなレイヤーであれば、初期ズームとスクロール位置を適用する
        if (tracks[trackId].activeLayerKey === 'A') {
            const scrollContainer = wsA.renderer.scrollContainer;
            const pxPerSec = tracks[trackId].currentZoom === 0 ? (scrollContainer.clientWidth / wsA.getDuration()) : tracks[trackId].currentZoom;
            webglWaveform.setView(pxPerSec, scrollContainer.scrollLeft);
        }
        
        updateTrackMarkers(tracks[trackId]);
        updateLayerBadgesUI(trackId);
        sortVisibleTracks();
    };
    const onReadyB = () => {
        tracks[trackId].layers.B.isReady = true;
        webglWaveform.resize();
        
        // 同様にB面もデコード完了時に即座に構築
        const decoded = wsB.getDecodedData();
        if (decoded) {
            webglWaveform.updateData(decoded.getChannelData(0), decoded.sampleRate, 'B');
        }
        
        if (tracks[trackId].currentZoom !== 0) {
            tracks[trackId].layers.B.ws.zoom(tracks[trackId].currentZoom);
        }
        
        // ロード完了時にアクティブなレイヤーであれば、初期ズームとスクロール位置を適用する
        if (tracks[trackId].activeLayerKey === 'B') {
            const scrollContainer = wsB.renderer.scrollContainer;
            const pxPerSec = tracks[trackId].currentZoom === 0 ? (scrollContainer.clientWidth / wsB.getDuration()) : tracks[trackId].currentZoom;
            webglWaveform.setView(pxPerSec, scrollContainer.scrollLeft);
        }
        
        updateTrackMarkers(tracks[trackId]);
        updateLayerBadgesUI(trackId);
        sortVisibleTracks();
    };
    
    wsA.on('ready', onReadyA);
    wsB.on('ready', onReadyB);

    const onReadyC = () => {
        tracks[trackId].layers.C.isReady = true;
        webglWaveform.resize();
        
        const decoded = wsC.getDecodedData();
        if (decoded) {
            webglWaveform.updateData(decoded.getChannelData(0), decoded.sampleRate, 'C');
        }
        
        if (tracks[trackId].currentZoom !== 0) {
            tracks[trackId].layers.C.ws.zoom(tracks[trackId].currentZoom);
        }
        
        if (tracks[trackId].activeLayerKey === 'C') {
            const scrollContainer = wsC.renderer.scrollContainer;
            const pxPerSec = tracks[trackId].currentZoom === 0 ? (scrollContainer.clientWidth / wsC.getDuration()) : tracks[trackId].currentZoom;
            webglWaveform.setView(pxPerSec, scrollContainer.scrollLeft);
        }
        
        updateTrackMarkers(tracks[trackId]);
        updateLayerBadgesUI(trackId);
        sortVisibleTracks();
    };
    
    wsC.on('ready', onReadyC);

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
            const scrollContainer = t.ws.renderer.scrollContainer;
            const pxPerSec = t.currentZoom === 0 ? (scrollContainer.clientWidth / t.ws.getDuration()) : t.currentZoom;
            t.webglWaveform.setView(pxPerSec, scrollContainer.scrollLeft);
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

socket.on('scene_name', (data) => {
    const { sceneIndex, name } = data;
    Object.keys(tracks).forEach(trackId => {
        const t = tracks[trackId];
        if (t.currentSceneIndex === sceneIndex) {
            t.sceneName = name;
            updateTrackTitle(parseInt(trackId));
        }
    });
});

socket.on('track_name', (data) => {
    const { trackId, name } = data;
    const t = getOrCreateTrackUI(trackId);
    t.trackName = name;
    updateTrackTitle(trackId);
});

socket.on('selected_scene_changed', (data) => {
    selectedSceneIndex = data.sceneIndex;
    Object.keys(tracks).forEach(trackId => {
        updateLayerBadgesUI(trackId);
    });
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
