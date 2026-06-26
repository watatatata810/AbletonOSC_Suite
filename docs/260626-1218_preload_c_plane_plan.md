# C面追加と選択シーンのプリロード（PRE LOAD）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ableton Live で現在選択中（ハイライト）のシーンにあるクリップを C面（3つ目の波形バッファ）に事前にロードし、再生開始時に遅延なく瞬時描画させるとともに、完了時に青色の「PRE LOAD」バッジを表示する。

**Architecture:** A, B, C の3つの波形レイヤーを動的なプールとして管理。サーバー側で選択シーン変更を 300ms デバウンス監視し、変更がなければパスを取得しクライアントへ送信。クライアントは非アクティブかつ空いているレイヤーにプリロードし、再生開始時に一致するレイヤーがあれば瞬時にスワップ（切り替え）する。

**Tech Stack:** JavaScript (Node.js, Express, Socket.io), node-osc, WaveSurfer.js V7, WebGL

## Global Constraints
* ユーザーグローバルルールを厳守する（日本語での応答、勝手なREADME変更禁止など）。
* 既存のコードスタイル・変数命名規則（キャメルケース等）に合わせ、副作用を最小限に抑える。
* 変更時はテスト環境（ブラウザ、Ableton LiveのOSCエミュレーション）での挙動を検証する。

---

### Task 1: UIとバッジスタイルの定義

**Files:**
* Modify: [style.css](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/viewWaves/public/style.css)

**Interfaces:**
* Produces: CSSクラス `.pre-load-badge`、`.badges-wrapper`、`.debug-display`

- [ ] **Step 1: style.css に PRE LOAD バッジ、バッジ並列化用、およびデバッグ表示用のスタイルを追加する**

```css
/* style.css の末尾に追加 */
.pre-load-badge {
    font-family: 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    font-size: 12px;
    font-weight: bold;
    color: #2196F3; /* Blue */
    background-color: rgba(33, 150, 243, 0.15);
    padding: 2px 8px;
    border-radius: 12px;
    border: 1px solid rgba(33, 150, 243, 0.3);
    opacity: 0;
    transform: translateY(10px) scale(0.9);
    transition: opacity 0.5s ease, transform 0.5s ease;
    pointer-events: none;
}

.pre-load-badge.visible {
    opacity: 1;
    transform: translateY(0) scale(1);
    transition: opacity 0.5s ease, transform 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

.badges-wrapper {
    display: flex;
    gap: 8px;
    align-items: center;
}

.debug-display {
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
    pointer-events: none;
    white-space: nowrap;
}
```

- [ ] **Step 2: 変更をコミットする**

```bash
git add packages/viewWaves/public/style.css
git commit -m "style: add pre-load-badge and badges-wrapper styles"
```

---

### Task 2: WebGL 描画レイヤー（webgl-waveform.js）のC面対応

**Files:**
* Modify: [webgl-waveform.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/viewWaves/public/webgl-waveform.js)

**Interfaces:**
* Consumes: `WebGLWaveform` クラスのインターフェース
* Produces: `layerKey = 'C'` に対するバッファ確保、クリア、描画のサポート

- [ ] **Step 1: WebGLWaveform クラスのメンバに C面 を追加し、clear/setActiveLayer/updateData 等を拡張する**

Modify: [webgl-waveform.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/viewWaves/public/webgl-waveform.js)
```javascript
// constructor (lines 12-14)
this.lods = { A: null, B: null, C: null };
this.lengths = { A: 0, B: 0, C: 0 };
this.sampleRates = { A: 44100, B: 44100, C: 44100 };

// setActiveLayer (lines 207-211)
setActiveLayer(layerKey) {
    if (layerKey !== 'A' && layerKey !== 'B' && layerKey !== 'C') return;
    this.activeLayerKey = layerKey;
    this.render();
}

// clear (lines 216-229)
clear() {
    const gl = this.gl;
    ['A', 'B', 'C'].forEach(layerKey => {
        if (this.lods[layerKey]) {
            this.lods[layerKey].forEach(lod => {
                if (lod.ampBuf) gl.deleteBuffer(lod.ampBuf);
                if (lod.idxBuf) gl.deleteBuffer(lod.idxBuf);
            });
        }
        this.lods[layerKey] = null;
        this.lengths[layerKey] = 0;
    });
    this.render();
}
```

