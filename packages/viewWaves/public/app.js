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

let isSongPlaying = false;

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

function updateOverlayUI(trackId, startPct, endPct) {
    const overlayLeft = document.getElementById(`overlay-left-${trackId}`);
    const overlayRight = document.getElementById(`overlay-right-${trackId}`);
    if (overlayLeft && overlayRight) {
        overlayLeft.style.width = `${startPct * 100}%`;
        overlayRight.style.width = `${(1 - endPct) * 100}%`;
    }
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
function updateNextReadyUI(trackId) {
    const t = tracks[trackId];
    if (!t || !t.nextReadyBadge) return;
    
    const inactiveKey = t.activeLayerKey === 'A' ? 'B' : 'A';
    const isNextReady = t.layers[inactiveKey].isReady && t.layers[inactiveKey].url !== null;
    
    if (isNextReady) {
        t.nextReadyBadge.classList.add('visible');
    } else {
        t.nextReadyBadge.classList.remove('visible');
    }
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

// ----------------------------------------------------
// 波形のズーム機能 (Ctrl + ホイール / ピンチ操作)
// ----------------------------------------------------
let currentZoom = 0; // 0 = 画面幅にフィット
const MAX_ZOOM = 1000; // 最大のズーム倍率 (px/sec)

waveformsContainer.addEventListener('wheel', (e) => {
    // Ctrlキーが押されている場合（ピンチ操作もこれに該当するブラウザが多い）
    if (e.ctrlKey) {
        e.preventDefault(); // 画面全体の拡大縮小を防ぐ

        // 現在のウィンドウ幅と、表示されている最長トラックの時間を取得
        let maxDuration = 0;
        const containerWidth = waveformsContainer.clientWidth || window.innerWidth;
        Object.values(tracks).forEach(t => {
            const dur = (t.ws && t.ws.getDuration()) || 0;
            if (dur > maxDuration) maxDuration = dur;
        });
        
        // 「画面にピッタリ収まるときのピクセル/秒（px/sec）」を計算
        const fitZoom = maxDuration > 0 ? (containerWidth / maxDuration) : 10;

        // e.deltaY: 正の値はズームアウト（ピンチイン）、負の値はズームイン（ピンチアウト）
        const isZoomingIn = e.deltaY < 0;
        
        // ズーム前の倍率を保持
        const oldZoom = currentZoom;

        // 初回ズームイン時（現在フィット表示で、拡大方向に操作された場合）
        // 50などの固定値ではなく、現在のフィット倍率を基準に開始することでガクつきをなくす
        if (currentZoom === 0 && isZoomingIn) {
            currentZoom = fitZoom;
        }

        // ズーム中、またはフィット状態からのズームインの場合のみ処理
        if (currentZoom !== 0 || isZoomingIn) {
            // 現在の倍率に対する割合でズームさせる（指数関数的変化）ことで、滑らかさを保つ
            const zoomFactor = 1 + (e.deltaY * -0.005);
            currentZoom *= zoomFactor;

            // 制限：一番引いた状態（fitZoom）に近づいたらフィット（0）にスナップさせる
            if (currentZoom <= fitZoom * 1.05) {
                currentZoom = 0; 
            } else if (currentZoom > MAX_ZOOM) {
                currentZoom = MAX_ZOOM;
            }

            // マウスカーソルの位置を中心としたズームを計算
            const containerRect = waveformsContainer.getBoundingClientRect();
            // コンテナ内でのマウスX座標 (0 ～ containerWidth)
            const mouseX = Math.max(0, Math.min(e.clientX - containerRect.left, containerRect.width));

            // 全トラックのA面・B面にズーム設定と、再計算したスクロール位置を適用
            Object.values(tracks).forEach(t => {
                const wsA = t.layers.A.ws;
                const wsB = t.layers.B.ws;
                const activeWs = t.ws;

                if (activeWs && activeWs.getDuration() > 0) {
                    const duration = activeWs.getDuration();
                    const containerWidth = activeWs.getWrapper().clientWidth;
                    
                    // ズーム前の全体幅とスクロール位置から、マウスが指している波形の「割合(0.0~1.0)」を計算
                    const oldFullWidth = oldZoom === 0 ? containerWidth : (duration * oldZoom);
                    const oldScrollLeft = activeWs.getScroll();
                    const ratio = (oldScrollLeft + mouseX) / oldFullWidth;

                    // ズーム倍率を適用 (0またはfalseの場合はフィット表示)
                    // ※ WaveSurfer V7 は内部の `reRender` 処理において、「プレイヘッド（progressWrapper）が画面上で動かないように」
                    // 自動的に scrollLeft を補正するハードコーディングされたロジックを持っています。
                    if (wsA) wsA.zoom(currentZoom === 0 ? false : currentZoom);
                    if (wsB) wsB.zoom(currentZoom === 0 ? false : currentZoom);

                    // ズーム後の全体幅を用いて、同じ「割合」の箇所がマウス位置にくるような新しいスクロール位置を計算
                    const newFullWidth = currentZoom === 0 ? containerWidth : (duration * currentZoom);
                    const newScrollLeft = (ratio * newFullWidth) - mouseX;

                    // WaveSurferによるプレイヘッド中心の強制スクロール補正を上書きするため、
                    // DOMの更新が完了した直後に setScroll を適用する（念のため複数フレームにわたって適用）
                    const applyScroll = () => {
                        if (wsA) wsA.setScroll(newScrollLeft);
                        if (wsB) wsB.setScroll(newScrollLeft);
                    };

                    requestAnimationFrame(() => {
                        applyScroll();
                        setTimeout(applyScroll, 0);
                        setTimeout(applyScroll, 10);
                    });
                }
            });
        }
    } else {
        // Ctrlキーがない場合＝通常の横スクロール操作
        // ユーザーが自発的に波形を見ようとしているため、一時的に自動追従を停止する
        isUserScrolling = true;
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            isUserScrolling = false; // 3秒後に自動追従を再開
        }, 3000);
    }
}, { passive: false }); // preventDefault() を機能させるために passive: false を指定