- [ ] **Step 2: 変更をコミットする**

```bash
git add packages/viewWaves/public/webgl-waveform.js
git commit -m "feat: extend WebGLWaveform to support layer C"
```

---

### Task 3: 選択シーンのOSC取得とデバウンス（server.js）

**Files:**
* Modify: [server.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/viewWaves/server.js)

**Interfaces:**
* Produces: 
  * OSCメッセージ: `/live/view/start_listen/selected_scene`, `/live/view/get/selected_scene`
  * ソケット送信イベント: `selected_scene_changed`, `clip_selected_preload`, `clip_selected_preload_empty`

- [ ] **Step 1: server.js に選択中シーン状態保持変数とデバウンス用タイマー変数を追加する**

```javascript
// server.js のグローバル変数定義部に追加
let selectedSceneIndex = -1;
let selectedSceneTimer = null;
```

- [ ] **Step 2: トラック数検出時およびブラウザ接続時に、選択シーンのリスナー登録を行う**

```javascript
// トラック検出初期化部 (address === '/live/song/get/num_tracks') 内
oscClient.send('/live/view/start_listen/selected_scene');
oscClient.send('/live/view/get/selected_scene');

// connection イベントハンドラ内
if (selectedSceneIndex >= 0) {
    socket.emit('selected_scene_changed', { sceneIndex: selectedSceneIndex });
}
```

- [ ] **Step 3: OSC メッセージ受信部に /live/view/selected_scene ハンドラを追加し、デバウンス処理とロード要求を行う**

```javascript
// oscServer.on('message', ...) 内に追加
else if (address === '/live/view/get/selected_scene' || address === '/live/view/selected_scene') {
    const sceneIndex = args[0];
    handleSelectedSceneChanged(sceneIndex);
}
```

```javascript
// デバウンスおよびロードハンドラ関数を server.js の下部に追加
function handleSelectedSceneChanged(sceneIndex) {
    if (selectedSceneIndex === sceneIndex) return;
    
    selectedSceneIndex = sceneIndex;
    
    if (selectedSceneTimer) {
        clearTimeout(selectedSceneTimer);
    }
    
    // 即時バッジ消去のためにクライアントに選択変更を通知
    io.emit('selected_scene_changed', { sceneIndex });
    
    selectedSceneTimer = setTimeout(() => {
        console.log(`[Live] Debounce expired. Preloading scene ${sceneIndex}`);
        preloadSelectedScene(sceneIndex);
    }, 300);
}

function preloadSelectedScene(sceneIndex) {
    if (sceneIndex < 0) return;
    
    for (let trackId = 0; trackId < numTracks; trackId++) {
        const cachedPath = clipLengths[`${trackId}_${sceneIndex}_file_path`];
        
        if (cachedPath !== undefined) {
            if (cachedPath !== "NO_AUDIO") {
                io.emit('clip_selected_preload', {
                    trackId: trackId,
                    slotIndex: sceneIndex,
                    filePath: cachedPath
                });
            } else {
                io.emit('clip_selected_preload_empty', {
                    trackId: trackId,
                    slotIndex: sceneIndex
                });
            }
        } else {
            // キャッシュがなければAbletonへパスと長さを問い合わせ
            oscClient.send('/live/clip/get/file_path', trackId, sceneIndex);
            oscClient.send('/live/clip/get/length', trackId, sceneIndex);
        }
    }
}
```

- [ ] **Step 4: ファイルパス受信時（/live/clip/get/file_path）に選択シーンに一致していればプリロードイベントを送信する**

```javascript
// address === '/live/clip/get/file_path' のハンドラ内
if (selectedSceneIndex === slotIndex) {
    if (filePath !== "NO_AUDIO") {
        io.emit('clip_selected_preload', {
            trackId: trackId,
            slotIndex: slotIndex,
            filePath: filePath
        });
    } else {
        io.emit('clip_selected_preload_empty', {
            trackId: trackId,
            slotIndex: slotIndex
        });
    }
}
```

- [ ] **Step 5: 変更をコミットする**

```bash
git add packages/viewWaves/server.js
git commit -m "feat: implement selected scene OSC listener and 300ms debounce"
```

---

### Task 4: クライアント側（app.js）のC面追加と動的バッファリングの実装

**Files:**
* Modify: [app.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/viewWaves/public/app.js)

**Interfaces:**
* Consumes: ソケットイベント `selected_scene_changed`, `clip_selected_preload`, `clip_selected_preload_empty`
* Produces: 3面のロード、スワップ、バッジ状態の動的更新

- [ ] **Step 1: グローバル変数 `selectedSceneIndex` を追加する**

```javascript
// app.js のグローバル変数部に追加
let selectedSceneIndex = -1;
```

- [ ] **Step 2: getOrCreateTrackUI 内で C面の生成、layersオブジェクトの拡張、バッジ・デバッグ表示要素の追加を行う**

```javascript
// getOrCreateTrackUI 内のDOM生成
const wsLayerC = document.createElement('div');
wsLayerC.className = 'ws-layer inactive';
wsLayerC.id = `ws-layer-c-${trackId}`;

// waveContainer への append に追加
waveContainer.appendChild(wsLayerA);
waveContainer.appendChild(wsLayerB);
waveContainer.appendChild(wsLayerC);
waveContainer.appendChild(webglCanvas);
waveContainer.appendChild(overlayLeft);
waveContainer.appendChild(overlayRight);

// バッジ要素の生成
const badgesWrapper = document.createElement('div');
badgesWrapper.className = 'badges-wrapper';

const nextReadyBadge = document.createElement('div');
nextReadyBadge.className = 'next-ready-badge';
nextReadyBadge.textContent = 'NEXT READY';

const preLoadBadge = document.createElement('div');
preLoadBadge.className = 'pre-load-badge';
preLoadBadge.textContent = 'PRE LOAD';

badgesWrapper.appendChild(nextReadyBadge);
badgesWrapper.appendChild(preLoadBadge);

// デバッグ表示要素の生成
const debugDisplay = document.createElement('div');
debugDisplay.className = 'debug-display';
debugDisplay.textContent = 'A: - | B: - | C: -';

// footerRow への append
footerRow.appendChild(badgesWrapper);
footerRow.appendChild(debugDisplay);
footerRow.appendChild(timeDisplay);

// WaveSurfer の生成に wsC を追加
const wsC = WaveSurfer.create({ container: `#ws-layer-c-${trackId}`, ...wsOptions });

// スクロール時の追従処理追加
wsC.on('scroll', () => {
    updateOverlayUI(trackId);
    if (tracks[trackId].activeLayerKey === 'C') {
        const pxPerSec = currentZoom === 0 ? (wsC.renderer.scrollContainer.clientWidth / wsC.getDuration()) : currentZoom;
        webglWaveform.setView(pxPerSec, wsC.renderer.scrollContainer.scrollLeft);
    }
});

// zoom パッチの適用
patchReRenderForZoom(wsC);

// onReadyC の定義と ready 登録
const onReadyC = () => {
    tracks[trackId].layers.C.isReady = true;
    webglWaveform.resize();
    
    const decoded = wsC.getDecodedData();
    if (decoded) {
        webglWaveform.updateData(decoded.getChannelData(0), decoded.sampleRate, 'C');
    }
    
    if (currentZoom !== 0) {
        tracks[trackId].layers.C.ws.zoom(currentZoom);
    }
    
    if (tracks[trackId].activeLayerKey === 'C') {
        const scrollContainer = wsC.renderer.scrollContainer;
        const pxPerSec = currentZoom === 0 ? (scrollContainer.clientWidth / wsC.getDuration()) : currentZoom;
        webglWaveform.setView(pxPerSec, scrollContainer.scrollLeft);
    }
    
    updateTrackMarkers(tracks[trackId]);
    updatePreLoadBadgeUI(trackId);
    updateDebugDisplayUI(trackId);
    sortVisibleTracks();
};
wsC.on('ready', onReadyC);