socket.on('connect', () => {
    document.body.className = 'status-waiting';
});

socket.on('disconnect', () => {
    document.body.className = 'status-disconnected';
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
    
    // オーバーレイを追加
    const overlayLeft = document.createElement('div');
    overlayLeft.className = 'overlay-left';
    overlayLeft.id = `overlay-left-${trackId}`;
    
    const overlayRight = document.createElement('div');
    overlayRight.className = 'overlay-right';
    overlayRight.id = `overlay-right-${trackId}`;
    
    const footerRow = document.createElement('div');
    footerRow.className = 'footer-row';
    
    const nextReadyBadge = document.createElement('div');
    nextReadyBadge.className = 'next-ready-badge';
    nextReadyBadge.textContent = 'NEXT READY';
    
    const timeDisplay = document.createElement('div');
    timeDisplay.className = 'time-display';
    timeDisplay.id = `time-${trackId}`;
    timeDisplay.textContent = '00:00 / -00:00';
    
    footerRow.appendChild(nextReadyBadge);
    footerRow.appendChild(timeDisplay);
    
    waveContainer.appendChild(wsLayerA);
    waveContainer.appendChild(wsLayerB);
    waveContainer.appendChild(overlayLeft);
    waveContainer.appendChild(overlayRight);
    
    box.appendChild(header);
    box.appendChild(waveContainer);
    box.appendChild(footerRow);
    
    waveformsContainer.appendChild(box);

    const wsOptions = {
        waveColor: '#ff9800',
        progressColor: '#e68900',
        cursorColor: '#fff',
        cursorWidth: 2,
        height: 128,
        interact: false, // Prevent user clicking to seek
        autoScroll: true,  // overflow-x: auto を維持するため true (手動スクロール可能にする)
        autoCenter: false  // 自前で制御するため標準機能はオフ
    };

    const wsA = WaveSurfer.create({ container: `#ws-layer-a-${trackId}`, ...wsOptions });
    const wsB = WaveSurfer.create({ container: `#ws-layer-b-${trackId}`, ...wsOptions });

    // WaveSurfer標準のジャンプスクロールを無効化（自前で滑らかに制御するため）
    wsA.renderer.scrollIntoView = () => {};
    wsB.renderer.scrollIntoView = () => {};

    tracks[trackId] = {
        layers: {
            A: { ws: wsA, el: wsLayerA, url: null, isReady: false },
            B: { ws: wsB, el: wsLayerB, url: null, isReady: false }
        },
        activeLayerKey: 'A',
        // ゲッター/セッターを用いて既存コードからの後方互換性を保つ
        get ws() { return this.layers[this.activeLayerKey].ws; },
        get loadedUrl() { return this.layers[this.activeLayerKey].url; },
        set loadedUrl(url) { this.layers[this.activeLayerKey].url = url; },
        
        infoEl: info,
        titleEl: title,
        boxEl: box,
        timeEl: timeDisplay,
        nextReadyBadge: nextReadyBadge,
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

    const onReadyA = () => {
        tracks[trackId].layers.A.isReady = true;
        updateTrackMarkers(tracks[trackId]);
        updateNextReadyUI(trackId);
        sortVisibleTracks();
    };
    const onReadyB = () => {
        tracks[trackId].layers.B.isReady = true;
        updateTrackMarkers(tracks[trackId]);
        updateNextReadyUI(trackId);
        sortVisibleTracks();
    };
    
    wsA.on('ready', onReadyA);
    wsB.on('ready', onReadyB);

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
        return;
    }
    
    const inactiveKey = t.activeLayerKey === 'A' ? 'B' : 'A';
    
    // もし非アクティブなレイヤー（裏側）にプリロードされていれば、瞬時にスワップ（切り替え）する
    if (t.layers[inactiveKey].url === url) {
        const activeLayer = t.layers[t.activeLayerKey];
        const inactiveLayer = t.layers[inactiveKey];
        
        // クラスを切り替えてフェードアニメーションを発動
        activeLayer.el.classList.remove('active');
        activeLayer.el.classList.add('inactive');
        
        inactiveLayer.el.classList.remove('inactive');
        inactiveLayer.el.classList.add('active');
        
        t.activeLayerKey = inactiveKey;
        
        // スワップされた（元アクティブだった）レイヤーをリセットする
        activeLayer.url = null;
        activeLayer.isReady = false;
        activeLayer.ws.empty();
        
        updateNextReadyUI(trackId);
        
        console.log(`[Swap] Track ${trackId + 1} instantly switched to preloaded layer ${inactiveKey}`);
    } else {
        // プリロードされていなければ、従来通りアクティブなレイヤーにロードする
        console.log(`[Load] Loading audio for Track ${trackId + 1}: ${url}`);
        t.layers[t.activeLayerKey].url = url;
        t.layers[t.activeLayerKey].isReady = false;
        updateNextReadyUI(trackId);
        t.layers[t.activeLayerKey].ws.load(url).catch(err => {
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
        t.layers['A'].url = null;
        t.layers['B'].url = null;
        t.layers['A'].isReady = false;
        t.layers['B'].isReady = false;
        t.layers['A'].ws.empty();
        t.layers['B'].ws.empty();
        updateNextReadyUI(trackId);
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

// 次のシーンの音声ファイルを裏でダウンロード（キャッシュ）しておく処理
socket.on('clip_preload', (data) => {
    const { trackId, filePath } = data;
    const url = `/audio?path=${encodeURIComponent(filePath)}`;
    
    const t = getOrCreateTrackUI(trackId);
    
    // すでにアクティブなレイヤーで読み込まれていれば無視
    if (t.layers[t.activeLayerKey].url === url) return;
    
    const inactiveKey = t.activeLayerKey === 'A' ? 'B' : 'A';
    const inactiveLayer = t.layers[inactiveKey];
    
    // すでに非アクティブレイヤーで読み込まれていれば無視
    if (inactiveLayer.url === url) return;
    
    console.log(`[Preload] Decoding audio in background layer ${inactiveKey} for Track ${trackId + 1}: ${url}`);
    inactiveLayer.url = url;
    inactiveLayer.isReady = false;
    updateNextReadyUI(trackId);
    inactiveLayer.ws.load(url).catch(err => {
        if (err.name !== 'AbortError') console.error('Preload WaveSurfer load error:', err);
    });
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
    updateOverlayUI(trackId, startPct, endPct);
}

// ==========================================
// デジタル時計の更新処理
// ==========================================
const digitalClock = document.getElementById('digital-clock');
const clockToggle = document.getElementById('clock-toggle');

// グローバル設定変数
let autoScrollMode = 'center'; // 'center', 'page', 'off'

// デジタル時計の表示・非表示切り替え
if (clockToggle && digitalClock) {
    clockToggle.addEventListener('change', (e) => {
        digitalClock.style.display = e.target.checked ? 'block' : 'none';
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