// tracks[trackId] の layers 定義および各メンバの拡張
tracks[trackId] = {
    layers: {
        A: { ws: wsA, el: wsLayerA, url: null, slotIndex: -1, isReady: false },
        B: { ws: wsB, el: wsLayerB, url: null, slotIndex: -1, isReady: false },
        C: { ws: wsC, el: wsLayerC, url: null, slotIndex: -1, isReady: false }
    },
    webglWaveform: webglWaveform,
    activeLayerKey: 'A',
    get ws() { return this.layers[this.activeLayerKey].ws; },
    get loadedUrl() { return this.layers[this.activeLayerKey].url; },
    set loadedUrl(url) { this.layers[this.activeLayerKey].url = url; },
    
    infoEl: info,
    titleEl: title,
    boxEl: box,
    timeEl: timeDisplay,
    nextReadyBadge: nextReadyBadge,
    preLoadBadge: preLoadBadge,
    debugEl: debugDisplay,
    currentSceneIndex: -1,
    fileName: null,
    sceneName: null,
    trackName: `Track ${trackId + 1}`,
    ...
};
```

- [ ] **Step 3: バッジおよびデバッグ表示更新関数を実装・拡張する**

```javascript
function updateNextReadyUI(trackId) {
    const t = tracks[trackId];
    if (!t || !t.nextReadyBadge) return;
    
    const nextSlot = t.currentSceneIndex + 1;
    let isNextReady = false;
    
    Object.keys(t.layers).forEach(key => {
        if (key !== t.activeLayerKey) {
            const layer = t.layers[key];
            if (layer.slotIndex === nextSlot && layer.isReady) {
                isNextReady = true;
            }
        }
    });
    
    if (isNextReady) {
        t.nextReadyBadge.classList.add('visible');
    } else {
        t.nextReadyBadge.classList.remove('visible');
    }
}

function updatePreLoadBadgeUI(trackId) {
    const t = tracks[trackId];
    if (!t || !t.preLoadBadge) return;
    
    if (selectedSceneIndex < 0 || t.currentSceneIndex === selectedSceneIndex) {
        t.preLoadBadge.classList.remove('visible');
        return;
    }
    
    let isPreLoaded = false;
    
    Object.keys(t.layers).forEach(key => {
        if (key !== t.activeLayerKey) {
            const layer = t.layers[key];
            if (layer.slotIndex === selectedSceneIndex && layer.isReady) {
                isPreLoaded = true;
            }
        }
    });
    
    if (isPreLoaded) {
        t.preLoadBadge.classList.add('visible');
    } else {
        t.preLoadBadge.classList.remove('visible');
    }
}

function updateDebugDisplayUI(trackId) {
    const t = tracks[trackId];
    if (!t || !t.debugEl) return;
    
    const states = Object.keys(t.layers).map(key => {
        const layer = t.layers[key];
        const isActive = t.activeLayerKey === key ? '★' : '';
        let stateStr = '-';
        if (layer.url) {
            const sceneNum = layer.slotIndex + 1;
            const status = layer.isReady ? 'R' : 'L';
            stateStr = `S${sceneNum}(${status})`;
        }
        return `${isActive}${key}:${stateStr}`;
    });
    
    t.debugEl.textContent = states.join(' | ');
}
```

- [ ] **Step 4: ソケットイベントハンドラの実装・修正を行う**

```javascript
// selected_scene_changed
socket.on('selected_scene_changed', (data) => {
    selectedSceneIndex = data.sceneIndex;
    Object.keys(tracks).forEach(trackId => {
        updatePreLoadBadgeUI(trackId);
    });
});

// clip_playing (スワップ処理の3面への拡張)
socket.on('clip_playing', (data) => {
    const { trackId, slotIndex, filePath } = data;
    const t = getOrCreateTrackUI(trackId);
    
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
    t.fileName = filePath.split(/[\\/]/).pop();
    t.sceneName = null;
    updateTrackTitle(trackId);
    
    waveformsContainer.prepend(t.boxEl);
    
    setTimeout(() => {
        t.boxEl.classList.add('visible');
        sortVisibleTracks();
        updateEmptyState();
    }, 10);
    
    const url = `/audio?path=${encodeURIComponent(filePath)}`;
    
    if (t.layers[t.activeLayerKey].url === url) {
        t.layers[t.activeLayerKey].slotIndex = slotIndex;
        updateNextReadyUI(trackId);
        updatePreLoadBadgeUI(trackId);
        return;
    }
    
    let swapTargetKey = null;
    Object.keys(t.layers).forEach(key => {
        if (key !== t.activeLayerKey && t.layers[key].url === url) {
            swapTargetKey = key;
        }
    });
    
    if (swapTargetKey) {
        const activeLayer = t.layers[t.activeLayerKey];
        const targetLayer = t.layers[swapTargetKey];
        
        activeLayer.el.classList.remove('active');
        activeLayer.el.classList.add('inactive');
        
        targetLayer.el.classList.remove('inactive');
        targetLayer.el.classList.add('active');
        
        t.activeLayerKey = swapTargetKey;
        t.layers[swapTargetKey].slotIndex = slotIndex;
        
        if (t.ws && t.ws.getDecodedData()) {
            t.ws.zoom(currentZoom === 0 ? false : currentZoom);
            t.webglWaveform.setActiveLayer(swapTargetKey);
            
            const scrollContainer = t.ws.renderer.scrollContainer;
            const pxPerSec = currentZoom === 0 ? (scrollContainer.clientWidth / t.ws.getDuration()) : currentZoom;
            t.webglWaveform.setView(pxPerSec, scrollContainer.scrollLeft);
        }
        
        activeLayer.url = null;
        activeLayer.slotIndex = -1;
        activeLayer.isReady = false;
        activeLayer.ws.empty();
        
        updateNextReadyUI(trackId);
        updatePreLoadBadgeUI(trackId);
        
        console.log(`[Swap] Track ${trackId + 1} instantly switched to layer ${swapTargetKey} for Scene ${slotIndex + 1}`);
    } else {
        console.log(`[Load] Loading audio for Track ${trackId + 1} (Scene ${slotIndex + 1}): ${url}`);
        const activeLayer = t.layers[t.activeLayerKey];
        activeLayer.url = url;
        activeLayer.slotIndex = slotIndex;
        activeLayer.isReady = false;
        
        t.webglWaveform.setActiveLayer(t.activeLayerKey);
        
        updateNextReadyUI(trackId);
        updatePreLoadBadgeUI(trackId);
        
        activeLayer.ws.load(url).catch(err => {
            if (err.name !== 'AbortError') console.error('WaveSurfer load error:', err);
        });
    }
});

// clip_preload (NEXT READY の3面選択選定)
socket.on('clip_preload', (data) => {
    const { trackId, slotIndex, filePath } = data;
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
        updateNextReadyUI(trackId);
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
    
    updateNextReadyUI(trackId);
    updatePreLoadBadgeUI(trackId);
    
    layer.ws.load(url).catch(err => {
        if (err.name !== 'AbortError') console.error('Preload WaveSurfer load error:', err);
    });
});

// clip_selected_preload (PRE LOAD の3面選択選定)
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
        updatePreLoadBadgeUI(trackId);
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
    
    updatePreLoadBadgeUI(trackId);
    updateNextReadyUI(trackId);
    
    layer.ws.load(url).catch(err => {
        if (err.name !== 'AbortError') console.error('Selected preload WaveSurfer load error:', err);
    });
});

// clip_selected_preload_empty
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
    
    updatePreLoadBadgeUI(trackId);
});

// clip_stopped
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
        
        t.webglWaveform.clear();
        
        updateNextReadyUI(trackId);
        updatePreLoadBadgeUI(trackId);
        updateTrackTitle(trackId);
        
        cancelAnimationFrame(t.animationFrameId);
        t.animationFrameId = null;
        t.velocity = 0;
        t.lastPositionTime = 0;
        t.firstPositionTime = undefined;
        t.currentOffsetProgress = undefined;
        
        t.boxEl.classList.remove('visible');
        updateEmptyState();
    }
});
```

- [ ] **Step 5: 変更をコミットする**

```bash
git add packages/viewWaves/public/app.js
git commit -m "feat: add layer C to app.js, implement 3-plane dynamic buffering and badges"
```

---

## Verification Plan

### Automated Tests
* なし (本リポジトリは GUI および OSC 連携のため自動テスト環境が存在しない)

### Manual Verification
1. `packages/viewWaves` のサーバーを起動する (`node server.js` または該当のバッチ起動)。
2. Ableton Live を起動し、シーンを選択する。
3. 選択シーンを変更し、300ms 経過後にサーバーのログで `[Live] Debounce expired. Preloading scene X` が出力されることを確認。
4. クライアントブラウザで、`NEXT READY` バッジの右側に青色の `PRE LOAD` バッジが表示されることを確認。
5. 選択シーンを発火（再生開始）した際、波形が一瞬で描画され、遅延がないことを確認。
6. ロード中（プリロード中）に別のシーンを高速で切り替えて、バッジ表示のバグやクラッシュが発生しないことを確認。
